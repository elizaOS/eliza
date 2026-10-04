/**
 * Story group for the cloud analytics components (cost alerts/insights, export).
 */

import type { Meta, StoryObj } from "@storybook/react";
import { CostAlerts } from "../../cloud-ui/components/analytics/cost-alerts";
import { CostInsightsCard } from "../../cloud-ui/components/analytics/cost-insights-card";
import { ExportButton } from "../../cloud-ui/components/analytics/export-button";
import { ThemeComparison } from "./ThemeComparison";

const healthyCostTrending = {
  currentDailyBurn: 4.25,
  burnChangePercent: -8.4,
  daysUntilBalanceZero: null,
  projectedMonthlyBurn: 127.5,
  monthlyBurnPercent: 31,
  monthlyBurnPercentClamped: 31,
  burnAlertThresholdExceeded: false,
};

const warningCostTrending = {
  currentDailyBurn: 28.5,
  burnChangePercent: 66.2,
  daysUntilBalanceZero: 5,
  projectedMonthlyBurn: 855,
  monthlyBurnPercent: 142,
  monthlyBurnPercentClamped: 100,
  burnAlertThresholdExceeded: true,
};

export default {
  title: "Comparisons/Analytics",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export const AnalyticsCostInsightsCard: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "analytics-cost-insights-card",
        name: "CostInsightsCard",
        importPath: 'import { CostInsightsCard } from "@elizaos/ui"',
        render: () => (
          <div style={{ width: "100%" }}>
            <CostInsightsCard
              costTrending={healthyCostTrending}
              creditBalance={410}
            />
          </div>
        ),
      }}
    />
  ),
};

export const AnalyticsCostAlerts: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "analytics-cost-alerts",
        name: "CostAlerts",
        importPath: 'import { CostAlerts } from "@elizaos/ui"',
        render: () => (
          <div style={{ width: "100%" }}>
            <CostAlerts
              costTrending={warningCostTrending}
              creditBalance={110}
            />
          </div>
        ),
      }}
    />
  ),
};

export const AnalyticsExportButton: StoryObj = {
  render: () => (
    <ThemeComparison
      story={{
        id: "analytics-export-button",
        name: "ExportButton",
        importPath: 'import { ExportButton } from "@elizaos/ui"',
        render: () => (
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <ExportButton
              startDate="2026-05-01"
              endDate="2026-05-17"
              granularity="day"
            />
            <ExportButton
              startDate="2026-05-01"
              endDate="2026-05-17"
              granularity="day"
              variant="dropdown"
            />
          </div>
        ),
      }}
    />
  ),
};
