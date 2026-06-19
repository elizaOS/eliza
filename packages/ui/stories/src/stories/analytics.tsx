import {
  CostAlerts,
  CostInsightsCard,
  ExportButton,
} from "@ui-src/cloud-ui/components/analytics/index.ts";
import type { StoryDefinition } from "../Story.tsx";

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

export const analyticsStories: StoryDefinition[] = [
  {
    id: "analytics-cost-insights-card",
    name: "CostInsightsCard",
    importPath:
      'import { CostInsightsCard } from "@elizaos/ui/cloud-ui/components/analytics"',
    render: () => (
      <div style={{ width: "100%" }}>
        <CostInsightsCard
          costTrending={healthyCostTrending}
          creditBalance={410}
        />
      </div>
    ),
  },
  {
    id: "analytics-cost-alerts",
    name: "CostAlerts",
    importPath:
      'import { CostAlerts } from "@elizaos/ui/cloud-ui/components/analytics"',
    render: () => (
      <div style={{ width: "100%" }}>
        <CostAlerts costTrending={warningCostTrending} creditBalance={110} />
      </div>
    ),
  },
  {
    id: "analytics-export-button",
    name: "ExportButton",
    importPath:
      'import { ExportButton } from "@elizaos/ui/cloud-ui/components/analytics"',
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
  },
];
