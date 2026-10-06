import { useSearchParams } from "react-router-dom";
import {
  DashboardErrorState,
  DashboardLoadingState,
} from "../../cloud-ui/components/dashboard/route-placeholders";
import { EnsurePageHeaderProvider } from "../../cloud-ui/components/layout/page-header-context";
import { useCloudT } from "../shell/CloudI18nProvider";
import {
  useAnalyticsBreakdown,
  useAnalyticsProjections,
} from "./analytics-data";
import { AnalyticsPageClient } from "./analytics-page-client";
import { projectionPeriodsForRange, resolveTimeRangeParam } from "./time-range";

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

  // AnalyticsPageClient sets the page header. Inside the ConsoleShell its
  // provider already exists and drives the top-bar title;
  // EnsurePageHeaderProvider defers to it (supplying one only for the
  // standalone/native mount) so the title reaches the shell header rather than
  // a shadowed inner provider.
  return (
    <EnsurePageHeaderProvider>
      <AnalyticsPageClient
        data={breakdown.data}
        projectionsData={projections.data}
      />
    </EnsurePageHeaderProvider>
  );
}
