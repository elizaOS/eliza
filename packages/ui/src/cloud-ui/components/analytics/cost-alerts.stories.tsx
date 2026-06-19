import type { Meta, StoryObj } from "@storybook/react";
import { CostAlerts } from "./cost-alerts";

const healthyTrending = {
  currentDailyBurn: 12.4,
  previousDailyBurn: 11.8,
  burnChangePercent: 5,
  projectedMonthlyBurn: 372,
  daysUntilBalanceZero: 80,
  monthlyBurnPercent: 12.4,
  monthlyBurnPercentClamped: 12.4,
  burnAlertThresholdExceeded: false,
};

const meta = {
  title: "CloudUI/Analytics/CostAlerts",
  component: CostAlerts,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="min-h-[40vh] bg-black p-8">
        <div className="mx-auto max-w-2xl">
          <Story />
        </div>
      </div>
    ),
  ],
  args: {
    costTrending: healthyTrending,
    creditBalance: 1000,
  },
} satisfies Meta<typeof CostAlerts>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllGood: Story = {};

export const LowBalance: Story = {
  args: {
    costTrending: {
      ...healthyTrending,
      currentDailyBurn: 48,
      previousDailyBurn: 42,
      burnChangePercent: 14,
      projectedMonthlyBurn: 1440,
      daysUntilBalanceZero: 3,
      monthlyBurnPercent: 144,
      monthlyBurnPercentClamped: 100,
      burnAlertThresholdExceeded: true,
    },
    creditBalance: 144,
  },
};

export const BurnRateSpiked: Story = {
  args: {
    costTrending: {
      ...healthyTrending,
      currentDailyBurn: 36,
      previousDailyBurn: 18,
      burnChangePercent: 100,
      projectedMonthlyBurn: 1080,
      daysUntilBalanceZero: 27,
      monthlyBurnPercent: 36,
      monthlyBurnPercentClamped: 36,
      burnAlertThresholdExceeded: false,
    },
    creditBalance: 3000,
  },
};

export const HighProjectedMonthlyCost: Story = {
  args: {
    costTrending: {
      ...healthyTrending,
      currentDailyBurn: 28,
      previousDailyBurn: 26,
      burnChangePercent: 8,
      projectedMonthlyBurn: 840,
      daysUntilBalanceZero: 35,
      monthlyBurnPercent: 84,
      monthlyBurnPercentClamped: 84,
      burnAlertThresholdExceeded: true,
    },
    creditBalance: 1000,
  },
};

export const AllAlertsTriggered: Story = {
  args: {
    costTrending: {
      currentDailyBurn: 65,
      previousDailyBurn: 20,
      burnChangePercent: 225,
      projectedMonthlyBurn: 1950,
      daysUntilBalanceZero: 4,
      monthlyBurnPercent: 195,
      monthlyBurnPercentClamped: 100,
      burnAlertThresholdExceeded: true,
    },
    creditBalance: 260,
  },
};
