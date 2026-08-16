/**
 * Per-model-type user override: "for TEXT_LARGE, prefer this provider".
 *
 * Persisted to `$STATE_DIR/local-inference/routing.json` and read by the
 * router-handler (see `router-handler.ts`) to pick a provider at dispatch
 * time. When a slot has no override, the runtime's native priority order
 * wins — i.e. this is layered over the existing registration priority
 * rather than replacing it.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { localInferenceRoot } from "./paths.js";
import {
  isRoutingPolicy,
  type RoutingPolicy,
  type RoutingPreferences,
} from "./routing-policy.js";
import {
  AGENT_MODEL_SLOTS,
  type AgentModelSlot,
  TEXT_GENERATION_SLOTS,
} from "./types.js";

export {
  DEFAULT_ROUTING_POLICY,
  isRoutingPolicy,
  ROUTING_POLICIES,
  type RoutingPolicy,
  type RoutingPreferences,
} from "./routing-policy.js";

interface RoutingFile {
  version: 1;
  preferences: RoutingPreferences;
}

const LOCK_RETRY_MS = 20;
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

function emptyPreferences(): RoutingPreferences {
  return { preferredProvider: {}, policy: {} };
}

function routingPath(): string {
  return path.join(localInferenceRoot(), "routing.json");
}

async function ensureRoot(): Promise<void> {
  await fs.mkdir(localInferenceRoot(), { recursive: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : undefined;
}

function parseRoutingRecord<T extends string>(
  value: unknown,
  field: string,
  validateValue: (entry: unknown) => entry is T,
): Partial<Record<AgentModelSlot, T>> {
  if (!isRecord(value)) {
    throw new Error(`Invalid routing preferences: ${field} must be an object`);
  }
  const parsed: Partial<Record<AgentModelSlot, T>> = {};
  for (const [slot, entry] of Object.entries(value)) {
    if (!AGENT_MODEL_SLOTS.includes(slot as AgentModelSlot)) {
      throw new Error(
        `Invalid routing preferences: unknown model slot ${slot}`,
      );
    }
    if (!validateValue(entry)) {
      throw new Error(
        `Invalid routing preferences: ${field}.${slot} has an invalid value`,
      );
    }
    parsed[slot as AgentModelSlot] = entry;
  }
  return parsed;
}

function parseRoutingFile(raw: string): RoutingPreferences {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    // error-policy:J3 corrupt persisted JSON is an explicit invalid state.
    throw new Error("Invalid routing preferences: routing.json is not JSON", {
      cause,
    });
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    !isRecord(parsed.preferences)
  ) {
    throw new Error("Invalid routing preferences: unsupported file shape");
  }
  return {
    preferredProvider: parseRoutingRecord(
      parsed.preferences.preferredProvider,
      "preferredProvider",
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    ),
    policy: parseRoutingRecord(
      parsed.preferences.policy,
      "policy",
      isRoutingPolicy,
    ),
  };
}

function validateRoutingPreferences(
  prefs: RoutingPreferences,
): RoutingPreferences {
  return parseRoutingFile(JSON.stringify({ version: 1, preferences: prefs }));
}

async function readRoutingPreferencesStrict(): Promise<RoutingPreferences> {
  try {
    return parseRoutingFile(await fs.readFile(routingPath(), "utf8"));
  } catch (error) {
    // error-policy:J3 a missing file is the one valid empty state; corrupt or
    // unreadable persisted routing must fail closed instead of being replaced.
    if (errorCode(error) === "ENOENT") return emptyPreferences();
    throw error;
  }
}

async function writeRoutingPreferencesAtomic(
  prefs: RoutingPreferences,
): Promise<void> {
  const target = routingPath();
  const payload: RoutingFile = {
    version: 1,
    preferences: validateRoutingPreferences(prefs),
  };
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tmp, target);
  } catch (error) {
    // error-policy:J6 temp cleanup is best-effort; the primary write failure is
    // preserved and unique temp names make an orphan harmless to later writes.
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

interface LockOwner {
  id: string;
  pid: number;
  hostname: string;
  createdAt: number;
}

function parseLockOwner(raw: string): LockOwner | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.createdAt !== "number"
    ) {
      return null;
    }
    return parsed as LockOwner;
  } catch {
    // error-policy:J3 a malformed owner token is invalid lock metadata; stale
    // recovery handles it only after the full age threshold.
    return null;
  }
}

function lockOwnerIsAlive(owner: LockOwner): boolean {
  if (owner.hostname !== hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    // error-policy:J3 ESRCH is the only trusted proof that a local owner died.
    return errorCode(error) !== "ESRCH";
  }
}

async function removeLockIfTokenMatches(
  lockPath: string,
  token: string,
): Promise<void> {
  try {
    if ((await fs.readFile(lockPath, "utf8")) === token) {
      await fs.rm(lockPath, { force: true });
    }
  } catch (error) {
    // error-policy:J6 lock teardown is best-effort; ENOENT means another stale
    // recovery already removed it, while any leak is bounded by stale recovery.
    if (errorCode(error) !== "ENOENT") return;
  }
}

async function tryRecoverStaleLock(lockPath: string): Promise<boolean> {
  try {
    const [token, stat] = await Promise.all([
      fs.readFile(lockPath, "utf8"),
      fs.stat(lockPath),
    ]);
    if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) return false;
    const owner = parseLockOwner(token);
    // An empty/malformed token is the crash window between O_EXCL creation and
    // owner publication. Age plus token-matched removal makes it reclaimable
    // without deleting a newer contender's lock.
    if (owner && lockOwnerIsAlive(owner)) return false;
    await removeLockIfTokenMatches(lockPath, token);
    return true;
  } catch (error) {
    // error-policy:J3 the lock disappearing between contention checks is a
    // successful retry signal; other filesystem failures are real failures.
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
}

async function withRoutingLock<T>(operation: () => Promise<T>): Promise<T> {
  await ensureRoot();
  const lockPath = `${routingPath()}.lock`;
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let token = "";
  while (!handle) {
    let pending: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      pending = await fs.open(lockPath, "wx", 0o600);
      token = JSON.stringify({
        id: randomUUID(),
        pid: process.pid,
        hostname: hostname(),
        createdAt: Date.now(),
      } satisfies LockOwner);
      await pending.writeFile(token, "utf8");
      handle = pending;
    } catch (error) {
      if (pending) {
        // error-policy:J6 a partially-created lock belongs to this failed
        // acquisition and is removed without masking its primary error.
        await pending.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
      }
      if (errorCode(error) !== "EEXIST") throw error;
      if (await tryRecoverStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${LOCK_ACQUIRE_TIMEOUT_MS}ms waiting for routing lock`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  try {
    return await operation();
  } finally {
    try {
      await handle.close();
    } finally {
      await removeLockIfTokenMatches(lockPath, token);
    }
  }
}

/** Serialize one strict read-modify-write transaction across local processes. */
export async function updateRoutingPreferences(
  update: (current: RoutingPreferences) => RoutingPreferences,
): Promise<RoutingPreferences> {
  return withRoutingLock(async () => {
    const next = validateRoutingPreferences(
      update(await readRoutingPreferencesStrict()),
    );
    await writeRoutingPreferencesAtomic(next);
    return next;
  });
}

export async function readRoutingPreferences(): Promise<RoutingPreferences> {
  return readRoutingPreferencesStrict();
}

export async function writeRoutingPreferences(
  prefs: RoutingPreferences,
): Promise<void> {
  await withRoutingLock(async () => writeRoutingPreferencesAtomic(prefs));
}

export async function setPreferredProvider(
  slot: AgentModelSlot,
  provider: string | null,
): Promise<RoutingPreferences> {
  return updateRoutingPreferences((current) => {
    const next: RoutingPreferences = {
      preferredProvider: { ...current.preferredProvider },
      policy: { ...current.policy },
    };
    if (provider) next.preferredProvider[slot] = provider;
    else delete next.preferredProvider[slot];
    return next;
  });
}

export async function setPolicy(
  slot: AgentModelSlot,
  policy: RoutingPolicy | null,
): Promise<RoutingPreferences> {
  return updateRoutingPreferences((current) => {
    const next: RoutingPreferences = {
      preferredProvider: { ...current.preferredProvider },
      policy: { ...current.policy },
    };
    if (policy) next.policy[slot] = policy;
    else delete next.policy[slot];
    return next;
  });
}

/** Atomically publish one provider/policy pair for both text-generation slots. */
export async function setTextRouting(
  provider: string | null,
  policy: RoutingPolicy | null = "manual",
): Promise<RoutingPreferences> {
  return updateRoutingPreferences((current) => {
    const next: RoutingPreferences = {
      preferredProvider: { ...current.preferredProvider },
      policy: { ...current.policy },
    };
    for (const slot of TEXT_GENERATION_SLOTS) {
      if (provider) next.preferredProvider[slot] = provider;
      else delete next.preferredProvider[slot];
      if (policy) next.policy[slot] = policy;
      else delete next.policy[slot];
    }
    return next;
  });
}
