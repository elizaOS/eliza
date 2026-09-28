/**
 * Durable connector-ingress hold for Shared→Dedicated cutover (#22934).
 *
 * Personal connector webhooks that the gateway acknowledges before processing
 * (Blooio, Twilio) cannot rely on a provider retry. When Cloud refuses a turn
 * with an explicit pre-execution cutover hold (the Shared seal, a committed
 * cutover still resolving, or a Dedicated target that is not yet attested),
 * the gateway persists the event in Redis and redelivers it until Cloud
 * accepts it. The webhook's dedup key stays "held" meanwhile, so a provider
 * redelivery is acknowledged without a second turn, and each redelivery uses
 * the same message id, so Cloud never executes the turn twice.
 */

import type { ChatEvent, Platform } from "./adapters/types";
import type { GatewayRedis } from "./redis";

/** Cloud codes that prove the turn did not execute and will be accepted later. */
export const CUTOVER_HOLD_CODES: ReadonlySet<string> = new Set([
  "personal_cutover_in_progress",
  "dedicated_starting",
  "dedicated_reconciling",
  "dedicated_fallback_pending",
]);

/** Dedup-ledger state for a webhook parked until its cutover completes. */
export const CONNECTOR_HELD = "held";

/**
 * Longest a message is held waiting for Dedicated attestation. Cutover seals
 * last one minute and provisioning a few more; an hour is a generous bound
 * after which the hold is released to the ordinary failure handling.
 */
export const CUTOVER_HOLD_MAX_MS = 60 * 60_000;
const HOLD_RECORD_TTL_SECONDS =
  Math.ceil(CUTOVER_HOLD_MAX_MS / 1_000) + 15 * 60;
const HOLD_LEASE_SECONDS = 180;
const HOLD_INDEX_KEY = "webhook:cutover-holds";
const HOLD_RECORD_PREFIX = "webhook:cutover-hold:";
const HOLD_LEASE_PREFIX = "webhook:cutover-hold-lease:";
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

export interface CutoverHoldSignal {
  code: string;
  retryAfterSeconds: number | null;
}

export interface HeldWebhook {
  v: 1;
  dedupKey: string;
  platform: Platform;
  project: string;
  agentId?: string;
  traceId: string;
  event: ChatEvent;
  heldAt: number;
  attempts: number;
  code: string;
}

function recordKey(dedupKey: string): string {
  return `${HOLD_RECORD_PREFIX}${dedupKey}`;
}

function nextAttemptDelayMs(
  signal: CutoverHoldSignal,
  attempts: number,
): number {
  const hinted =
    signal.retryAfterSeconds !== null && signal.retryAfterSeconds > 0
      ? signal.retryAfterSeconds * 1_000
      : 0;
  const backoff = Math.min(
    MAX_RETRY_MS,
    MIN_RETRY_MS * 2 ** Math.min(attempts, 5),
  );
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, hinted, backoff));
}

function parseHeldWebhook(value: unknown): HeldWebhook | null {
  const record =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            // error-policy:J3 an unreadable record is dropped from the index
            // by the caller; it can no longer be redelivered safely.
            return null;
          }
        })()
      : value;
  if (!record || typeof record !== "object") return null;
  const held = record as Partial<HeldWebhook>;
  if (
    held.v !== 1 ||
    typeof held.dedupKey !== "string" ||
    typeof held.platform !== "string" ||
    typeof held.project !== "string" ||
    typeof held.traceId !== "string" ||
    typeof held.heldAt !== "number" ||
    typeof held.attempts !== "number" ||
    typeof held.code !== "string" ||
    !held.event ||
    typeof held.event !== "object"
  ) {
    return null;
  }
  return held as HeldWebhook;
}

/**
 * Park one refused webhook. The record is written before the index entry and
 * the dedup key moves to "held" last, so every visible hold is recoverable.
 */
export async function holdWebhookForCutover(
  redis: GatewayRedis,
  input: Omit<HeldWebhook, "v" | "heldAt" | "attempts"> & {
    heldAt?: number;
    attempts?: number;
  },
  signal: CutoverHoldSignal,
  now = Date.now(),
): Promise<HeldWebhook> {
  const held: HeldWebhook = {
    v: 1,
    dedupKey: input.dedupKey,
    platform: input.platform,
    project: input.project,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    traceId: input.traceId,
    event: input.event,
    heldAt: input.heldAt ?? now,
    attempts: input.attempts ?? 0,
    code: signal.code,
  };
  await redis.set(recordKey(held.dedupKey), JSON.stringify(held), {
    ex: HOLD_RECORD_TTL_SECONDS,
  });
  await redis.zadd(
    HOLD_INDEX_KEY,
    now + nextAttemptDelayMs(signal, held.attempts),
    held.dedupKey,
  );
  await redis.set(held.dedupKey, CONNECTOR_HELD, {
    ex: HOLD_RECORD_TTL_SECONDS,
  });
  return held;
}

/** Outcome reported by the redelivery callback for one held webhook. */
export type HeldWebhookOutcome =
  | { kind: "delivered" }
  | { kind: "held"; signal: CutoverHoldSignal }
  | { kind: "released" };

export interface CutoverHoldDrainStats {
  delivered: number;
  rescheduled: number;
  released: number;
  expired: number;
}

/**
 * Redeliver every due hold once. A per-hold lease keeps replicas from running
 * the same turn concurrently. `redeliver` owns delivery and the terminal
 * ledger state for "delivered" and "released"; an expired hold is released
 * through `release` so the ordinary failure handling decides its ledger state.
 */
export async function drainCutoverHolds(
  redis: GatewayRedis,
  handlers: {
    redeliver(held: HeldWebhook): Promise<HeldWebhookOutcome>;
    release(held: HeldWebhook, reason: "expired"): Promise<void>;
  },
  options: { now?: number; limit?: number } = {},
): Promise<CutoverHoldDrainStats> {
  const now = options.now ?? Date.now();
  const stats: CutoverHoldDrainStats = {
    delivered: 0,
    rescheduled: 0,
    released: 0,
    expired: 0,
  };
  const due = await redis.zrangebyscore(
    HOLD_INDEX_KEY,
    0,
    now,
    options.limit ?? 16,
  );
  for (const dedupKey of due) {
    const leaseKey = `${HOLD_LEASE_PREFIX}${dedupKey}`;
    const leased = await redis.set(leaseKey, String(now), {
      nx: true,
      ex: HOLD_LEASE_SECONDS,
    });
    if (!leased) continue;
    try {
      const held = parseHeldWebhook(await redis.get(recordKey(dedupKey)));
      if (!held || held.dedupKey !== dedupKey) {
        await redis.zrem(HOLD_INDEX_KEY, dedupKey);
        continue;
      }
      if (now - held.heldAt > CUTOVER_HOLD_MAX_MS) {
        await handlers.release(held, "expired");
        await redis.del(recordKey(dedupKey));
        await redis.zrem(HOLD_INDEX_KEY, dedupKey);
        stats.expired += 1;
        continue;
      }
      const outcome = await handlers.redeliver(held);
      if (outcome.kind === "held") {
        await holdWebhookForCutover(
          redis,
          { ...held, attempts: held.attempts + 1 },
          outcome.signal,
          now,
        );
        stats.rescheduled += 1;
        continue;
      }
      await redis.del(recordKey(dedupKey));
      await redis.zrem(HOLD_INDEX_KEY, dedupKey);
      if (outcome.kind === "delivered") stats.delivered += 1;
      else stats.released += 1;
    } finally {
      await redis.del(leaseKey);
    }
  }
  return stats;
}
