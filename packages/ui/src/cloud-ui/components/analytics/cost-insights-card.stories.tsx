import type { Meta, StoryObj } from "@storybook/react";
import { CostInsightsCard } from "./cost-insights-card";

const baseTrending = {
  currentDailyBurn: 42.18,
  previousDailyBurn: 38.6,
  burnChangePercent: 9.3,
  projectedMonthlyBurn: 1265.4,
  daysUntilBalanceZero: null,
  monthlyBurnPercent: 38.5,
  monthlyBurnPercentClamped: 38.5,
  burnAlertThresholdExceeded: false,
};

const meta = {
  title: "CloudUI/Analytics/CostInsightsCard",
  component: CostInsightsCard,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div
        style={{
          background: "#0a0a0a",
          padding: 24,
          minHeight: "100vh",
          maxWidth: 480,
        }}
      >
        <Story />
      </div>
    ),
  ],
  args: {
    costTrending: baseTrending,
    creditBalance: 3290.55,
  },
} satisfies Meta<typeof CostInsightsCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Healthy: Story = {};

export const BurnRateSpiking: Story = {
  args: {
    costTrending: {
      ...baseTrending,
      currentDailyBurn: 118.42,
      previousDailyBurn: 52.0,
      burnChangePercent: 127.7,
      projectedMonthlyBurn: 3552.6,
      monthlyBurnPercent: 72.4,
      monthlyBurnPercentClamped: 72.4,
    },
    creditBalance: 4905.0,
  },
};

export const ProjectedOverspend: Story = {
  args: {
    costTrending: {
      ...baseTrending,
      currentDailyBurn: 88.0,
      previousDailyBurn: 80.0,
      burnChangePercent: 10.0,
      projectedMonthlyBurn: 2640.0,
      monthlyBurnPercent: 105.6,
      monthlyBurnPercentClamped: 100,
      burnAlertThresholdExceeded: true,
      daysUntilBalanceZero: 28,
    },
    creditBalance: 2500.0,
  },
};

export const LowBalanceCritical: Story = {
  args: {
    costTrending: {
      ...baseTrending,
      currentDailyBurn: 64.5,
      previousDailyBurn: 60.0,
      burnChangePercent: 7.5,
      projectedMonthlyBurn: 1935.0,
      monthlyBurnPercent: 96.8,
      monthlyBurnPercentClamped: 96.8,
      burnAlertThresholdExceeded: true,
      daysUntilBalanceZero: 3,
    },
    creditBalance: 199.42,
  },
};

export const OutOfFundsImminent: Story = {
  args: {
    costTrending: {
      ...baseTrending,
      currentDailyBurn: 220.0,
      previousDailyBurn: 80.0,
      burnChangePercent: 175.0,
      projectedMonthlyBurn: 6600.0,
      monthlyBurnPercent: 220.0,
      monthlyBurnPercentClamped: 100,
      burnAlertThresholdExceeded: true,
      daysUntilBalanceZero: 1,
    },
    creditBalance: 220.0,
  },
};
