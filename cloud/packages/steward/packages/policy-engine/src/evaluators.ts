import {
  type AllowedChainsConfig,
  type ApprovedAddressesConfig,
  type AutoApproveConfig,
  type PolicyResult,
  type PolicyRule,
  type PriceOracle,
  type RateLimitConfig,
  type SignRequest,
  type SpendingLimitConfig,
  type TimeWindowConfig,
  toCaip2,
} from "@stwd/shared";
import { evaluateReputationScaling } from "./evaluators/reputation-scaling";
import { evaluateReputationThreshold } from "./evaluators/reputation-threshold";

export interface EvaluatorContext {
  request: SignRequest;
  recentTxCount24h: number;
  recentTxCount1h: number;
  spentToday: bigint;
  spentThisWeek: bigint;
  /** Optional price oracle for USD-based policy evaluation */
  priceOracle?: PriceOracle;
  /** Optional reputation score for reputation-based policies */
  reputationScore?: number;
}

/**
 * Evaluate a single policy rule against a transaction request.
 * Returns pass/fail with reason.
 *
 * Now async to support USD-based evaluations that need price lookups.
 */
export async function evaluatePolicy(
  rule: PolicyRule,
  ctx: EvaluatorContext,
): Promise<PolicyResult> {
  if (!rule.enabled) {
    return {
      policyId: rule.id,
      type: rule.type,
      passed: true,
      reason: "Policy disabled",
    };
  }

  switch (rule.type) {
    case "spending-limit":
      return evaluateSpendingLimit(rule, ctx);
    case "approved-addresses":
      return evaluateApprovedAddresses(rule, ctx);
    case "auto-approve-threshold":
      return evaluateAutoApprove(rule, ctx);
    case "rate-limit":
      return evaluateRateLimit(rule, ctx);
    case "time-window":
      return evaluateTimeWindow(rule, ctx);
    case "allowed-chains":
      return evaluateAllowedChains(rule, ctx);
    case "reputation-threshold":
      return evaluateReputationThreshold(rule, {
        reputationScore: ctx.reputationScore,
      });
    case "reputation-scaling":
      return evaluateReputationScaling(rule, {
        reputationScore: ctx.reputationScore,
        txValue: BigInt(ctx.request.value),
      });
    default:
      return {
        policyId: rule.id,
        type: rule.type,
        passed: false,
        reason: `Unknown policy type: ${rule.type}`,
      };
  }
}

/**
 * Normalize spending-limit config to the canonical format (maxPerTx/maxPerDay/maxPerWeek).
 * Accepts both the canonical format and the simplified maxAmount/period format.
 */
function normalizeSpendingLimitConfig(config: Record<string, unknown>): SpendingLimitConfig {
  // Use a very large default for unrestricted limits
  const MAX_UINT = "115792089237316195423570985008687907853269984665640564039457584007913129639935";

  // If already in canonical format (has any of the standard fields), fill in missing with MAX_UINT
  if (config.maxPerTx !== undefined || config.maxPerTxUsd !== undefined) {
    return {
      maxPerTx: config.maxPerTx !== undefined ? String(config.maxPerTx) : MAX_UINT,
      maxPerDay: config.maxPerDay !== undefined ? String(config.maxPerDay) : MAX_UINT,
      maxPerWeek: config.maxPerWeek !== undefined ? String(config.maxPerWeek) : MAX_UINT,
      maxPerTxUsd: config.maxPerTxUsd as number | undefined,
      maxPerDayUsd: config.maxPerDayUsd as number | undefined,
      maxPerWeekUsd: config.maxPerWeekUsd as number | undefined,
    };
  }

  // Also check if any USD field is present
  if (config.maxPerDayUsd !== undefined || config.maxPerWeekUsd !== undefined) {
    return {
      maxPerTx: MAX_UINT,
      maxPerDay: MAX_UINT,
      maxPerWeek: MAX_UINT,
      maxPerTxUsd: config.maxPerTxUsd as number | undefined,
      maxPerDayUsd: config.maxPerDayUsd as number | undefined,
      maxPerWeekUsd: config.maxPerWeekUsd as number | undefined,
    };
  }

  // Convert from maxAmount/period format
  const maxAmount = String(config.maxAmount ?? "0");
  const period = String(config.period ?? "day").toLowerCase();

  switch (period) {
    case "tx":
    case "transaction":
      return { maxPerTx: maxAmount, maxPerDay: MAX_UINT, maxPerWeek: MAX_UINT };
    case "day":
    case "daily":
      return {
        maxPerTx: maxAmount,
        maxPerDay: maxAmount,
        maxPerWeek: MAX_UINT,
      };
    case "week":
    case "weekly":
      return {
        maxPerTx: maxAmount,
        maxPerDay: MAX_UINT,
        maxPerWeek: maxAmount,
      };
    default:
      // Fallback: treat as per-tx limit
      return { maxPerTx: maxAmount, maxPerDay: MAX_UINT, maxPerWeek: MAX_UINT };
  }
}

/**
 * Check if the spending limit config has any USD-based limits.
 */
function hasUsdLimits(config: SpendingLimitConfig): boolean {
  return (
    config.maxPerTxUsd !== undefined ||
    config.maxPerDayUsd !== undefined ||
    config.maxPerWeekUsd !== undefined
  );
}

async function evaluateSpendingLimit(
  rule: PolicyRule,
  ctx: EvaluatorContext,
): Promise<PolicyResult> {
  const config = normalizeSpendingLimitConfig(rule.config);
  const txValue = BigInt(ctx.request.value);
  const base = { policyId: rule.id, type: rule.type } as const;

  // ── USD-based evaluation (preferred when available) ─────────────────────────
  if (hasUsdLimits(config) && ctx.priceOracle) {
    const chainId = ctx.request.chainId;
    const txUsd = await ctx.priceOracle.weiToUsd(ctx.request.value, chainId);

    if (txUsd !== null) {
      // Per-transaction USD limit
      if (config.maxPerTxUsd !== undefined && txUsd > config.maxPerTxUsd) {
        return {
          ...base,
          passed: false,
          reason: `Transaction value $${txUsd.toFixed(2)} exceeds per-tx USD limit $${config.maxPerTxUsd}`,
        };
      }

      // Daily USD limit — convert spentToday from wei to USD
      if (config.maxPerDayUsd !== undefined) {
        const spentTodayUsd = await ctx.priceOracle.weiToUsd(ctx.spentToday.toString(), chainId);
        if (spentTodayUsd !== null) {
          if (spentTodayUsd + txUsd > config.maxPerDayUsd) {
            return {
              ...base,
              passed: false,
              reason: `Would exceed daily USD spending limit $${config.maxPerDayUsd} (spent today: $${spentTodayUsd.toFixed(2)} + this tx: $${txUsd.toFixed(2)})`,
            };
          }
        }
      }

      // Weekly USD limit — convert spentThisWeek from wei to USD
      if (config.maxPerWeekUsd !== undefined) {
        const spentWeekUsd = await ctx.priceOracle.weiToUsd(ctx.spentThisWeek.toString(), chainId);
        if (spentWeekUsd !== null) {
          if (spentWeekUsd + txUsd > config.maxPerWeekUsd) {
            return {
              ...base,
              passed: false,
              reason: `Would exceed weekly USD spending limit $${config.maxPerWeekUsd} (spent this week: $${spentWeekUsd.toFixed(2)} + this tx: $${txUsd.toFixed(2)})`,
            };
          }
        }
      }

      return { ...base, passed: true };
    }

    // Price unavailable — fall through to wei comparison with a warning
    console.warn(
      `[policy] USD price unavailable for chain ${chainId}, falling back to wei comparison`,
    );
  }

  // ── Wei-based evaluation (legacy / fallback) ────────────────────────────────
  if (config.maxPerTx && txValue > BigInt(config.maxPerTx)) {
    return {
      ...base,
      passed: false,
      reason: `Transaction value ${txValue} exceeds per-tx limit ${config.maxPerTx}`,
    };
  }

  if (config.maxPerDay && ctx.spentToday + txValue > BigInt(config.maxPerDay)) {
    return {
      ...base,
      passed: false,
      reason: `Would exceed daily spending limit (${config.maxPerDay})`,
    };
  }

  if (config.maxPerWeek && ctx.spentThisWeek + txValue > BigInt(config.maxPerWeek)) {
    return {
      ...base,
      passed: false,
      reason: `Would exceed weekly spending limit (${config.maxPerWeek})`,
    };
  }

  return { ...base, passed: true };
}

function evaluateApprovedAddresses(rule: PolicyRule, ctx: EvaluatorContext): PolicyResult {
  const config = rule.config as unknown as ApprovedAddressesConfig;
  const base = { policyId: rule.id, type: rule.type } as const;
  const target = ctx.request.to.toLowerCase();
  const listed = config.addresses.map((a) => a.toLowerCase());

  if (config.mode === "whitelist") {
    if (!listed.includes(target)) {
      return {
        ...base,
        passed: false,
        reason: `Address ${ctx.request.to} not in whitelist`,
      };
    }
  } else {
    if (listed.includes(target)) {
      return {
        ...base,
        passed: false,
        reason: `Address ${ctx.request.to} is blacklisted`,
      };
    }
  }

  return { ...base, passed: true };
}

async function evaluateAutoApprove(rule: PolicyRule, ctx: EvaluatorContext): Promise<PolicyResult> {
  const config = rule.config as unknown as AutoApproveConfig;
  const base = { policyId: rule.id, type: rule.type } as const;
  const txValue = BigInt(ctx.request.value);

  // ── USD-based threshold (preferred) ─────────────────────────────────────────
  if (config.thresholdUsd !== undefined && ctx.priceOracle) {
    const chainId = ctx.request.chainId;
    const txUsd = await ctx.priceOracle.weiToUsd(ctx.request.value, chainId);

    if (txUsd !== null) {
      if (txUsd <= config.thresholdUsd) {
        return {
          ...base,
          passed: true,
          reason: `$${txUsd.toFixed(2)} is below auto-approve threshold $${config.thresholdUsd}`,
        };
      }
      return {
        ...base,
        passed: false,
        reason: `Value $${txUsd.toFixed(2)} exceeds auto-approve USD threshold $${config.thresholdUsd}`,
      };
    }

    // Price unavailable — fall through to wei if available
    console.warn(
      `[policy] USD price unavailable for chain ${chainId}, falling back to wei threshold`,
    );
  }

  // ── Wei-based threshold (legacy / fallback) ─────────────────────────────────
  if (config.threshold !== undefined) {
    if (txValue <= BigInt(config.threshold)) {
      return { ...base, passed: true, reason: "Below auto-approve threshold" };
    }
    return {
      ...base,
      passed: false,
      reason: `Value ${txValue} exceeds auto-approve threshold ${config.threshold}`,
    };
  }

  // No threshold configured at all — pass (policy misconfigured but don't block)
  return { ...base, passed: true, reason: "No threshold configured" };
}

function evaluateRateLimit(rule: PolicyRule, ctx: EvaluatorContext): PolicyResult {
  const config = rule.config as unknown as RateLimitConfig;
  const base = { policyId: rule.id, type: rule.type } as const;

  if (ctx.recentTxCount1h >= config.maxTxPerHour) {
    return {
      ...base,
      passed: false,
      reason: `Hourly tx limit reached (${config.maxTxPerHour})`,
    };
  }

  if (ctx.recentTxCount24h >= config.maxTxPerDay) {
    return {
      ...base,
      passed: false,
      reason: `Daily tx limit reached (${config.maxTxPerDay})`,
    };
  }

  return { ...base, passed: true };
}

function evaluateTimeWindow(rule: PolicyRule, _ctx: EvaluatorContext): PolicyResult {
  const config = rule.config as unknown as TimeWindowConfig;
  const base = { policyId: rule.id, type: rule.type } as const;
  const now = new Date();
  const hour = now.getUTCHours();
  const day = now.getUTCDay();

  if (config.allowedDays.length > 0 && !config.allowedDays.includes(day)) {
    return {
      ...base,
      passed: false,
      reason: `Transactions not allowed on day ${day}`,
    };
  }

  if (config.allowedHours.length > 0) {
    const inWindow = config.allowedHours.some((w) => hour >= w.start && hour < w.end);
    if (!inWindow) {
      return {
        ...base,
        passed: false,
        reason: `Current hour ${hour} UTC not in allowed windows`,
      };
    }
  }

  return { ...base, passed: true };
}

/**
 * Allowed-chains policy: restricts transactions to a set of permitted CAIP-2 chain identifiers.
 */
function evaluateAllowedChains(rule: PolicyRule, ctx: EvaluatorContext): PolicyResult {
  const config = rule.config as unknown as AllowedChainsConfig;
  const base = { policyId: rule.id, type: rule.type } as const;
  const chainId = ctx.request.chainId;

  if (!chainId) {
    return {
      ...base,
      passed: true,
      reason: "No chainId specified; deferring chain check to vault",
    };
  }

  const caip2 = toCaip2(chainId);
  if (!caip2) {
    return {
      ...base,
      passed: false,
      reason: `Chain ID ${chainId} is not a recognised chain and cannot be verified against the allowed-chains policy`,
    };
  }

  if (!config.chains.includes(caip2)) {
    return {
      ...base,
      passed: false,
      reason: `Chain ${caip2} (chainId ${chainId}) is not in the allowed chains list`,
    };
  }

  return { ...base, passed: true };
}
