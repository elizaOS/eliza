/**
 * Per-agent spend tracking with time-bucketed Redis keys.
 *
 * Key format: spend:{agentId}:{period}:{dateKey}
 * Values stored as USD cents (integer) to avoid floating point issues.
 *
 * TTLs:
 *   day   → 2 days   (172800s)
 *   week  → 8 days   (691200s)
 *   month → 32 days  (2764800s)
 */

import { getRedis } from "./client.js";

export type SpendPeriod = "day" | "week" | "month";
type SpendLimitMap = Partial<Record<SpendPeriod, number>>;

export interface SpendLimitSnapshot {
  allowed: boolean;
  spent: number;
  reserved: number;
  effectiveSpent: number;
  remaining: number;
}

export interface SpendReservation {
  reservedUsd: number;
  periods: SpendPeriod[];
  buckets: Array<{ period: SpendPeriod; dateKey: string; key: string }>;
}

const TTL_SECONDS: Record<SpendPeriod, number> = {
  day: 172800, // 2 days
  week: 691200, // 8 days
  month: 2764800, // 32 days
};

// ARGV: reserveUnits, limitUnits, tenantId, ttlSeconds
// Returns {ok, settled, reservedAfter}. Increments `reserved` only when the
// effective spend stays within the limit — atomic so concurrent reserves
// cannot collectively exceed the cap.
const RESERVE_SPEND_LUA = `
local reserve = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local settled = tonumber(redis.call('HGET', KEYS[1], 'total') or '0')
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
if (settled + reserved + reserve) > limit then
  return {0, settled, reserved}
end
local after = redis.call('HINCRBY', KEYS[1], 'reserved', reserve)
redis.call('HSET', KEYS[1], 'tenantId', ARGV[3])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
return {1, settled, after}
`;

// ARGV: releaseUnits. Returns reservedAfter.
// Decrement `reserved` but FLOOR AT ZERO: a double-settle (caller bug) must
// not drive the field negative — a negative `reserved` would subtract from
// the effective spend in checkSpendLimit/reserveSpend and silently free
// budget (fail-open). SEC-168. Atomic so a concurrent reserve cannot observe
// a transient negative either.
const SETTLE_RESERVED_LUA = `
local release = tonumber(ARGV[1])
local current = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
local after = math.max(0, current - release)
redis.call('HSET', KEYS[1], 'reserved', after)
return after
`;

/**
 * Get the date key for a given period.
 * - day:   "2026-03-27"
 * - week:  "2026-W13" (ISO week number)
 * - month: "2026-03"
 */
function getDateKey(period: SpendPeriod, date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");

  switch (period) {
    case "day":
      return `${y}-${m}-${d}`;
    case "week": {
      const { isoYear, isoWeek: weekNum } = isoWeek(date);
      return `${isoYear}-W${String(weekNum).padStart(2, "0")}`;
    }
    case "month":
      return `${y}-${m}`;
  }
}

function spendKey(
  agentId: string,
  period: SpendPeriod,
  dateKey: string,
): string {
  return `spend:${agentId}:${period}:${dateKey}`;
}

/**
 * ISO-8601 week number + ISO week-year (Thursday-based). Days near a year
 * boundary may belong to the previous/next ISO week-year, so we return both.
 */
export function isoWeek(date: Date): { isoYear: number; isoWeek: number } {
  // Shift to the Thursday of the current ISO week (Mon=0..Sun=6).
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(
    firstThursday.getUTCDate() - firstThursdayDayNum + 3,
  );
  const week =
    1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return { isoYear, isoWeek: week };
}

function toSpendUnits(costUsd: number): number {
  // A sign/parse error upstream must not silently floor to a free spend.
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    throw new Error(`invalid spend amount: ${costUsd}`);
  }
  if (costUsd === 0) return 0;
  return Math.ceil(costUsd * 10000); // store as 0.01 cent precision, rounded up for enforcement
}

function fromSpendUnits(units: number): number {
  return units / 10000;
}

async function rollbackReservedSpend(
  tenantId: string,
  reserveUnits: number,
  buckets: SpendReservation["buckets"],
): Promise<void> {
  if (reserveUnits <= 0 || buckets.length === 0) return;
  const redis = getRedis();
  const pipeline = redis.multi();

  for (const { period, key } of buckets) {
    pipeline.hincrby(key, "reserved", -reserveUnits);
    pipeline.hset(key, "tenantId", tenantId);
    pipeline.expire(key, TTL_SECONDS[period]);
  }

  await pipeline.exec();
}

/**
 * Record a spend event. Increments the spend counter for all periods
 * (day, week, month) atomically.
 *
 * Also stores per-host breakdown as hash fields.
 *
 * @param agentId - The agent's ID
 * @param tenantId - The tenant's ID (stored in hash for querying)
 * @param costUsd - Cost in USD (e.g. 0.03 for 3 cents)
 * @param host - The API host (e.g. "api.openai.com")
 */
export async function recordSpend(
  agentId: string,
  tenantId: string,
  costUsd: number,
  host: string,
): Promise<void> {
  const costCents = toSpendUnits(costUsd); // throws on negative/NaN; 0 → no-op below
  if (costCents <= 0) return;

  const redis = getRedis();
  const now = new Date();

  const pipeline = redis.multi();

  for (const period of ["day", "week", "month"] as SpendPeriod[]) {
    const dateKey = getDateKey(period, now);
    const key = spendKey(agentId, period, dateKey);

    // Increment total spend
    pipeline.hincrby(key, "total", costCents);
    // Increment per-host spend
    pipeline.hincrby(key, `host:${host}`, costCents);
    // Store tenant ID (idempotent)
    pipeline.hset(key, "tenantId", tenantId);
    // Set TTL (only if not already set — NX equivalent via expire)
    pipeline.expire(key, TTL_SECONDS[period]);
  }

  await pipeline.exec();
}

/**
 * Reserve in-flight spend before a request leaves the proxy.
 *
 * The reservation is kept separate from settled spend but checkSpendLimit counts
 * both fields. Each period is incremented first and rolled back if the effective
 * spend crosses that period's configured limit.
 */
export async function reserveSpend(
  agentId: string,
  tenantId: string,
  reserveUsd: number,
  limits: SpendLimitMap,
): Promise<SpendReservation> {
  const reserveUnits = toSpendUnits(reserveUsd);
  if (reserveUnits <= 0) return { reservedUsd: 0, periods: [], buckets: [] };

  const redis = getRedis();
  const now = new Date();
  const periods = (["day", "week", "month"] as SpendPeriod[]).filter(
    (period) => limits[period] !== undefined,
  );
  const reservedPeriods: SpendPeriod[] = [];
  const reservedBuckets: SpendReservation["buckets"] = [];

  for (const period of periods) {
    const limit = limits[period];
    if (limit === undefined) continue;
    const dateKey = getDateKey(period, now);
    const key = spendKey(agentId, period, dateKey);
    const limitUnits = toSpendUnits(limit);

    // Atomic per-bucket gate: read total+reserved, only bump `reserved` if the
    // result stays within the limit. A separate hincrby + hget would let
    // concurrent requests race past the cap (TOCTOU).
    const res = (await redis.eval(
      RESERVE_SPEND_LUA,
      1,
      key,
      String(reserveUnits),
      String(limitUnits),
      tenantId,
      String(TTL_SECONDS[period]),
    )) as [number, number, number];
    const [ok, settled] = res;

    if (ok === 1) {
      reservedPeriods.push(period);
      reservedBuckets.push({ period, dateKey, key });
      continue;
    }

    if (reservedBuckets.length > 0) {
      await rollbackReservedSpend(tenantId, reserveUnits, reservedBuckets);
    }
    throw new Error(
      `${period} spend reservation would exceed limit: requested $${reserveUsd.toFixed(4)} with $${fromSpendUnits(Math.max(0, limitUnits - settled)).toFixed(4)} available`,
    );
  }

  return {
    reservedUsd: fromSpendUnits(reserveUnits),
    periods: reservedPeriods,
    buckets: reservedBuckets,
  };
}

/**
 * Settle an earlier reservation after the upstream response is known.
 *
 * If actual spend cannot be calculated, callers should pass the reserved amount
 * to avoid turning parsing failures into free budget bypasses.
 */
export async function settleReservedSpend(
  agentId: string,
  tenantId: string,
  reservedUsd: number,
  actualUsd: number,
  host: string,
  periods: SpendPeriod[],
  buckets?: SpendReservation["buckets"],
): Promise<void> {
  const reservedUnits = toSpendUnits(reservedUsd);
  const actualUnits = Math.max(0, toSpendUnits(actualUsd));
  const settlementBuckets =
    buckets && buckets.length > 0
      ? buckets
      : periods.map((period) => {
          const dateKey = getDateKey(period);
          return { period, dateKey, key: spendKey(agentId, period, dateKey) };
        });
  if (reservedUnits <= 0 || settlementBuckets.length === 0) {
    if (actualUnits > 0) await recordSpend(agentId, tenantId, actualUsd, host);
    return;
  }

  const redis = getRedis();
  const pipeline = redis.multi();

  for (const { period, key } of settlementBuckets) {
    // SEC-168: clamped Lua decrement — never let `reserved` go negative.
    pipeline.eval(SETTLE_RESERVED_LUA, 1, key, String(reservedUnits));
    if (actualUnits > 0) {
      pipeline.hincrby(key, "total", actualUnits);
      pipeline.hincrby(key, `host:${host}`, actualUnits);
    }
    pipeline.hset(key, "tenantId", tenantId);
    pipeline.expire(key, TTL_SECONDS[period]);
  }

  await pipeline.exec();
}

/**
 * Get total spend for an agent in a given period.
 *
 * @returns Spend in USD
 */
export async function getSpend(
  agentId: string,
  period: SpendPeriod,
  date?: Date,
): Promise<number> {
  const redis = getRedis();
  const dateKey = getDateKey(period, date || new Date());
  const key = spendKey(agentId, period, dateKey);

  const totalCents = await redis.hget(key, "total");
  if (!totalCents) return 0;

  return fromSpendUnits(Number(totalCents)); // convert back to USD
}

/**
 * Check if an agent is within their spend limit.
 *
 * ADVISORY ONLY: this is a status read with no pending amount, so `allowed`
 * means "budget not yet fully consumed". The real enforcement is the atomic
 * gate in reserveSpend — never admit a request on this alone.
 *
 * @returns Whether the agent can spend more, how much they've spent, and remaining budget
 */
export async function checkSpendLimit(
  agentId: string,
  limitUsd: number,
  period: SpendPeriod,
): Promise<SpendLimitSnapshot> {
  const redis = getRedis();
  const dateKey = getDateKey(period);
  const key = spendKey(agentId, period, dateKey);
  const [totalRaw, reservedRaw] = await Promise.all([
    redis.hget(key, "total"),
    redis.hget(key, "reserved"),
  ]);
  const spent = fromSpendUnits(Number(totalRaw ?? "0"));
  const reserved = fromSpendUnits(Number(reservedRaw ?? "0"));
  const effectiveSpent = spent + reserved;
  const remaining = Math.max(0, limitUsd - effectiveSpent);

  return {
    allowed: effectiveSpent < limitUsd,
    spent,
    reserved,
    effectiveSpent,
    remaining,
  };
}

/**
 * Get per-host spend breakdown for an agent in a given period.
 */
export async function getSpendByHost(
  agentId: string,
  period: SpendPeriod,
  date?: Date,
): Promise<Record<string, number>> {
  const redis = getRedis();
  const dateKey = getDateKey(period, date || new Date());
  const key = spendKey(agentId, period, dateKey);

  const all = await redis.hgetall(key);
  const result: Record<string, number> = {};

  for (const [field, value] of Object.entries(all)) {
    if (field.startsWith("host:")) {
      result[field.slice(5)] = Number(value) / 10000;
    }
  }

  return result;
}
