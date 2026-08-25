/**
 * Pure redemption-balance eligibility policy shared by the HTTP route and its
 * unit tests. Keeping the limit comparison here prevents the UI from offering
 * an amount the create service will deterministically reject.
 */

export interface RedemptionEligibilityInput {
  availableBalance: number;
  minimumRedemptionUsd: number;
  isInCooldown: boolean;
  cooldownEndsAt: Date | null;
  dailyLimitRemaining: number;
}

export interface RedemptionEligibility {
  canRedeem: boolean;
  reason?: string;
}

function nonNegativeUsdToCents(
  value: string | number,
  rounding: "floor" | "ceil",
): number {
  const raw = String(value).trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(raw);
  if (!match) {
    throw new Error(`Invalid non-negative USD amount: ${raw}`);
  }

  const whole = Number(match[1]);
  const fraction = match[2] ?? "";
  const baseCents =
    whole * 100 + Number(fraction.padEnd(2, "0").slice(0, 2) || "0");
  const hasDiscardedValue = /[1-9]/.test(fraction.slice(2));
  const cents =
    rounding === "ceil" && hasDiscardedValue ? baseCents + 1 : baseCents;
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`USD amount exceeds the safe integer range: ${raw}`);
  }
  return cents;
}

/**
 * Compute the spendable daily remainder in whole cents. SQL NUMERIC values
 * arrive as decimal strings; subtracting them as binary Numbers can turn an
 * exact $1.15 remainder into 1.149999… and incorrectly hide one cent in UI.
 */
export function calculateDailyLimitRemaining(
  dailyLimitUsd: number,
  redeemedUsd: string | number,
): number {
  const limitCents = nonNegativeUsdToCents(dailyLimitUsd, "floor");
  // Any sub-cent already redeemed consumes the next spendable cent so the
  // displayed cap can never authorize more than the server-side daily limit.
  const redeemedCents = nonNegativeUsdToCents(redeemedUsd, "ceil");
  return Math.max(0, limitCents - redeemedCents) / 100;
}

export function evaluateRedemptionEligibility({
  availableBalance,
  minimumRedemptionUsd,
  isInCooldown,
  cooldownEndsAt,
  dailyLimitRemaining,
}: RedemptionEligibilityInput): RedemptionEligibility {
  if (availableBalance < minimumRedemptionUsd) {
    return {
      canRedeem: false,
      reason: `Minimum redemption is $${minimumRedemptionUsd.toFixed(2)}. You have $${availableBalance.toFixed(2)} available.`,
    };
  }

  if (isInCooldown) {
    return {
      canRedeem: false,
      reason: `Cooldown active. You can redeem again after ${cooldownEndsAt?.toISOString()}.`,
    };
  }

  if (dailyLimitRemaining <= 0) {
    return {
      canRedeem: false,
      reason: "Daily limit reached. Resets at midnight UTC.",
    };
  }

  if (dailyLimitRemaining < minimumRedemptionUsd) {
    return {
      canRedeem: false,
      reason: `Daily limit remaining ($${dailyLimitRemaining.toFixed(2)}) is below the $${minimumRedemptionUsd.toFixed(2)} minimum redemption. Resets at midnight UTC.`,
    };
  }

  return { canRedeem: true };
}
