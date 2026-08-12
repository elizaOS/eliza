/** Verifies tier-aware hosting copy in the compact agent cost indicator. */
// @vitest-environment jsdom

import { TooltipProvider } from "@elizaos/ui/cloud-ui";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCostBadge } from "./agent-cost-badge";

vi.mock("../lib/i18n", () => ({
  useT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

afterEach(cleanup);

describe("AgentCostBadge", () => {
  it("labels shared runtime as usage-based without a dedicated hosting rate", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <AgentCostBadge
          hostingCost={{
            pricingState: "known",
            rateClass: "shared-usage",
            hourlyRateUsd: 0,
            monthlyEstimateUsd: 0,
          }}
        />
      </TooltipProvider>,
    );

    const label = screen.getByText("Usage-based");
    expect(screen.queryByText("$0.01/hr")).toBeNull();
    expect(label.querySelector("span")?.className).toContain("bg-white/40");

    await user.hover(label);
    expect(
      await screen.findByText(
        "No continuous hosting charge. Model usage is billed separately based on usage.",
      ),
    ).toBeTruthy();
  });

  it("renders unavailable dedicated pricing instead of omitting the badge", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <AgentCostBadge
          hostingCost={{
            pricingState: "unavailable",
            rateClass: "unavailable",
            hourlyRateUsd: null,
            monthlyEstimateUsd: null,
          }}
        />
      </TooltipProvider>,
    );

    const label = screen.getByText("Pricing unavailable");
    expect(label).toBeTruthy();
    await user.hover(label);
    expect(
      await screen.findByText(
        "A continuous hosting estimate is not available for this dedicated agent state.",
      ),
    ).toBeTruthy();
  });

  it("preserves the dedicated running hosting rate", () => {
    render(
      <TooltipProvider>
        <AgentCostBadge
          hostingCost={{
            pricingState: "known",
            rateClass: "running",
            hourlyRateUsd: 0.01,
            monthlyEstimateUsd: 7.2,
          }}
        />
      </TooltipProvider>,
    );

    expect(screen.getByText("$0.01/hr")).toBeTruthy();
    expect(screen.queryByText("Usage-based")).toBeNull();
  });
});
