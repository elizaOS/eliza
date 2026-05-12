/**
 * Analytics page client component displaying usage metrics, cost insights, and projections.
 * Includes charts, breakdowns by provider and model, and export functionality.
 *
 * @param props - Analytics page configuration
 * @param props.data - Enhanced analytics data including usage and cost metrics
 * @param props.projectionsData - Projected usage and cost data
 */

"use client";

import type { TabItem } from "@elizaos/cloud-ui";
import {
  BrandCard,
  BrandTabsContent,
  BrandTabsResponsive,
  CornerBrackets,
  DashboardPageContainer,
  KeyMetricsGrid,
  useSetPageHeader,
} from "@elizaos/cloud-ui";
import { format } from "date-fns";
import { Activity, BarChart3, CalendarRange, Coins, ShieldCheck, TrendingUp } from "lucide-react";
import type { EnhancedAnalyticsDataDto, ProjectionsDataDto } from "@/types/cloud-api";
import { CostInsightsCard } from "./cost-insights-card";
import { ExportButton } from "./export-button";
import { AnalyticsFilters } from "./filters";
import { ModelBreakdown } from "./model-breakdown";
import { ProjectionsChart } from "./projections-chart";
import { ProviderBreakdown } from "./provider-breakdown";
import { UsageChart } from "./usage-chart";

interface AnalyticsPageClientProps {
  data: EnhancedAnalyticsDataDto;
  projectionsData: ProjectionsDataDto;
}

export function AnalyticsPageClient({ data, projectionsData }: AnalyticsPageClientProps) {
  useSetPageHeader({
    title: "Analytics",
  });

  const analyticsTabs: TabItem[] = [
    { value: "breakdown", label: "Breakdown" },
    {
      value: "projections",
      label: "Projections",
      icon: <TrendingUp className="h-4 w-4" />,
    },
  ];

  const rangeLabel = `${format(data.filters.startDate, "MMM d, yyyy")} → ${format(data.filters.endDate, "MMM d, yyyy")}`;
  const granularityLabel =
    {
      hour: "Hourly",
      day: "Daily",
      week: "Weekly",
      month: "Monthly",
    }[data.filters.granularity] || "Custom";

  const totalTokens = data.overallStats.totalInputTokens + data.overallStats.totalOutputTokens;

  const averageCostPerRequest =
    data.overallStats.totalRequests > 0
      ? data.overallStats.totalCost / data.overallStats.totalRequests
      : 0;

  const averageTokensPerRequest =
    data.overallStats.totalRequests > 0 ? totalTokens / data.overallStats.totalRequests : 0;

  const formatDelta = (value: number | undefined, digits = 1) => {
    if (value === undefined || Number.isNaN(value)) return undefined;
    const rounded = Number(value.toFixed(digits));
    const prefix = rounded > 0 ? "+" : "";
    return `${prefix}${rounded.toFixed(digits)}%`;
  };

  const resolveTrend = (value: number | undefined) => {
    if (value === undefined) return undefined;
    if (value > 0) return "up" as const;
    if (value < 0) return "down" as const;
    return "neutral" as const;
  };

  const trendDelta = {
    requests: data.trends.requestsChange,
    cost: data.trends.costChange,
    successRate: data.trends.successRateChange,
    tokens: data.trends.tokensChange,
  };

  const metrics = [
    {
      label: "Total requests",
      value: data.overallStats.totalRequests.toLocaleString(),
      helper: `${granularityLabel} cadence • ${rangeLabel}`,
      delta:
        trendDelta.requests !== 0
          ? {
              value: formatDelta(trendDelta.requests) ?? "0%",
              trend: resolveTrend(trendDelta.requests),
              label: `vs previous period`,
            }
          : undefined,
      icon: Activity,
      accent: "violet" as const,
    },
    {
      label: "Total cost",
      value: `$${data.overallStats.totalCost.toFixed(2)}`,
      helper: `≈ $${averageCostPerRequest.toFixed(2)} per request`,
      delta:
        trendDelta.cost !== 0
          ? {
              value: formatDelta(trendDelta.cost) ?? "0%",
              trend: resolveTrend(trendDelta.cost),
              label: `vs previous period`,
            }
          : undefined,
      icon: Coins,
      accent: "amber" as const,
    },
    {
      label: "Success rate",
      value: `${(data.overallStats.successRate * 100).toFixed(1)}%`,
      helper: `Ratio of successful completions across ${data.timeSeriesData.length.toLocaleString()} data points`,
      delta:
        trendDelta.successRate !== 0
          ? {
              value: formatDelta(trendDelta.successRate, 2) ?? "0%",
              trend: resolveTrend(trendDelta.successRate),
              label: `vs previous period`,
            }
          : undefined,
      icon: ShieldCheck,
      accent: "emerald" as const,
    },
    {
      label: "Token volume",
      value: totalTokens.toLocaleString(),
      helper: `≈ ${averageTokensPerRequest.toFixed(1)} tokens per request`,
      delta:
        trendDelta.tokens !== 0
          ? {
              value: formatDelta(trendDelta.tokens) ?? "0%",
              trend: resolveTrend(trendDelta.tokens),
              label: `vs previous period`,
            }
          : undefined,
      icon: BarChart3,
      accent: "sky" as const,
    },
  ];

  return (
    <DashboardPageContainer className="space-y-10 lg:space-y-14">
      <section className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between lg:gap-10 pb-2">
        <div className="space-y-5 lg:max-w-3xl">
          <div className="flex flex-wrap items-center gap-2 gap-y-3 text-xs font-medium text-white/60">
            <span className="flex items-center gap-1 rounded-none border border-white/20 bg-white/10 px-3 py-1">
              <CalendarRange className="h-3.5 w-3.5 text-[#FF5800]" />
              {rangeLabel}
            </span>
            <span className="rounded-none border border-white/20 bg-white/10 px-3 py-1">
              Granularity: {granularityLabel}
            </span>
            <span className="rounded-none border border-white/20 bg-white/10 px-3 py-1">
              {data.timeSeriesData.length.toLocaleString()} data points
            </span>
          </div>
        </div>
        <ExportButton
          startDate={data.filters.startDate}
          endDate={data.filters.endDate}
          granularity={data.filters.granularity}
          variant="dropdown"
        />
      </section>
      <div className="space-y-10 lg:space-y-14">
        <section className="space-y-8 lg:space-y-10">
          <BrandCard className="relative">
            <CornerBrackets size="sm" className="opacity-50" />
            <div className="relative z-10 space-y-4">
              <h3 className="text-base font-semibold text-white">Filters</h3>
              <AnalyticsFilters />
            </div>
          </BrandCard>

          <KeyMetricsGrid metrics={metrics} />
        </section>

        <section className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-10">
          <BrandCard className="relative">
            <CornerBrackets size="sm" className="opacity-50" />
            <div className="relative z-10 space-y-4">
              <h3 className="text-base font-semibold text-white">Usage</h3>
              <UsageChart data={data.timeSeriesData} granularity={data.filters.granularity} />
            </div>
          </BrandCard>

          <CostInsightsCard
            costTrending={data.costTrending}
            creditBalance={Number(data.organization.creditBalance)}
          />
        </section>

        <section className="space-y-8 lg:space-y-10">
          <BrandTabsResponsive
            id="analytics-tabs"
            tabs={analyticsTabs}
            defaultValue="breakdown"
            breakpoint="md"
          >
            <BrandTabsContent value="breakdown" className="space-y-8 lg:space-y-10 mb-4">
              <div className="grid gap-8 lg:grid-cols-2 lg:gap-10">
                <ProviderBreakdown providers={data.providerBreakdown} />
                <ModelBreakdown models={data.modelBreakdown} />
              </div>
            </BrandTabsContent>

            <BrandTabsContent value="projections" className="space-y-8 lg:space-y-10">
              <ProjectionsChart data={projectionsData} />
            </BrandTabsContent>
          </BrandTabsResponsive>
        </section>
      </div>
    </DashboardPageContainer>
  );
}
