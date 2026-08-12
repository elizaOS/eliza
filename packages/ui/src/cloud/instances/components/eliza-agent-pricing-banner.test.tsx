/** Verifies shared and dedicated hosting projections in the agents pricing banner. */
// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ElizaAgentPricingBanner } from "./eliza-agent-pricing-banner";

vi.mock("../lib/i18n", () => ({
  useT:
    () =>
    (
      key: string,
      options?: { defaultValue?: string; [name: string]: unknown },
    ) => {
      let value = options?.defaultValue ?? key;
      for (const [name, replacement] of Object.entries(options ?? {})) {
        if (name !== "defaultValue") {
          value = value.replaceAll(`{{${name}}}`, String(replacement));
        }
      }
      return value;
    },
}));

describe("ElizaAgentPricingBanner", () => {
  it("shows zero hosting projection and no balance alarm for an all-shared list", () => {
    render(
      <ElizaAgentPricingBanner
        hostingSummary={{
          sharedCount: 3,
          dedicatedRunningCount: 0,
          dedicatedIdleCount: 0,
          hasAgents: true,
          hasDedicatedHosting: false,
          hourlyHostingCostUsd: 0,
          monthlyHostingCostUsd: 0,
          creditBalanceUsd: 0.25,
          hoursRemaining: null,
          lowBalance: false,
          dedicatedRunningHourlyRateUsd: 0.01,
          dedicatedRunningMonthlyEstimateUsd: 7.2,
          dedicatedIdleHourlyRateUsd: 0.0025,
          dedicatedIdleMonthlyEstimateUsd: 1.8,
          minimumDepositUsd: 0.1,
          lowCreditWarningUsd: 2,
        }}
      />,
    );

    expect(screen.getByText("$0.00/mo hosting")).toBeTruthy();
    expect(
      screen.getByText("3 shared · 0 dedicated running · 0 dedicated idle"),
    ).toBeTruthy();
    expect(screen.queryByText("Low balance")).toBeNull();
    expect(
      screen.getByText(
        "Shared runtime has no continuous hosting charge; model usage is billed separately based on usage.",
      ),
    ).toBeTruthy();

    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });

  it("projects only dedicated hosting in a mixed list", () => {
    render(
      <ElizaAgentPricingBanner
        hostingSummary={{
          sharedCount: 1,
          dedicatedRunningCount: 1,
          dedicatedIdleCount: 1,
          hasAgents: true,
          hasDedicatedHosting: true,
          hourlyHostingCostUsd: 0.0125,
          monthlyHostingCostUsd: 9,
          creditBalanceUsd: 1,
          hoursRemaining: 80,
          lowBalance: true,
          dedicatedRunningHourlyRateUsd: 0.01,
          dedicatedRunningMonthlyEstimateUsd: 7.2,
          dedicatedIdleHourlyRateUsd: 0.0025,
          dedicatedIdleMonthlyEstimateUsd: 1.8,
          minimumDepositUsd: 0.1,
          lowCreditWarningUsd: 2,
        }}
      />,
    );

    expect(screen.getByText("$9.00/mo hosting")).toBeTruthy();
    expect(
      screen.getByText("1 shared · 1 dedicated running · 1 dedicated idle"),
    ).toBeTruthy();
    expect(screen.getByText("Low balance")).toBeTruthy();
  });
});
