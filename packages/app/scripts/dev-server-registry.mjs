#!/usr/bin/env node

/**
 * Coordinates deterministic development-server ports across worktrees through
 * a lock-protected registry. Runtime liveness and reservation identities keep
 * concurrent launchers from duplicating servers or overwriting newer owners.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const DEFAULT_UI_PORT_BASE = 2100;
export const DEFAULT_UI_PORT_SPAN = 900;
export const DEFAULT_API_PORT_OFFSET = 10_000;
export const REGISTRY_VERSION = 1;
const STARTUP_RESERVATION_GRACE_MS = 120_000;
const CLOUD_PROFILE_FINGERPRINT_PREFIX = "cloud-v2:";
const CLOUD_POLICY_ENV_KEYS = Object.freeze([
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_USE_INFERENCE",
  "ELIZAOS_CLOUD_USE_TTS",
  "ELIZAOS_CLOUD_USE_STT",
  "ELIZAOS_CLOUD_USE_MEDIA",
  "ELIZAOS_CLOUD_USE_EMBEDDINGS",
  "ELIZAOS_CLOUD_USE_RPC",
  "ELIZA_CLOUD_PROVISIONED",
]);

function cloudProfileValue(value, field) {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string when supplied`);
  }
  return value;
}

function cloudCredentialIdentityDigest(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new TypeError("credentialIdentity must be an object");
  }
  const normalized = Object.fromEntries(
    Object.entries(identity)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => {
        if (
          typeof value !== "string" &&
          value !== undefined &&
          value !== null
        ) {
          throw new TypeError(
            `credentialIdentity.${key} must be a string when supplied`,
          );
        }
        const trimmed = typeof value === "string" ? value.trim() : "";
        return [key, trimmed || null];
      }),
  );
  return createHash("sha256")
    .update("eliza-dev-server-cloud-credentials-v1\0")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

function firstConfiguredCloudEnvValue(env, ...keys) {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Resolve credential-bearing aliases to the effective identity hashed below. */
export function resolveDevServerCloudCredentialIdentity(env) {
  return {
    apiKey: firstConfiguredCloudEnvValue(
      env,
      "ELIZAOS_CLOUD_API_KEY",
      "ELIZA_DEV_CLOUD_API_KEY",
      "ELIZA_CLOUD_API_KEY",
      "ELIZACLOUD_API_KEY",
    ),
    serviceKey: firstConfiguredCloudEnvValue(
      env,
      "ELIZAOS_CLOUD_SERVICE_KEY",
      "ELIZA_CLOUD_SERVICE_KEY",
    ),
    serviceToken: firstConfiguredCloudEnvValue(
      env,
      "ELIZA_CLOUD_SERVICE_TOKEN",
    ),
    sessionToken: firstConfiguredCloudEnvValue(
      env,
      "ELIZA_CLOUD_SESSION_TOKEN",
    ),
    cloudToken: firstConfiguredCloudEnvValue(
      env,
      "ELIZA_CLOUD_TOKEN",
      "ELIZACLOUD_TOKEN",
    ),
    authToken: firstConfiguredCloudEnvValue(env, "ELIZA_CLOUD_AUTH_TOKEN"),
    sandboxToken: firstConfiguredCloudEnvValue(
      env,
      "ELIZA_CLOUD_SANDBOX_TOKEN",
    ),
    embeddingApiKey: firstConfiguredCloudEnvValue(
      env,
      "ELIZAOS_CLOUD_EMBEDDING_API_KEY",
    ),
    agentId: firstConfiguredCloudEnvValue(
      env,
      "ELIZAOS_CLOUD_AGENT_ID",
      "ELIZA_CLOUD_AGENT_ID",
      "WAIFU_ELIZA_CLOUD_AGENT_ID",
    ),
  };
}

/** Resolve non-secret Cloud activation policy to one stable effective identity. */
export function resolveDevServerCloudPolicyIdentity(env) {
  return Object.fromEntries(
    CLOUD_POLICY_ENV_KEYS.map((key) => {
      const value = env[key];
      if (value !== undefined && typeof value !== "string") {
        throw new TypeError(`${key} must be a string when supplied`);
      }
      const normalized =
        typeof value === "string" ? value.trim().toLowerCase() : "";
      return [key, normalized || null];
    }),
  );
}

/**
 * Build the non-secret identity of the Cloud environment baked into Vite.
 *
 * Public routing, launcher authority, and the opaque identity of effective
 * credentials participate. The registry stores only the final digest, never
 * source values or credentials, so it is safe to keep under ~/.eliza while
 * preventing cross-target, default/explicit, and cross-account reuse.
 */
export function createDevServerCloudProfileFingerprint({
  effectiveTarget,
  authorityMode,
  credentialIdentity,
  policyIdentity,
  serverApiBase,
  rendererCloudBase,
  stewardApiUrl,
  stewardTenantId,
  runtimeMode,
}) {
  if (typeof effectiveTarget !== "string" || !effectiveTarget) {
    throw new TypeError("effectiveTarget must be a non-empty string");
  }
  if (typeof authorityMode !== "string" || !authorityMode) {
    throw new TypeError("authorityMode must be a non-empty string");
  }
  if (
    !policyIdentity ||
    typeof policyIdentity !== "object" ||
    Array.isArray(policyIdentity)
  ) {
    throw new TypeError("policyIdentity must be an object");
  }
  const profile = {
    version: 2,
    effectiveTarget,
    authorityMode,
    credentialIdentityDigest: cloudCredentialIdentityDigest(credentialIdentity),
    policyIdentity,
    serverApiBase: cloudProfileValue(serverApiBase, "serverApiBase"),
    rendererCloudBase: cloudProfileValue(
      rendererCloudBase,
      "rendererCloudBase",
    ),
    stewardApiUrl: cloudProfileValue(stewardApiUrl, "stewardApiUrl"),
    stewardTenantId: cloudProfileValue(stewardTenantId, "stewardTenantId"),
    runtimeMode: cloudProfileValue(runtimeMode, "runtimeMode"),
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(profile))
    .digest("hex");
  return `${CLOUD_PROFILE_FINGERPRINT_PREFIX}${digest}`;
}

function normalizeCloudProfileFingerprint(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^cloud-v2:[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(
      "cloudProfileFingerprint must be a createDevServerCloudProfileFingerprint() value",
    );
  }
  return value;
}

function assertReusableCloudProfile(existing, requestedFingerprint, worktree) {
  const existingFingerprint = existing.cloudProfileFingerprint;
  if (existingFingerprint === requestedFingerprint) return;

  const existingLabel =
    typeof existingFingerprint === "string" &&
    /^cloud-v2:[0-9a-f]{64}$/.test(existingFingerprint)
      ? existingFingerprint
      : "missing or invalid";
  const requestedLabel = requestedFingerprint ?? "missing";
  const pidHint = Number.isInteger(existing.pid)
    ? ` (PID ${existing.pid})`
    : "";
  throw new Error(
    `A shared dev server is already running for ${worktree}${pidHint} with a different or missing Cloud profile (existing=${existingLabel}, requested=${requestedLabel}). Stop it with Ctrl-C in its terminal, then restart with \`bun run --cwd packages/app dev:shared\`. The running server was left untouched.`,
  );
}

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

function canReuseEntry(entry, runtime, now = Date.now()) {
  if (!runtime.pidAlive) return false;
  if (runtime.portOpen) return true;
  if (typeof entry.reservationId !== "string" || !entry.reservationId) {
    return false;
  }
  const startedAt = Date.parse(entry.startedAt);
  if (!Number.isFinite(startedAt)) return false;
  const reservationAge = now - startedAt;
  return reservationAge >= 0 && reservationAge <= STARTUP_RESERVATION_GRACE_MS;
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
  {
    registryPath = defaultRegistryPath(),
    base,
    span,
    cloudProfileFingerprint,
  } = {},
) {
  const worktree = normalizeWorktreePath(worktreePath);
  const requestedCloudProfile = normalizeCloudProfileFingerprint(
    cloudProfileFingerprint,
  );
  return await withRegistryLock(
    async () => {
      const current = readRegistry(registryPath);
      for (const existing of current.entries ?? []) {
        if (existing.worktree !== worktree || existing.stoppedAt) continue;
        const runtime = await getEntryRuntime(existing);
        // A fresh launcher owns the reservation before Vite opens its port.
        // After that bounded window, require both the owner PID and listener so
        // one recycled PID or unrelated process on the port cannot mask Vite.
        if (canReuseEntry(existing, runtime)) {
          assertReusableCloudProfile(existing, requestedCloudProfile, worktree);
          return { entry: existing, reused: true };
        }
      }

      const blockedUiPorts = new Set();
      while (true) {
        const allocated = allocatePortsForWorktree(worktree, {
          registry: current,
          base,
          span,
          blockedUiPorts,
        });
        if (!(await isPortOpen(allocated.entry.uiPort))) {
          const startedAt = new Date().toISOString();
          allocated.entry.pid = process.pid;
          allocated.entry.reservationId = randomUUID();
          allocated.entry.startedAt = startedAt;
          allocated.entry.updatedAt = startedAt;
          if (requestedCloudProfile !== undefined) {
            allocated.entry.cloudProfileFingerprint = requestedCloudProfile;
          }
          writeRegistry(allocated.registry, registryPath);
          return { entry: allocated.entry, reused: false };
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
  { registryPath = defaultRegistryPath(), expectedReservationId } = {},
) {
  const worktree = normalizeWorktreePath(worktreePath);
  return await withRegistryLock(
    async () => {
      const registry = readRegistry(registryPath);
      const entries = registry.entries ?? [];
      const index = entries.findIndex((entry) => entry.worktree === worktree);
      if (index === -1) return null;
      if (
        expectedReservationId !== undefined &&
        entries[index].reservationId !== expectedReservationId
      ) {
        return null;
      }
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
