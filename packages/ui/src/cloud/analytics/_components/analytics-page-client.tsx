/**
 * Analytics page client: usage metrics, cost insights, breakdowns, projections,
 * and filter-aware export.
 *
 * @param props.data - Enhanced analytics data (usage + cost metrics).
 * @param props.projectionsData - Projected usage + cost data.
 */

"use client";

import type {
  EnhancedAnalyticsDataDto,
  ProjectionsDataDto,
} from "@elizaos/cloud-shared/types";
import { format } from "date-fns";
import {
  Activity,
  BarChart3,
  CalendarRange,
  Coins,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import {
  BrandCard,
  BrandTabsContent,
  BrandTabsResponsive,
  CornerBrackets,
  CostInsightsCard,
  DashboardPageContainer,
  ExportButton,
  KeyMetricsGrid,
  type TabItem,
  useSetPageHeader,
} from "../../../cloud-ui";
import { useCloudT } from "../../shell/CloudI18nProvider";
import { toSuccessRatePercent } from "../lib/format";
import { AnalyticsFilters } from "./filters";
import { ModelBreakdown } from "./model-breakdown";
import { ProjectionsChart } from "./projections-chart";
import { ProviderBreakdown } from "./provider-breakdown";
import { UsageChart } from "./usage-chart";

interface AnalyticsPageClientProps {
  data: EnhancedAnalyticsDataDto;
  projectionsData: ProjectionsDataDto;
}

export function AnalyticsPageClient({
  data,
  projectionsData,
}: AnalyticsPageClientProps) {
  const t = useCloudT();
  useSetPageHeader({
    title: t("cloud.analytics.pageTitle", { defaultValue: "Analytics" }),
  });

  const analyticsTabs: TabItem[] = [
    {
      value: "breakdown",
      label: t("cloud.analytics.tab.breakdown", { defaultValue: "Breakdown" }),
    },
    {
      value: "projections",
      label: t("cloud.analytics.tab.projections", {
        defaultValue: "Projections",
      }),
      icon: <TrendingUp className="h-4 w-4" />,
    },
  ];

  const rangeLabel = `${format(new Date(data.filters.startDate), "MMM d, yyyy")} → ${format(new Date(data.filters.endDate), "MMM d, yyyy")}`;
  const granularityLabel =
    {
      hour: t("cloud.analytics.filters.hourly", { defaultValue: "Hourly" }),
      day: t("cloud.analytics.filters.daily", { defaultValue: "Daily" }),
      week: t("cloud.analytics.filters.weekly", { defaultValue: "Weekly" }),
      month: t("cloud.analytics.filters.monthly", { defaultValue: "Monthly" }),
    }[data.filters.granularity] ||
    t("cloud.analytics.custom", { defaultValue: "Custom" });

  const totalTokens =
    data.overallStats.totalInputTokens + data.overallStats.totalOutputTokens;

  const averageCostPerRequest =
    data.overallStats.totalRequests > 0
      ? data.overallStats.totalCost / data.overallStats.totalRequests
      : 0;

  const averageTokensPerRequest =
    data.overallStats.totalRequests > 0
      ? totalTokens / data.overallStats.totalRequests
      : 0;

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

  const vsPrev = t("cloud.analytics.vsPreviousPeriod", {
    defaultValue: "vs previous period",
  });
  const metrics = [
    {
      label: t("cloud.analytics.metric.totalRequests", {
        defaultValue: "Total requests",
      }),
      value: data.overallStats.totalRequests.toLocaleString(),
      helper: t("cloud.analytics.metric.cadenceHelper", {
        defaultValue: "{{cadence}} cadence • {{range}}",
        cadence: granularityLabel,
        range: rangeLabel,
      }),
      delta:
        trendDelta.requests !== 0
          ? {
              value: formatDelta(trendDelta.requests) ?? "0%",
              trend: resolveTrend(trendDelta.requests),
              label: vsPrev,
            }
          : undefined,
      icon: Activity,
      accent: "amber" as const,
    },
    {
      label: t("cloud.analytics.metric.totalCost", {
        defaultValue: "Total cost",
      }),
      value: `$${data.overallStats.totalCost.toFixed(2)}`,
      helper: t("cloud.analytics.metric.perRequest", {
        defaultValue: "≈ $" + "{{c}} per request",
        c: averageCostPerRequest.toFixed(2),
      }),
      delta:
        trendDelta.cost !== 0
          ? {
              value: formatDelta(trendDelta.cost) ?? "0%",
              trend: resolveTrend(trendDelta.cost),
              label: vsPrev,
            }
          : undefined,
      icon: Coins,
      accent: "amber" as const,
    },
    {
      label: t("cloud.analytics.metric.successRate", {
        defaultValue: "Success rate",
      }),
      value: `${toSuccessRatePercent(data.overallStats.successRate).toFixed(1)}%`,
      helper: t("cloud.analytics.metric.successRateHelper", {
        defaultValue:
          "Ratio of successful completions across {{n}} data points",
        n: data.timeSeriesData.length.toLocaleString(),
      }),
      delta:
        trendDelta.successRate !== 0
          ? {
              value: formatDelta(trendDelta.successRate, 2) ?? "0%",
              trend: resolveTrend(trendDelta.successRate),
              label: vsPrev,
            }
          : undefined,
      icon: ShieldCheck,
      accent: "emerald" as const,
    },
    {
      label: t("cloud.analytics.metric.tokenVolume", {
        defaultValue: "Token volume",
      }),
      value: totalTokens.toLocaleString(),
      helper: t("cloud.analytics.metric.tokensPerRequest", {
        defaultValue: "≈ {{n}} tokens per request",
        n: averageTokensPerRequest.toFixed(1),
      }),
      delta:
        trendDelta.tokens !== 0
          ? {
              value: formatDelta(trendDelta.tokens) ?? "0%",
              trend: resolveTrend(trendDelta.tokens),
              label: vsPrev,
            }
          : undefined,
      icon: BarChart3,
      accent: "amber" as const,
    },
  ];

  return (
    <DashboardPageContainer className="space-y-10 lg:space-y-14">
      <section className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between lg:gap-10 pb-2">
        <div className="space-y-5 lg:max-w-3xl">
          <div className="flex flex-wrap items-center gap-2 gap-y-3 text-xs font-medium text-white/60">
            <span className="flex items-center gap-1 rounded-sm border border-white/20 bg-white/10 px-3 py-1">
              <CalendarRange className="h-3.5 w-3.5 text-[#FF5800]" />
              {rangeLabel}
            </span>
            <span className="rounded-sm border border-white/20 bg-white/10 px-3 py-1">
              {t("cloud.analytics.granularityLabel", {
                defaultValue: "Granularity",
              })}
              : {granularityLabel}
            </span>
            <span className="rounded-sm border border-white/20 bg-white/10 px-3 py-1">
              {t("cloud.analytics.dataPointsCount", {
                defaultValue: "{{n}} data points",
                n: data.timeSeriesData.length.toLocaleString(),
              })}
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
              <h3 className="text-base font-semibold text-white">
                {t("cloud.analytics.filtersTitle", { defaultValue: "Filters" })}
              </h3>
              <AnalyticsFilters />
            </div>
          </BrandCard>

          <KeyMetricsGrid metrics={metrics} />
        </section>

        <section className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-10">
          <BrandCard className="relative">
            <CornerBrackets size="sm" className="opacity-50" />
            <div className="relative z-10 space-y-4">
              <h3 className="text-base font-semibold text-white">
                {t("cloud.analytics.usageTitle", { defaultValue: "Usage" })}
              </h3>
              <UsageChart
                data={data.timeSeriesData}
                granularity={data.filters.granularity}
              />
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
            <BrandTabsContent
              value="breakdown"
              className="space-y-8 lg:space-y-10 mb-4"
            >
              <div className="grid gap-8 lg:grid-cols-2 lg:gap-10">
                <ProviderBreakdown providers={data.providerBreakdown} />
                <ModelBreakdown models={data.modelBreakdown} />
              </div>
            </BrandTabsContent>

            <BrandTabsContent
              value="projections"
              className="space-y-8 lg:space-y-10"
            >
              <ProjectionsChart data={projectionsData} />
            </BrandTabsContent>
          </BrandTabsResponsive>
        </section>
      </div>
    </DashboardPageContainer>
  );
}
