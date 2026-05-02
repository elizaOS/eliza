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

const TTL_SECONDS: Record<SpendPeriod, number> = {
  day: 172800, // 2 days
  week: 691200, // 8 days
  month: 2764800, // 32 days
};

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
      // ISO week number
      const jan1 = new Date(Date.UTC(y, 0, 1));
      const dayOfYear = Math.floor((date.getTime() - jan1.getTime()) / 86400000) + 1;
      const weekNum = Math.ceil((dayOfYear + jan1.getUTCDay()) / 7);
      return `${y}-W${String(weekNum).padStart(2, "0")}`;
    }
    case "month":
      return `${y}-${m}`;
  }
}

function spendKey(agentId: string, period: SpendPeriod, dateKey: string): string {
  return `spend:${agentId}:${period}:${dateKey}`;
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
  if (costUsd <= 0) return;

  const redis = getRedis();
  const costCents = Math.round(costUsd * 10000); // store as 0.01 cent precision (hundredths of cent)
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
 * Get total spend for an agent in a given period.
 *
 * @returns Spend in USD
 */
export async function getSpend(agentId: string, period: SpendPeriod, date?: Date): Promise<number> {
  const redis = getRedis();
  const dateKey = getDateKey(period, date || new Date());
  const key = spendKey(agentId, period, dateKey);

  const totalCents = await redis.hget(key, "total");
  if (!totalCents) return 0;

  return Number(totalCents) / 10000; // convert back to USD
}

/**
 * Check if an agent is within their spend limit.
 *
 * @returns Whether the agent can spend more, how much they've spent, and remaining budget
 */
export async function checkSpendLimit(
  agentId: string,
  limitUsd: number,
  period: SpendPeriod,
): Promise<{ allowed: boolean; spent: number; remaining: number }> {
  const spent = await getSpend(agentId, period);
  const remaining = Math.max(0, limitUsd - spent);

  return {
    allowed: spent < limitUsd,
    spent,
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
