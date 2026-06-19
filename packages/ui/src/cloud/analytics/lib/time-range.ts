/**
 * Canonical `timeRange` URL-param resolution shared by the analytics filter UI
 * and the page query. The breakdown endpoint only honors these three buckets;
 * see `analytics-data.ts` for the backend contract.
 */

import type { AnalyticsTimeRange } from "@elizaos/cloud-shared/types";

export type { AnalyticsTimeRange };

export const ANALYTICS_TIME_RANGES = [
  "daily",
  "weekly",
  "monthly",
] as const satisfies readonly AnalyticsTimeRange[];

export const DEFAULT_ANALYTICS_TIME_RANGE: AnalyticsTimeRange = "weekly";

/** Projection horizon (in days) per time-range bucket. */
const PROJECTION_PERIODS: Record<AnalyticsTimeRange, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
};

function isAnalyticsTimeRange(
  value: string | null | undefined,
): value is AnalyticsTimeRange {
  return value === "daily" || value === "weekly" || value === "monthly";
}

/** Resolve a `?timeRange=` query value to a valid bucket (default `weekly`). */
export function resolveTimeRangeParam(
  value: string | null | undefined,
): AnalyticsTimeRange {
  return isAnalyticsTimeRange(value) ? value : DEFAULT_ANALYTICS_TIME_RANGE;
}

/** Projection horizon for a given time-range bucket. */
export function projectionPeriodsForRange(range: AnalyticsTimeRange): number {
  return PROJECTION_PERIODS[range];
}
