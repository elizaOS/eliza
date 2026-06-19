/**
 * Analytics data hooks for the app-hosted Eliza Cloud analytics view.
 *
 * Ported from `@elizaos/cloud-frontend/src/lib/data/analytics.ts` and rewired
 * onto the shared cloud infra under `@elizaos/ui/cloud`:
 *   - typed `api<T>` client     → `../../lib/api-client`
 *   - canonical response DTOs   → `@elizaos/cloud-shared/types`
 *   - auth-query gate           → `./auth-query` (consumes the cloud shell's
 *                                 LocalStewardAuthContext)
 *
 * The response shapes are the canonical `EnhancedAnalyticsDataDto` /
 * `ProjectionsDataDto` from cloud-shared — we do not hand-roll local interfaces.
 * `DateLike` fields arrive over the wire as ISO strings; `Page.tsx` adapts them
 * to `Date` before rendering.
 *
 * Backend contract (see `packages/cloud-api/analytics/{breakdown,projections}`):
 *   - GET /api/analytics/breakdown  accepts ONLY `timeRange`
 *     (`daily` | `weekly` | `monthly`); it derives startDate/endDate/granularity
 *     server-side. It does NOT honor arbitrary `startDate`/`endDate`/
 *     `granularity` query params — only `/api/analytics/export` does.
 *   - GET /api/analytics/projections accepts ONLY `periods` (1..90).
 * The query keys therefore depend on exactly the params the backend reads, so
 * changing the filter re-fetches with the honored parameter.
 */

import type {
  AnalyticsTimeRange,
  EnhancedAnalyticsDataDto,
  ProjectionsDataDto,
} from "@elizaos/cloud-shared/types";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api-client";
import { authenticatedQueryKey, useAuthenticatedQueryGate } from "./auth-query";

export type { AnalyticsTimeRange };

interface AnalyticsBreakdownEnvelope {
  success: boolean;
  data: EnhancedAnalyticsDataDto;
}

interface AnalyticsProjectionsEnvelope {
  success: boolean;
  data: ProjectionsDataDto;
}

/**
 * GET /api/analytics/breakdown — full analytics shape consumed by
 * `AnalyticsPageClient`: time series, trends, provider/model breakdowns, cost
 * trending, and the org credit balance. Re-filters whenever `timeRange`
 * changes (the only filter the breakdown endpoint honors).
 */
export function useAnalyticsBreakdown(
  timeRange: AnalyticsTimeRange = "weekly",
) {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(
      ["analytics", "breakdown", timeRange],
      gate,
    ),
    queryFn: () =>
      api<AnalyticsBreakdownEnvelope>(
        `/api/analytics/breakdown?timeRange=${timeRange}`,
      ).then((r) => r.data),
    enabled: gate.enabled,
  });
}

/**
 * GET /api/analytics/projections — cost projections + alerts based on the last
 * 30 days of usage. `periods` is the projection horizon (clamped 1..90 by the
 * backend) and is reflected in the query key so the chart re-fetches when it
 * changes.
 */
export function useAnalyticsProjections(periods = 7) {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(
      ["analytics", "projections", periods],
      gate,
    ),
    queryFn: () =>
      api<AnalyticsProjectionsEnvelope>(
        `/api/analytics/projections?periods=${periods}`,
      ).then((r) => r.data),
    enabled: gate.enabled,
  });
}
