import { DashboardErrorState, DashboardLoadingState } from "@elizaos/ui";
import { useMemo, useState } from "react";
import { Helmet } from "react-helmet-async";
import { useT } from "@/providers/I18nProvider";
import { useRequireAuth } from "../../lib/auth-hooks";
import {
  type AnalyticsBreakdown,
  type AnalyticsProjections,
  type AnalyticsTimeRange,
  useAnalyticsBreakdown,
  useAnalyticsProjections,
} from "../../lib/data/analytics";
import { AnalyticsPageClient } from "./_components/analytics-page-client";

function adaptBreakdown(b: AnalyticsBreakdown) {
  return {
    ...b,
    filters: {
      ...b.filters,
      startDate: new Date(b.filters.startDate),
      endDate: new Date(b.filters.endDate),
    },
    timeSeriesData: b.timeSeriesData.map((p) => ({
      ...p,
      timestamp: new Date(p.timestamp),
    })),
  };
}

function adaptProjections(p: AnalyticsProjections) {
  return {
    ...p,
    historicalData: p.historicalData.map((point) => ({
      ...point,
      timestamp: new Date(point.timestamp),
    })),
    projections: p.projections.map((point) => ({
      ...point,
      timestamp: new Date(point.timestamp),
    })),
  };
}

/** /dashboard/analytics — usage metrics + cost projections. */
export default function AnalyticsPage() {
  const t = useT();
  const { ready, authenticated } = useRequireAuth();
  const [timeRange] = useState<AnalyticsTimeRange>("weekly");
  const breakdown = useAnalyticsBreakdown(timeRange);
  const projections = useAnalyticsProjections(7);

  const adapted = useMemo(() => {
    if (!breakdown.data || !projections.data) return null;
    return {
      data: adaptBreakdown(breakdown.data),
      projectionsData: adaptProjections(projections.data),
    };
  }, [breakdown.data, projections.data]);

  const helmet = (
    <Helmet>
      <title>
        {t("cloud.analytics.metaTitle", { defaultValue: "Analytics" })}
      </title>
      <meta
        name="description"
        content={t("cloud.analytics.metaDescription", {
          defaultValue:
            "View detailed usage statistics, performance metrics, and insights for your AI agents",
        })}
      />
    </Helmet>
  );

  if (
    !ready ||
    (authenticated && (breakdown.isLoading || projections.isLoading))
  ) {
    return (
      <>
        {helmet}
        <DashboardLoadingState
          label={t("cloud.analytics.loading", {
            defaultValue: "Loading analytics",
          })}
        />
      </>
    );
  }

  if (breakdown.error) {
    return (
      <>
        {helmet}
        <DashboardErrorState message={breakdown.error.message} />
      </>
    );
  }

  if (projections.error) {
    return (
      <>
        {helmet}
        <DashboardErrorState message={projections.error.message} />
      </>
    );
  }

  if (!adapted) {
    return (
      <>
        {helmet}
        <DashboardLoadingState
          label={t("cloud.analytics.loading", {
            defaultValue: "Loading analytics",
          })}
        />
      </>
    );
  }

  return (
    <>
      {helmet}
      <AnalyticsPageClient
        data={adapted.data as never}
        projectionsData={adapted.projectionsData as never}
      />
    </>
  );
}
