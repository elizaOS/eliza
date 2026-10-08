/** Verifies the cost outlook runway label through the package test harness. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CostInsightsCard } from "./cost-insights-card";

const trending = {
  currentDailyBurn: 10,
  previousDailyBurn: 10,
  burnChangePercent: 0,
  projectedMonthlyBurn: 300,
  daysUntilBalanceZero: 1,
  monthlyBurnPercent: 10,
  monthlyBurnPercentClamped: 10,
  burnAlertThresholdExceeded: false,
};

afterEach(() => cleanup());

describe("CostInsightsCard runway", () => {
  it("shows one full day of runway as 1d", () => {
    render(
      <CostInsightsCard
        costTrending={{ ...trending, daysUntilBalanceZero: 1 }}
        creditBalance={10}
      />,
    );
    expect(screen.getByText("1d")).toBeTruthy();
    expect(screen.queryByText("< 1 day")).toBeNull();
    expect(
      screen.getByText(
        "You will run out of balance in 1 day at current burn rate. Consider adding funds.",
      ),
    ).toBeTruthy();
  });

  it("shows a runway under one day as less than 1 day", () => {
    render(
      <CostInsightsCard
        costTrending={{ ...trending, daysUntilBalanceZero: 0 }}
        creditBalance={0}
      />,
    );
    expect(screen.getByText("< 1 day")).toBeTruthy();
    expect(screen.queryByText("0d")).toBeNull();
    expect(
      screen.getByText(
        "You will run out of balance in less than 1 day at current burn rate. Consider adding funds.",
      ),
    ).toBeTruthy();
  });

  it("shows two days of runway as 2d", () => {
    render(
      <CostInsightsCard
        costTrending={{ ...trending, daysUntilBalanceZero: 2 }}
        creditBalance={20}
      />,
    );
    expect(screen.getByText("2d")).toBeTruthy();
    expect(
      screen.getByText(
        "You will run out of balance in 2 days at current burn rate. Consider adding funds.",
      ),
    ).toBeTruthy();
  });
});
