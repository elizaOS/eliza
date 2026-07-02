/**
 * `/dashboard/analytics` — per-user usage metrics + cost projections.
 *
 * THE "WEEKLY BUG" FIX: the original hardcoded `timeRange = "weekly"` in local
 * state and never read the filter UI, so the `AnalyticsFilters` control (which
 * writes to the URL search params) had no effect — the page always showed the
 * weekly view. The breakdown endpoint only honors a `timeRange` bucket
 * (`daily` | `weekly` | `monthly`; it derives the date range + granularity
 * itself — see `lib/analytics-data.ts`), so the filter UI now drives that param
 * and this page reads it from the URL via `useSearchParams`. Because
 * `timeRange` flows into the react-query key (and the projection horizon is
 * derived from it), changing the filter re-fetches and re-renders.
 */

import { useSearchParams } from "react-router-dom";
import {
  DashboardErrorState,
  DashboardLoadingState,
  PageHeaderProvider,
} from "../../cloud-ui";
import { useCloudT } from "../shell/CloudI18nProvider";
import { AnalyticsPageClient } from "./_components/analytics-page-client";
import {
  useAnalyticsBreakdown,
  useAnalyticsProjections,
} from "./lib/analytics-data";
import {
  projectionPeriodsForRange,
  resolveTimeRangeParam,
} from "./lib/time-range";

export default function AnalyticsPage() {
  const t = useCloudT();
  const [searchParams] = useSearchParams();
  const timeRange = resolveTimeRangeParam(searchParams.get("timeRange"));

  const breakdown = useAnalyticsBreakdown(timeRange);
  const projections = useAnalyticsProjections(
    projectionPeriodsForRange(timeRange),
  );

  if (breakdown.isLoading || projections.isLoading) {
    return (
      <DashboardLoadingState
        label={t("cloud.analytics.loading", {
          defaultValue: "Loading analytics",
        })}
      />
    );
  }

  if (breakdown.error) {
    return <DashboardErrorState message={breakdown.error.message} />;
  }

  if (projections.error) {
    return <DashboardErrorState message={projections.error.message} />;
  }

  if (!breakdown.data || !projections.data) {
    return (
      <DashboardLoadingState
        label={t("cloud.analytics.loading", {
          defaultValue: "Loading analytics",
        })}
      />
    );
  }

  // AnalyticsPageClient sets the page header; this standalone route has no
  // ancestor PageHeaderProvider, so supply one here.
  return (
    <PageHeaderProvider>
      <AnalyticsPageClient
        data={breakdown.data}
        projectionsData={projections.data}
      />
    </PageHeaderProvider>
  );
}
