// @vitest-environment node

import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

const ADAPTER_PATH = path.resolve("server/hermes-gateway-adapter.js");
const STATE_FILE_NAME = "hermes3d-adapter-state.json";
const children = new Set<ChildProcess>();
const tempHomes = new Set<string>();

const reservePort = async () => {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
};

const startAdapter = async (home: string, port: number) => {
  const child = spawn(process.execPath, [ADAPTER_PATH], {
    cwd: path.dirname(path.dirname(ADAPTER_PATH)),
    env: {
      ...process.env,
      HOME: home,
      HERMES_ADAPTER_PORT: String(port),
      HERMES_API_URL: "http://127.0.0.1:1",
      HERMES_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);

  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Adapter did not start. Output:\n${output}`));
    }, 5_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!output.includes(`Listening on ws://localhost:${port}`)) return;
      clearTimeout(timeout);
      resolve();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Adapter exited before listening (${code ?? signal}). Output:\n${output}`));
    });
  });

  return child;
};

const stopAdapter = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    children.delete(child);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Adapter did not stop after SIGTERM"));
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    if (!child.kill("SIGTERM")) {
      clearTimeout(timeout);
      reject(new Error("Could not signal adapter process"));
    }
  });
  children.delete(child);
};

const connectClient = async (port: number) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  let nextId = 1;
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  socket.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame?.type !== "res" || typeof frame.id !== "string") return;
    const request = pending.get(frame.id);
    if (!request) return;
    pending.delete(frame.id);
    if (frame.ok) request.resolve(frame.payload);
    else request.reject(new Error(frame.error?.message || frame.error?.code || "Gateway error"));
  });

  await once(socket, "open");

  const call = <T>(method: string, params: Record<string, unknown> = {}) => {
    const id = `test-${nextId++}`;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      socket.send(JSON.stringify({ type: "req", id, method, params }));
    });
  };

  await call("connect");
  return { socket, call };
};

const closeClient = async (socket: WebSocket) => {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, "close");
  socket.close();
  await closed;
};

afterEach(async () => {
  await Promise.all([...children].map((child) => stopAdapter(child)));
  for (const home of tempHomes) fs.rmSync(home, { recursive: true, force: true });
  tempHomes.clear();
});

describe("Hermes gateway adapter persistence", () => {
  it("restores durable adapter state after a process restart without serializing active runs", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes3d-adapter-state-"));
    tempHomes.add(home);
    const port = await reservePort();
    const firstProcess = await startAdapter(home, port);
    const firstClient = await connectClient(port);
    const created = await firstClient.call<{ agentId: string }>("agents.create", {
      name: "Durable Agent",
      workspace: "/tmp/durable-agent-workspace",
    });
    const persistedSessionKey = `agent:${created.agentId}:main`;
    await firstClient.call("agents.update", {
      agentId: created.agentId,
      role: "Persistence Specialist",
    });
    await firstClient.call("agents.files.set", {
      agentId: created.agentId,
      name: "AGENTS.md",
      content: "Persist this agent file.",
    });
    await firstClient.call("sessions.patch", {
      key: persistedSessionKey,
      model: "local/durable-model",
      thinkingLevel: "high",
      execHost: "local",
      execSecurity: "full",
      execAsk: "off",
    });
    const createdJob = await firstClient.call<{ id: string }>("cron.add", {
      name: "Durable Cron",
      agentId: created.agentId,
      sessionKey: persistedSessionKey,
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "systemEvent", text: "persisted tick" },
    });
    await closeClient(firstClient.socket);
    await stopAdapter(firstProcess);

    const statePath = path.join(home, ".hermes", STATE_FILE_NAME);
    const persistedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(persistedState).toMatchObject({ version: 1 });
    expect(persistedState).not.toHaveProperty("activeRuns");

    const secondProcess = await startAdapter(home, port);
    const secondClient = await connectClient(port);

    const roster = await secondClient.call<{
      agents: Array<{ id: string; name: string; role: string; workspace: string }>;
    }>("agents.list");
    expect(roster.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.agentId,
          name: "Durable Agent",
          role: "Persistence Specialist",
          workspace: "/tmp/durable-agent-workspace",
        }),
      ]),
    );

    await expect(
      secondClient.call("agents.files.get", {
        agentId: created.agentId,
        name: "AGENTS.md",
      }),
    ).resolves.toEqual({ file: { content: "Persist this agent file." } });

    await expect(
      secondClient.call("sessions.patch", { key: persistedSessionKey }),
    ).resolves.toMatchObject({
      entry: { thinkingLevel: "high" },
      resolved: { model: "durable-model" },
    });

    const jobs = await secondClient.call<{ jobs: Array<Record<string, unknown>> }>("cron.list");
    expect(jobs.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: createdJob.id,
          name: "Durable Cron",
          agentId: created.agentId,
          sessionKey: persistedSessionKey,
          payload: { kind: "systemEvent", text: "persisted tick" },
        }),
      ]),
    );

    await closeClient(secondClient.socket);
    await stopAdapter(secondProcess);
  }, 20_000);
});
