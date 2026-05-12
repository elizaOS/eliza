/**
 * Replay + in-flight guard for x402 verification.
 *
 * - **In-flight (`inflight`)**: in-memory only; prevents concurrent duplicate
 *   verification in the same process (TOCTOU between check and verify).
 * - **Consumed**: when `X402_REPLAY_DURABLE` is not disabled and `runtime` is
 *   passed, credentials are recorded via `runtime.setCache` / `getCache` so they
 *   survive restarts and work across multiple server processes sharing the DB.
 *   Entries do not expire (same tx hash / payment id must not unlock paid routes twice).
 * - **Fallback**: set `X402_REPLAY_DURABLE=0` (or `false` / `off`) to use only an
 *   in-memory TTL map (`X402_REPLAY_WINDOW_MS` / `X402_REPLAY_TTL_MS`, default 10m).
 *   If `runtime` is omitted (e.g. isolated unit tests), that same in-memory path is used.
 */

import { type AgentRuntime, logger } from "@elizaos/core";

import {
  durableReplayAbortReservation,
  durableReplayCommitReservation,
  durableReplayTryReserve,
} from "./x402-replay-durable.js";

const inflight = new Set<string>();
const consumedMemory = new Map<string, number>();
const durableReservationOwners = new Map<string, string>();

function replayWindowMs(): number {
  const raw =
    process.env.X402_REPLAY_WINDOW_MS ?? process.env.X402_REPLAY_TTL_MS;
  const n = Number.parseInt(raw ?? "600000", 10);
  return Number.isFinite(n) && n > 0 ? n : 600_000;
}

function pruneConsumedMemory(now: number): void {
  for (const [k, exp] of consumedMemory) {
    if (exp <= now) consumedMemory.delete(k);
  }
}

/** When true (default), use runtime cache for consumed credentials. */
export function isDurableReplayEnabled(): boolean {
  const v = process.env.X402_REPLAY_DURABLE?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off") return false;
  return true;
}

/**
 * Reserve canonical replay keys for the duration of verification.
 * Returns false if any key is already consumed, or already in-flight in this process.
 */
export async function replayGuardTryBegin(
  keys: string[],
  runtime?: AgentRuntime,
  agentId?: string,
): Promise<boolean> {
  if (keys.length === 0) return true;
  const now = Date.now();
  const useDurable = isDurableReplayEnabled() && runtime != null;

  try {
    let durableOwner: string | null = null;
    if (useDurable) {
      const reservation = await durableReplayTryReserve(runtime, agentId, keys);
      if (!reservation.ok) return false;
      durableOwner = reservation.owner;
    } else {
      pruneConsumedMemory(now);
      for (const k of keys) {
        const exp = consumedMemory.get(k);
        if (exp != null && exp > now) return false;
      }
    }

    for (const k of keys) {
      if (inflight.has(k)) {
        // Already in-flight in this process — release the durable reservation
        // we just took so it does not linger until TTL expiry and block
        // subsequent legitimate attempts for the same credential.
        if (durableOwner && runtime) {
          await durableReplayAbortReservation(
            runtime,
            agentId,
            keys,
            durableOwner,
          );
        }
        return false;
      }
    }
    if (durableOwner) {
      for (const k of keys) durableReservationOwners.set(k, durableOwner);
    }
    for (const k of keys) inflight.add(k);
    return true;
  } catch (err) {
    logger.error(
      `[x402] replayGuardTryBegin failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/** Release reservation after a failed or abandoned verification attempt. */
export function replayGuardAbort(keys: string[]): void {
  for (const k of keys) {
    inflight.delete(k);
    durableReservationOwners.delete(k);
  }
}

/** Release a durable reservation after a failed or abandoned verification attempt. */
export async function replayGuardAbortAsync(
  keys: string[],
  runtime?: AgentRuntime,
  agentId?: string,
): Promise<void> {
  const owner = keys
    .map((k) => durableReservationOwners.get(k))
    .find((x): x is string => typeof x === "string");
  replayGuardAbort(keys);
  if (owner && runtime) {
    await durableReplayAbortReservation(runtime, agentId, keys, owner);
  }
}

/** Mark keys consumed after a successful verification (clears in-flight). */
export async function replayGuardCommit(
  keys: string[],
  runtime?: AgentRuntime,
  agentId?: string,
): Promise<void> {
  const useDurable = isDurableReplayEnabled() && runtime != null;
  const exp = Date.now() + replayWindowMs();
  // Require all keys to map to the same owner. If owners diverge, the
  // in-process map raced with another request — drop the owner so the durable
  // layer can no-op the owner-bound path instead of recording wrong lineage.
  let owner: string | undefined;
  let ownerConsistent = true;
  for (const k of keys) {
    const o = durableReservationOwners.get(k);
    if (typeof o !== "string") continue;
    if (owner === undefined) {
      owner = o;
    } else if (owner !== o) {
      ownerConsistent = false;
      break;
    }
  }
  for (const k of keys) {
    inflight.delete(k);
    durableReservationOwners.delete(k);
  }
  if (useDurable && keys.length > 0 && runtime) {
    await durableReplayCommitReservation(
      runtime,
      agentId,
      keys,
      ownerConsistent ? owner : undefined,
    );
  } else if (!useDurable) {
    for (const k of keys) consumedMemory.set(k, exp);
  }
}
