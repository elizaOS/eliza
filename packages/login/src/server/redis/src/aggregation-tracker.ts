/**
 * Rolling-window aggregation tracker (Privy "aggregations" parity).
 *
 * Backs the policy-engine `aggregation` policy type. Records authoritative
 * per-agent activity into Redis sorted sets keyed by timestamp, then
 * materialises rolling-window aggregates (value sums, tx counts, unique
 * recipients) grouped by scope (agent / per-recipient / per-chain).
 *
 * The aggregate is ALWAYS computed here from server-side records — it is never
 * read from a caller-supplied request body. The policy evaluator consumes a
 * precomputed snapshot map and fails closed when a snapshot is absent.
 *
 * Sorted-set model (mirrors the sliding-window rate-limiter):
 *   key    = agg:{agentId}:{metricFamily}:{scope}:{scopeKey}
 *   score  = event timestamp (ms)
 *   member = "{ts}:{seq}|{payload}"
 *            payload is the wei amount for value sums, the lowercased recipient
 *            for unique-recipient sets, or empty for plain counts. The
 *            "{ts}:{seq}" prefix keeps members unique within a millisecond.
 *
 * Window boundary: a window of S seconds at time `now` covers the HALF-OPEN
 * interval `(now - S*1000, now]`. An event exactly S seconds old has aged out
 * and is excluded; an event at `now` is included. This matches the evaluator's
 * documented convention so off-by-one window math cannot flip a verdict.
 */

import { randomUUID } from "node:crypto";
import { getRedis } from "./client.js";

/** Maximum rolling window we retain events for (matches the 30d named window). */
const MAX_WINDOW_SECONDS = 2592000;
const RETENTION_MS = MAX_WINDOW_SECONDS * 1000;

export type AggregationMetricFamily = "value" | "count" | "recipients";
export type AggregationScope = "agent" | "per_recipient" | "per_chain";

/** A single authoritative activity event to fold into the rolling aggregates. */
export interface AggregationEvent {
  agentId: string;
  /** Recipient address (lowercased on write). Required for per_recipient scope. */
  to: string;
  /** Numeric chain id. Required for per_chain scope. */
  chainId: number;
  /** Transferred value in raw base units (wei/lamports), decimal string. */
  valueRaw: string;
  /** Event time in ms; defaults to now. Injectable for tests. */
  timestamp?: number;
}

/** Query describing the rolling aggregate the evaluator wants materialised. */
export interface AggregationSnapshotQuery {
  agentId: string;
  metric: "value_sum" | "tx_count" | "unique_recipients";
  windowSeconds: number;
  scope: AggregationScope;
  /** "" for agent scope, lowercased recipient, or decimal chainId. */
  scopeKey: string;
}

function metricFamily(
  metric: AggregationSnapshotQuery["metric"],
): AggregationMetricFamily {
  switch (metric) {
    case "value_sum":
      return "value";
    case "tx_count":
      return "count";
    case "unique_recipients":
      return "recipients";
  }
}

function aggKey(
  agentId: string,
  family: AggregationMetricFamily,
  scope: AggregationScope,
  scopeKey: string,
): string {
  return `agg:${agentId}:${family}:${scope}:${scopeKey}`;
}

/**
 * Parse a non-negative integer decimal string to bigint, else null. Keeps the
 * tracker bigint-exact and rejects floats/signs/garbage so a bad value can
 * never silently corrupt the running sum.
 */
function parseNonNegInt(value: string): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  try {
    const n = BigInt(value.trim());
    return n < 0n ? null : n;
  } catch {
    return null;
  }
}

// Record an event into the relevant sorted sets. Prune anything older than the
// max retention, append the new member, and refresh the TTL — all atomically.
// KEYS = [valueSetKeys..., countSetKeys..., recipientSetKeys...]; we pass a
// JSON spec via ARGV so one script handles a variable number of scoped keys.
// ARGV[1]=now ARGV[2]=cutoff ARGV[3]=ttlMs ARGV[4]=member ARGV[5]=score
const RECORD_LUA = `
local now = tonumber(ARGV[1])
local cutoff = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local member = ARGV[4]
local score = tonumber(ARGV[5])
for i = 1, #KEYS do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], 0, cutoff)
  redis.call('ZADD', KEYS[i], score, member .. ':' .. i)
  redis.call('PEXPIRE', KEYS[i], ttl)
end
return 1
`;

// Read a window: prune expired, then return every member whose score is within
// (windowStart, now]. We return raw members and aggregate in JS (bigint-exact
// for value sums; Set-based for unique recipients). ZADD-pruning keeps the set
// bounded so the read stays cheap.
// ARGV[1]=windowStart(exclusive) ARGV[2]=now(inclusive) ARGV[3]=retentionCutoff
const READ_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, tonumber(ARGV[3]))
return redis.call('ZRANGEBYSCORE', KEYS[1], '(' .. ARGV[1], ARGV[2])
`;

/**
 * Record one authoritative activity event. Call this AFTER a transaction is
 * committed/settled (mirrors how spend/rate counters are written), inside the
 * same per-agent serialization window used for spend caps.
 */
export async function recordAggregationEvent(
  event: AggregationEvent,
): Promise<void> {
  const valueRaw = parseNonNegInt(event.valueRaw);
  if (valueRaw === null) {
    throw new Error(`invalid aggregation value: ${event.valueRaw}`);
  }
  if (typeof event.agentId !== "string" || event.agentId.length === 0) {
    throw new Error("aggregation event requires agentId");
  }

  const now = event.timestamp ?? Date.now();
  const cutoff = now - RETENTION_MS;
  const to = typeof event.to === "string" ? event.to.toLowerCase() : "";
  const chainKey =
    Number.isSafeInteger(event.chainId) && event.chainId > 0
      ? String(event.chainId)
      : "";

  // Build the scoped key set. value + count families share the same member
  // (the value payload). recipients family stores the recipient as the payload
  // so unique-recipient counts collapse duplicate addresses within a window.
  const valueMember = `${now}:${cryptoSeq()}|${valueRaw.toString()}`;
  const recipientMember = `${now}:${cryptoSeq()}|${to}`;

  const redis = getRedis();

  // value_sum + tx_count buckets (agent always; per_recipient / per_chain when
  // the discriminator is present).
  const valueKeys: string[] = [aggKey(event.agentId, "value", "agent", "")];
  const countKeys: string[] = [aggKey(event.agentId, "count", "agent", "")];
  const recipientKeys: string[] = [
    aggKey(event.agentId, "recipients", "agent", ""),
  ];

  if (to) {
    valueKeys.push(aggKey(event.agentId, "value", "per_recipient", to));
    countKeys.push(aggKey(event.agentId, "count", "per_recipient", to));
  }
  if (chainKey) {
    valueKeys.push(aggKey(event.agentId, "value", "per_chain", chainKey));
    countKeys.push(aggKey(event.agentId, "count", "per_chain", chainKey));
    recipientKeys.push(
      aggKey(event.agentId, "recipients", "per_chain", chainKey),
    );
  }

  // value + count families carry the value payload member.
  await runRecord(
    redis,
    [...valueKeys, ...countKeys],
    now,
    cutoff,
    valueMember,
  );
  // recipients family carries the recipient payload member.
  await runRecord(redis, recipientKeys, now, cutoff, recipientMember);
}

async function runRecord(
  redis: ReturnType<typeof getRedis>,
  keys: string[],
  now: number,
  cutoff: number,
  member: string,
): Promise<void> {
  if (keys.length === 0) return;
  await redis.eval(
    RECORD_LUA,
    keys.length,
    ...keys,
    String(now),
    String(cutoff),
    String(RETENTION_MS),
    member,
    String(now),
  );
}

/** Cryptographically strong suffix so events remain unique across restarts. */
function cryptoSeq(): string {
  return randomUUID();
}

function decodePayload(member: string): string {
  const idx = member.indexOf("|");
  if (idx < 0) return "";
  // Drop the trailing ":i" key-index suffix the record script appended.
  const tail = member.slice(idx + 1);
  const lastColon = tail.lastIndexOf(":");
  return lastColon >= 0 ? tail.slice(0, lastColon) : tail;
}

/**
 * Materialise a single rolling-window snapshot from authoritative records.
 * Returns the aggregate as a bigint (raw base units / counts). Returns null on
 * any I/O or parse failure so the caller can fail closed (deny).
 */
export async function getAggregationSnapshot(
  query: AggregationSnapshotQuery,
  now: number = Date.now(),
): Promise<bigint | null> {
  if (!Number.isSafeInteger(query.windowSeconds) || query.windowSeconds <= 0)
    return null;
  const effectiveWindow = Math.min(query.windowSeconds, MAX_WINDOW_SECONDS);
  const windowStart = now - effectiveWindow * 1000;
  const retentionCutoff = now - RETENTION_MS;
  const family = metricFamily(query.metric);
  const key = aggKey(query.agentId, family, query.scope, query.scopeKey);

  let members: string[];
  try {
    const redis = getRedis();
    members = (await redis.eval(
      READ_LUA,
      1,
      key,
      String(windowStart),
      String(now),
      String(retentionCutoff),
    )) as string[];
  } catch {
    return null;
  }

  if (!Array.isArray(members)) return null;

  switch (query.metric) {
    case "tx_count":
      return BigInt(members.length);
    case "value_sum": {
      let sum = 0n;
      for (const member of members) {
        const parsed = parseNonNegInt(decodePayload(member));
        if (parsed === null) return null; // corrupt record → fail closed
        sum += parsed;
      }
      return sum;
    }
    case "unique_recipients": {
      const seen = new Set<string>();
      for (const member of members) {
        const recipient = decodePayload(member);
        if (recipient) seen.add(recipient);
      }
      return BigInt(seen.size);
    }
  }
}
