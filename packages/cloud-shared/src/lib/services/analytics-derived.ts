/**
 * Pure derivation helpers for analytics presentation values.
 *
 * Architecture commandment #3: the client never computes derived values.
 * These helpers run on the server (or in shared isomorphic code) so route
 * handlers can return ready-to-display DTOs.
 */

import type { CostTrending } from "../../db/repositories/usage-records";

const PROJECTED_BURN_ALERT_RATIO = 0.8;

/**
 * Round to one decimal place. Matches the precision the UI displays
 * (e.g. "94.3%"). Avoids degrading UX with integer rounding.
 */
function round1dp(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface CostTrendingDerivedFields {
  /** Projected monthly burn as percent of current balance (0-100). */
  monthlyBurnPercent: number;
  /** Same value clamped to 100 for progress-bar display. */
  monthlyBurnPercentClamped: number;
  /** True when projected monthly burn exceeds 80% of current balance. */
  burnAlertThresholdExceeded: boolean;
}

/**
 * Compute the derived presentation fields for a CostTrending payload.
 * `creditBalance` is the organization's current credit balance.
 */
export function deriveCostTrendingFields(
  costTrending: Pick<CostTrending, "projectedMonthlyBurn">,
  creditBalance: number,
): CostTrendingDerivedFields {
  const balance = Number(creditBalance);
  const monthlyBurnPercent = balance > 0 ? (costTrending.projectedMonthlyBurn / balance) * 100 : 0;
  return {
    monthlyBurnPercent: round1dp(monthlyBurnPercent),
    monthlyBurnPercentClamped: round1dp(Math.min(100, monthlyBurnPercent)),
    burnAlertThresholdExceeded:
      costTrending.projectedMonthlyBurn > balance * PROJECTED_BURN_ALERT_RATIO,
  };
}

/**
 * Convert a 0..1 success rate to a 0..100 percent value rounded to one decimal.
 */
export function toSuccessRatePercent(rate: number): number {
  return round1dp(rate * 100);
}

/**
 * Compute `(numerator / denominator) * 100` rounded to one decimal.
 * Returns 0 when `denominator <= 0` so callers never divide by zero.
 */
export function toRatePercent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return round1dp((numerator / denominator) * 100);
}

export interface DistributionEntry {
  key: string;
  count: number;
  /** Share of total as a 0..100 percent value rounded to one decimal. */
  percent: number;
}

/**
 * Convert a `{ key: count }` map into ordered distribution entries with
 * percentages of the total.
 */
export function toDistribution(counts: Record<string, number>): DistributionEntry[] {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([key, count]) => ({
      key,
      count,
      percent: total > 0 ? round1dp((count / total) * 100) : 0,
    }));
}

export interface RetentionRatePoint {
  cohortDate: string;
  cohortSize: number;
  /** 0..100 percent rounded to one decimal, or null if not yet measurable. */
  d1: number | null;
  d7: number | null;
  d30: number | null;
}

function toRetentionPercent(retained: number | null, cohortSize: number): number | null {
  if (retained === null || cohortSize <= 0) return null;
  return round1dp((retained / cohortSize) * 100);
}

export interface RetentionCohortInput {
  cohort_date: Date | string;
  cohort_size: number;
  d1_retained: number | null;
  d7_retained: number | null;
  d30_retained: number | null;
}

/**
 * Convert raw retention cohort rows into UI-ready percent rates.
 */
export function toRetentionRates(cohorts: RetentionCohortInput[]): RetentionRatePoint[] {
  return cohorts.map((c) => ({
    cohortDate: c.cohort_date instanceof Date ? c.cohort_date.toISOString() : c.cohort_date,
    cohortSize: c.cohort_size,
    d1: toRetentionPercent(c.d1_retained, c.cohort_size),
    d7: toRetentionPercent(c.d7_retained, c.cohort_size),
    d30: toRetentionPercent(c.d30_retained, c.cohort_size),
  }));
}

export interface QuotaUsageDerived {
  /** Used / limit as 0..100 percent rounded to one decimal, null if no limit. */
  usedPercent: number | null;
  /** Same value clamped to 100 for progress-bar widths. */
  usedPercentClamped: number;
}

export function deriveQuotaUsage(used: number, limit: number | null): QuotaUsageDerived {
  if (limit === null || limit <= 0) {
    return { usedPercent: null, usedPercentClamped: 0 };
  }
  const raw = (used / limit) * 100;
  return {
    usedPercent: round1dp(raw),
    usedPercentClamped: round1dp(Math.min(100, raw)),
  };
}
