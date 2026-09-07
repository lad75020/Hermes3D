"use strict";

const fs = require("fs");
const path = require("path");

const STATE_VERSION = 1;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseEntries(value, label, validateValue) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const entries = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
      throw new Error(`${label} contains an invalid entry`);
    }
    validateValue(entry[0], entry[1]);
    entries.push(entry);
  }
  return new Map(entries);
}

function parseState(data) {
  if (!isRecord(data) || data.version !== STATE_VERSION) {
    throw new Error(`unsupported adapter state version: ${data?.version ?? "missing"}`);
  }

  const agentRegistry = parseEntries(data.agentRegistry, "agentRegistry", (key, agent) => {
    if (
      !isRecord(agent)
      || agent.id !== key
      || typeof agent.name !== "string"
      || typeof agent.workspace !== "string"
      || !isRecord(agent.settings)
    ) {
      throw new Error(`agentRegistry contains an invalid agent: ${key}`);
    }
  });
  const agentFiles = parseEntries(data.agentFiles, "agentFiles", (_key, content) => {
    if (typeof content !== "string") throw new Error("agentFiles contains non-string content");
  });
  const sessionSettings = parseEntries(data.sessionSettings, "sessionSettings", (_key, settings) => {
    if (!isRecord(settings)) throw new Error("sessionSettings contains invalid settings");
  });
  const cronJobs = parseEntries(data.cronJobs, "cronJobs", (key, job) => {
    if (!isRecord(job) || job.id !== key) {
      throw new Error(`cronJobs contains an invalid job: ${key}`);
    }
  });

  return { agentRegistry, agentFiles, sessionSettings, cronJobs };
}

function replaceMap(target, source) {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function loadAdapterState({
  stateFile,
  agentRegistry,
  agentFiles,
  sessionSettings,
  cronJobs,
  protectedAgentId,
}) {
  if (!fs.existsSync(stateFile)) return { loaded: false };

  const parsed = parseState(JSON.parse(fs.readFileSync(stateFile, "utf8")));
  const protectedAgent = agentRegistry.get(protectedAgentId);
  parsed.agentRegistry.delete(protectedAgentId);
  const restoredAgents = new Map();
  if (protectedAgent) restoredAgents.set(protectedAgentId, protectedAgent);
  for (const entry of parsed.agentRegistry) restoredAgents.set(...entry);

  replaceMap(agentRegistry, restoredAgents);
  replaceMap(agentFiles, parsed.agentFiles);
  replaceMap(sessionSettings, parsed.sessionSettings);
  replaceMap(cronJobs, parsed.cronJobs);

  return {
    loaded: true,
    agents: agentRegistry.size,
    files: agentFiles.size,
    sessions: sessionSettings.size,
    cronJobs: cronJobs.size,
  };
}

function atomicWriteJson(filePath, data) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const descriptor = fs.openSync(temporaryPath, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function saveAdapterState({
  stateFile,
  agentRegistry,
  agentFiles,
  sessionSettings,
  cronJobs,
  protectedAgentId,
}) {
  atomicWriteJson(stateFile, {
    version: STATE_VERSION,
    agentRegistry: [...agentRegistry].filter(([agentId]) => agentId !== protectedAgentId),
    agentFiles: [...agentFiles],
    sessionSettings: [...sessionSettings],
    cronJobs: [...cronJobs],
  });
}

module.exports = {
  loadAdapterState,
  saveAdapterState,
};
