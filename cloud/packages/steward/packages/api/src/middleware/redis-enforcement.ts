/**
 * Redis-backed real-time enforcement helpers for vault and proxy routes.
 *
 * These supplement the policy engine (which checks DB-based stats) with
 * real-time Redis counters. The policy engine remains the source of truth
 * for policy definitions; Redis provides fast, sliding-window enforcement.
 */

import type { PolicyRule } from "@stwd/shared";
import { checkAgentRateLimit, isRedisAvailable, recordAgentSpend } from "./redis";

// ─── Rate limit extraction from policies ─────────────────────────────────────

interface RateLimitParams {
  maxTxPerHour: number;
  maxTxPerDay: number;
}

/**
 * Extract rate-limit parameters from an agent's policy set.
 * Returns null if no enabled rate-limit policy exists.
 */
export function extractRateLimitPolicy(policies: PolicyRule[]): RateLimitParams | null {
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
  const slPolicy = policies.find((p) => p.type === "spending-limit" && p.enabled);
  if (!slPolicy) return null;

  const config = slPolicy.config as Record<string, unknown>;

  // Handle both canonical and simplified formats
  if (config.maxPerDay !== undefined) {
    return {
      maxPerDay: String(config.maxPerDay),
      maxPerWeek: String(config.maxPerWeek ?? config.maxPerDay),
    };
  }

  // Simplified format: maxAmount/period
  const maxAmount = String(config.maxAmount ?? "0");
  const period = String(config.period ?? "day").toLowerCase();

  const MAX = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
  switch (period) {
    case "day":
    case "daily":
      return { maxPerDay: maxAmount, maxPerWeek: MAX };
    case "week":
    case "weekly":
      return { maxPerDay: MAX, maxPerWeek: maxAmount };
    default:
      return { maxPerDay: maxAmount, maxPerWeek: MAX };
  }
}

// ─── Pre-signing checks ──────────────────────────────────────────────────────

export interface RedisEnforcementResult {
  allowed: boolean;
  reason?: string;
  /** Rate limit headers to include in response */
  headers?: Record<string, string>;
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
  if (!isRedisAvailable()) return { allowed: true };

  const rlParams = extractRateLimitPolicy(policies);
  if (!rlParams) return { allowed: true };

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
      headers: {
        "X-RateLimit-Limit": String(rlParams.maxTxPerHour),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(Math.ceil(hourlyResult.resetMs / 1000)),
        "Retry-After": String(Math.ceil(hourlyResult.resetMs / 1000)),
      },
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
      headers: {
        "X-RateLimit-Limit": String(rlParams.maxTxPerDay),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(Math.ceil(dailyResult.resetMs / 1000)),
        "Retry-After": String(Math.ceil(dailyResult.resetMs / 1000)),
      },
    };
  }

  return {
    allowed: true,
    headers: {
      "X-RateLimit-Remaining-Hourly": String(hourlyResult.remaining),
      "X-RateLimit-Remaining-Daily": String(dailyResult.remaining),
    },
  };
}

/**
 * Record a spend event after successful vault transaction.
 *
 * For on-chain transactions, converts wei value to approximate USD using
 * a simple ETH price reference. This is for real-time budget tracking,
 * not exact accounting.
 */
export async function recordVaultSpend(
  agentId: string,
  tenantId: string,
  valueWei: string,
  chainId: number,
): Promise<void> {
  if (!isRedisAvailable()) return;

  // Convert wei to ETH, then approximate USD
  // Using a conservative estimate — exact price tracking is out of scope
  // The policy engine's DB-based tracking is the source of truth
  const ethValue = Number(BigInt(valueWei)) / 1e18;

  // For non-zero values, record with chain as the "host"
  if (ethValue > 0) {
    const chainHost = `chain:${chainId}`;
    // Store the raw ETH value as the "USD" amount for now
    // In production, this would integrate with a price oracle
    await recordAgentSpend(agentId, tenantId, ethValue, chainHost);
  }
}
