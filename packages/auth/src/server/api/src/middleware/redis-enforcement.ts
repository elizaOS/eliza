/**
 * Redis-backed real-time enforcement helpers for vault and proxy routes.
 *
 * These supplement the policy engine (which checks DB-based stats) with
 * real-time Redis counters. The policy engine remains the source of truth
 * for policy definitions; Redis provides fast, sliding-window enforcement.
 */

import {
  createPriceOracle,
  type PolicyRule,
} from "../../../shared/src/index.ts";
import {
  checkAgentRateLimit,
  isRedisAvailable,
  isRedisConfigured,
  recordAgentSpend,
} from "./redis";

// Local price oracle (no DB dependency, unlike services/context). Caches per chain
// for 60s; used to convert native-token wei → USD for real-time spend tracking.
const priceOracle = createPriceOracle({ cacheTtlMs: 60_000 });

// ─── Rate limit extraction from policies ─────────────────────────────────────

interface RateLimitParams {
  maxTxPerHour: number;
  maxTxPerDay: number;
}

interface RateLimitHeaderInput {
  limit: number;
  remaining: number;
  resetMs: number;
  retryAfterMs?: number;
}

/**
 * Extract rate-limit parameters from an agent's policy set.
 * Returns null if no enabled rate-limit policy exists.
 */
export function extractRateLimitPolicy(
  policies: PolicyRule[],
): RateLimitParams | null {
  const rlPolicy = policies.find((p) => p.type === "rate-limit" && p.enabled);
  if (!rlPolicy) return null;

  const config = rlPolicy.config as Record<string, unknown>;
  return {
    maxTxPerHour: Number(config.maxTxPerHour ?? 100),
    maxTxPerDay: Number(config.maxTxPerDay ?? 1000),
  };
}

/**
 * Extract spend-limit parameters from policies.
 *
 * Note: The policy engine uses wei-based spend limits for on-chain transactions.
 * For Redis enforcement, we need USD-based limits. This function extracts the raw
 * wei values; callers should convert to USD using current ETH price if needed.
 *
 * For proxy API call tracking, USD is used directly via the cost estimator.
 */
export function extractSpendLimitPolicy(
  policies: PolicyRule[],
): { maxPerDay: string; maxPerWeek: string } | null {
  const slPolicy = policies.find(
    (p) => p.type === "spending-limit" && p.enabled,
  );
  if (!slPolicy) return null;

  const config = slPolicy.config as Record<string, unknown>;

  const MAX =
    "115792089237316195423570985008687907853269984665640564039457584007913129639935";
  let legacyDaily = MAX;
  let legacyWeekly = MAX;
  const hasLegacy = typeof config.maxAmount === "string";
  if (hasLegacy) {
    const period =
      typeof config.period === "string" ? config.period.toLowerCase() : "day";
    if (period === "week" || period === "weekly")
      legacyWeekly = config.maxAmount as string;
    else if (period !== "tx" && period !== "transaction")
      legacyDaily = config.maxAmount as string;
  }

  const hasDaily = typeof config.maxPerDay === "string";
  const hasWeekly = typeof config.maxPerWeek === "string";
  // Per-transaction-only and pure-USD policies have no rolling wei cap for
  // this helper to extract. In particular, do not turn them into a zero daily
  // cap by falling through the legacy default.
  if (!hasDaily && !hasWeekly && !hasLegacy) return null;

  return {
    maxPerDay: hasDaily ? (config.maxPerDay as string) : legacyDaily,
    maxPerWeek: hasWeekly ? (config.maxPerWeek as string) : legacyWeekly,
  };
}

// ─── Pre-signing checks ──────────────────────────────────────────────────────

export interface RedisEnforcementResult {
  allowed: boolean;
  reason?: string;
  /** Rate limit headers to include in response */
  headers?: Record<string, string>;
}

export function formatRateLimitHeaders(
  input: RateLimitHeaderInput,
): Record<string, string> {
  const limit = Math.max(0, Math.floor(input.limit));
  const remaining = Math.max(0, Math.floor(input.remaining));
  const resetSecs = Math.max(0, Math.ceil(input.resetMs / 1000));
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(limit),
    "RateLimit-Remaining": String(remaining),
    "RateLimit-Reset": String(resetSecs),
    "X-RateLimit-Limit": String(limit),
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Reset": String(resetSecs),
  };
  if (input.retryAfterMs !== undefined) {
    headers["Retry-After"] = String(
      Math.max(1, Math.ceil(input.retryAfterMs / 1000)),
    );
  }
  return headers;
}

/**
 * Run Redis-backed rate limit checks before signing.
 *
 * Checks both hourly and daily windows using sliding-window counters.
 */
export async function enforceRateLimit(
  agentId: string,
  policies: PolicyRule[],
): Promise<RedisEnforcementResult> {
  const rlParams = extractRateLimitPolicy(policies);
  if (!rlParams) return { allowed: true };
  if (!isRedisAvailable()) {
    if (!isRedisConfigured() && process.env.NODE_ENV !== "production")
      return { allowed: true };
    return {
      allowed: false,
      reason: "Rate limit enforcement is unavailable",
      headers: formatRateLimitHeaders({
        limit: 0,
        remaining: 0,
        resetMs: 60_000,
        retryAfterMs: 60_000,
      }),
    };
  }

  // Check hourly rate limit
  const hourlyResult = await checkAgentRateLimit(
    agentId,
    3600_000, // 1 hour
    rlParams.maxTxPerHour,
  );

  if (!hourlyResult.allowed) {
    return {
      allowed: false,
      reason: `Hourly rate limit exceeded (${rlParams.maxTxPerHour}/hour). Retry after ${Math.ceil(hourlyResult.resetMs / 1000)}s`,
      headers: formatRateLimitHeaders({
        limit: rlParams.maxTxPerHour,
        remaining: 0,
        resetMs: hourlyResult.resetMs,
        retryAfterMs: hourlyResult.resetMs,
      }),
    };
  }

  // Check daily rate limit
  const dailyResult = await checkAgentRateLimit(
    agentId,
    86400_000, // 24 hours
    rlParams.maxTxPerDay,
  );

  if (!dailyResult.allowed) {
    return {
      allowed: false,
      reason: `Daily rate limit exceeded (${rlParams.maxTxPerDay}/day). Retry after ${Math.ceil(dailyResult.resetMs / 1000)}s`,
      headers: formatRateLimitHeaders({
        limit: rlParams.maxTxPerDay,
        remaining: 0,
        resetMs: dailyResult.resetMs,
        retryAfterMs: dailyResult.resetMs,
      }),
    };
  }

  return {
    allowed: true,
    headers: {
      ...formatRateLimitHeaders({
        limit: rlParams.maxTxPerHour,
        remaining: hourlyResult.remaining,
        resetMs: hourlyResult.resetMs,
      }),
      "X-RateLimit-Remaining-Hourly": String(hourlyResult.remaining),
      "X-RateLimit-Remaining-Daily": String(dailyResult.remaining),
      "RateLimit-Policy": `${rlParams.maxTxPerHour};w=3600, ${rlParams.maxTxPerDay};w=86400`,
    },
  };
}

/**
 * Record a spend event after successful vault transaction.
 *
 * Converts the native-token wei value to USD via the price oracle (bigint-safe,
 * per-chain native price) before recording. This is for real-time budget
 * tracking; the policy engine's DB-based tracking remains the source of truth.
 */
export async function recordVaultSpend(
  agentId: string,
  tenantId: string,
  valueWei: string,
  chainId: number,
): Promise<void> {
  if (!isRedisAvailable()) return;

  // Skip zero/empty values without touching the oracle.
  let wei: bigint;
  try {
    wei = BigInt(valueWei);
  } catch {
    return;
  }
  if (wei <= 0n) return;

  // Convert native wei → USD using the oracle. weiToUsd does bigint-safe scaling
  // (no Number(BigInt) precision loss) and applies the per-chain native price.
  const usdValue = await priceOracle.weiToUsd(valueWei, chainId);

  if (usdValue !== null && usdValue > 0) {
    await recordAgentSpend(agentId, tenantId, usdValue, `chain:${chainId}`);
    return;
  }

  // Price unavailable. Fail CLOSED (consistent with the proxy path and the platform's
  // money-path posture): rather than recording the native-token amount as if it were USD
  // — which undercounts real spend ~1000-4000x and effectively bypasses the USD cap — value
  // the spend with a deliberately HIGH conservative native-price floor so the spend still
  // counts against the same `chain:${chainId}` USD cap and can trip it. Over-counting during
  // an oracle outage is the safe direction; the priced path above is unaffected.
  const decimals = 18; // EVM native tokens use 18 decimals
  const divisor = 10n ** BigInt(decimals);
  const tokenAmount =
    Number(wei / divisor) + Number(wei % divisor) / Number(divisor);
  const fallbackNativePriceUsd = (() => {
    const parsed = Number(process.env.STEWARD_NATIVE_PRICE_FALLBACK_USD);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
  })();
  const conservativeUsd = tokenAmount * fallbackNativePriceUsd;
  await recordAgentSpend(
    agentId,
    tenantId,
    conservativeUsd,
    `chain:${chainId}`,
  );
}
