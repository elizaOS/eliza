#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const DEFAULT_UI_PORT_BASE = 2100;
export const DEFAULT_UI_PORT_SPAN = 900;
export const DEFAULT_API_PORT_OFFSET = 10_000;
export const REGISTRY_VERSION = 1;

export function defaultRegistryPath(env = process.env) {
  return (
    env.ELIZA_DEV_SERVER_REGISTRY ??
    path.join(os.homedir(), ".eliza", "dev-server-registry.json")
  );
}

export function normalizeWorktreePath(worktreePath) {
  return path.resolve(worktreePath).replace(/\\/g, "/");
}

export function hashString(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function preferredUiPortForWorktree(
  worktreePath,
  { base = DEFAULT_UI_PORT_BASE, span = DEFAULT_UI_PORT_SPAN } = {},
) {
  return base + (hashString(normalizeWorktreePath(worktreePath)) % span);
}

export function portsForUiPort(uiPort) {
  return {
    uiPort,
    apiPort: uiPort + DEFAULT_API_PORT_OFFSET,
  };
}

export function createEmptyRegistry() {
  return { version: REGISTRY_VERSION, entries: [] };
}

export function readRegistry(registryPath = defaultRegistryPath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.entries)
    ) {
      return createEmptyRegistry();
    }
    return {
      version: REGISTRY_VERSION,
      entries: parsed.entries.filter(
        (entry) => entry && typeof entry === "object",
      ),
    };
  } catch (error) {
    if (error && error.code === "ENOENT") return createEmptyRegistry();
    throw error;
  }
}

export function writeRegistry(registry, registryPath = defaultRegistryPath()) {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const tmp = `${registryPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
  fs.renameSync(tmp, registryPath);
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

export async function isPortOpen(port, host = "127.0.0.1", timeoutMs = 250) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export async function getEntryRuntime(entry) {
  const pidAlive = isPidAlive(entry.pid);
  const portOpen = Number.isInteger(entry.uiPort)
    ? await isPortOpen(entry.uiPort)
    : false;
  return {
    pidAlive,
    portOpen,
    running: pidAlive || portOpen,
  };
}

export async function listRegistryEntries({
  registryPath = defaultRegistryPath(),
  includeStopped = false,
} = {}) {
  const registry = readRegistry(registryPath);
  const rows = [];
  for (const entry of registry.entries) {
    const runtime = await getEntryRuntime(entry);
    if (!includeStopped && !runtime.running) continue;
    rows.push({ ...entry, ...runtime });
  }
  rows.sort((a, b) => (a.uiPort ?? 0) - (b.uiPort ?? 0));
  return rows;
}

function pruneDeadEntries(entries, currentWorktree) {
  return entries.filter((entry) => {
    if (entry.worktree === currentWorktree) return false;
    if (entry.stoppedAt) return false;
    if (entry.pid === null || entry.pid === undefined) return true;
    return isPidAlive(entry.pid);
  });
}

export function allocatePortsForWorktree(
  worktreePath,
  {
    registry = createEmptyRegistry(),
    base = DEFAULT_UI_PORT_BASE,
    span = DEFAULT_UI_PORT_SPAN,
    now = new Date().toISOString(),
    blockedUiPorts = [],
  } = {},
) {
  const worktree = normalizeWorktreePath(worktreePath);
  const preferredUiPort = preferredUiPortForWorktree(worktree, { base, span });
  const entries = pruneDeadEntries(registry.entries ?? [], worktree);
  const usedUiPorts = new Set([
    ...entries.map((entry) => entry.uiPort),
    ...blockedUiPorts,
  ]);

  let uiPort = preferredUiPort;
  let probeCount = 0;
  while (usedUiPorts.has(uiPort) && probeCount < span) {
    probeCount += 1;
    uiPort = base + ((preferredUiPort - base + probeCount) % span);
  }
  if (probeCount >= span) {
    throw new Error(
      `No free deterministic UI ports in ${base}-${base + span - 1}`,
    );
  }

  const ports = portsForUiPort(uiPort);
  const entry = {
    worktree,
    packageDir: path.join(worktree, "packages", "app"),
    uiPort: ports.uiPort,
    apiPort: ports.apiPort,
    preferredUiPort,
    pid: null,
    startedAt: null,
    updatedAt: now,
    lastRebuildAt: null,
  };

  return {
    entry,
    registry: { version: REGISTRY_VERSION, entries: [...entries, entry] },
  };
}

export async function withRegistryLock(
  callback,
  { registryPath = defaultRegistryPath(), staleMs = 30_000 } = {},
) {
  const lockPath = `${registryPath}.lock`;
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const start = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, "pid"), String(process.pid));
      break;
    } catch (error) {
      if (error && error.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const stat = fs.statSync(lockPath);
        stale = Date.now() - stat.mtimeMs > staleMs;
      } catch {
        stale = true;
      }
      if (stale) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - start > staleMs) {
        throw new Error(`Timed out waiting for registry lock ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  try {
    return await callback();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

export async function reservePortsForWorktree(
  worktreePath,
  { registryPath = defaultRegistryPath(), base, span } = {},
) {
  return await withRegistryLock(
    async () => {
      const current = readRegistry(registryPath);
      const blockedUiPorts = new Set();
      while (true) {
        const allocated = allocatePortsForWorktree(worktreePath, {
          registry: current,
          base,
          span,
          blockedUiPorts,
        });
        if (!(await isPortOpen(allocated.entry.uiPort))) {
          writeRegistry(allocated.registry, registryPath);
          return allocated.entry;
        }
        blockedUiPorts.add(allocated.entry.uiPort);
      }
    },
    { registryPath },
  );
}

export async function updateRegistryEntry(
  worktreePath,
  patch,
  { registryPath = defaultRegistryPath() } = {},
) {
  const worktree = normalizeWorktreePath(worktreePath);
  return await withRegistryLock(
    async () => {
      const registry = readRegistry(registryPath);
      const entries = registry.entries ?? [];
      const index = entries.findIndex((entry) => entry.worktree === worktree);
      if (index === -1) return null;
      const updated = {
        ...entries[index],
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      entries[index] = updated;
      writeRegistry({ version: REGISTRY_VERSION, entries }, registryPath);
      return updated;
    },
    { registryPath },
  );
}
