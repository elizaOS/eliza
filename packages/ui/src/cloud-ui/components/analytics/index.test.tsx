/** Verifies the cloud analytics barrel's runtime exports behave correctly through the public import path. */
// @vitest-environment jsdom

/**
 * Every case imports from "./index" itself — the same entry point cloud
 * consumers use — and drives the real components: CostAlerts alert-branching
 * thresholds, CostInsightsCard runway/currency/badge rendering, and
 * ExportButton callback payloads plus its browser-navigation fallback.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CostAlerts,
  type CostAlertsTrending,
  CostInsightsCard,
  ExportButton,
} from "./index";

afterEach(cleanup);

function trendingFixture(
  overrides: Partial<CostAlertsTrending> = {},
): CostAlertsTrending {
  return {
    currentDailyBurn: 12.5,
    previousDailyBurn: 12,
    burnChangePercent: 4.2,
    projectedMonthlyBurn: 375,
    daysUntilBalanceZero: null,
    monthlyBurnPercent: 30,
    monthlyBurnPercentClamped: 30,
    burnAlertThresholdExceeded: false,
    ...overrides,
  };
}

describe("ExportButton (via analytics barrel)", () => {
  it("simple variant labels the button from the resolved format and reports the full export payload", async () => {
    const onExport = vi.fn();
    const start = new Date("2026-01-15T00:00:00.000Z");
    const end = new Date("2026-02-01T00:00:00.000Z");

    render(
      <ExportButton
        startDate={start}
        endDate={end}
        granularity="day"
        onExport={onExport}
      />,
    );

    const button = screen.getByRole("button", { name: "Export CSV" });
    await userEvent.click(button);

    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onExport).toHaveBeenCalledWith({
      format: "csv",
      type: "timeseries",
      startDate: start,
      endDate: end,
      granularity: "day",
    });
  });

  it("explicit format and type flow into label and payload", async () => {
    const onExport = vi.fn();

    render(
      <ExportButton
        startDate="2026-01-15T00:00:00.000Z"
        endDate="2026-02-01T00:00:00.000Z"
        granularity="week"
        format="json"
        type="providers"
        onExport={onExport}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Export JSON" }));

    expect(onExport).toHaveBeenCalledWith({
      format: "json",
      type: "providers",
      startDate: "2026-01-15T00:00:00.000Z",
      endDate: "2026-02-01T00:00:00.000Z",
      granularity: "week",
    });
  });

  it("without onExport it falls back to navigating the browser to the export endpoint", () => {
    const realLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...realLocation, href: "" },
    });

    try {
      render(
        <ExportButton
          startDate="2026-01-15T00:00:00.000Z"
          endDate="2026-02-01T00:00:00.000Z"
          granularity="day"
          format="excel"
          type="models"
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Export EXCEL" }));

      const target = new URL(window.location.href, "http://localhost/");
      expect(target.pathname).toBe("/api/analytics/export");
      expect(target.searchParams.get("format")).toBe("excel");
      expect(target.searchParams.get("type")).toBe("models");
      expect(target.searchParams.get("granularity")).toBe("day");
      expect(target.searchParams.get("includeMetadata")).toBe("true");
      expect(target.searchParams.get("startDate")).toBe(
        new Date("2026-01-15T00:00:00.000Z").toISOString(),
      );
      expect(target.searchParams.get("endDate")).toBe(
        new Date("2026-02-01T00:00:00.000Z").toISOString(),
      );
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: realLocation,
      });
    }
  });

  it("dropdown variant exposes one menu item per format across all four export groups and wires their payloads", async () => {
    const onExport = vi.fn();
    const start = "2026-03-01T00:00:00.000Z";
    const end = "2026-03-31T23:59:59.000Z";

    render(
      <ExportButton
        startDate={start}
        endDate={end}
        granularity="month"
        variant="dropdown"
        onExport={onExport}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Export data" }));

    const items = await screen.findAllByRole("menuitem");
    expect(items).toHaveLength(12);
    expect(items[0].textContent).toBe("Export as CSV");
    expect(items[4].textContent).toBe("Export as Excel");
    expect(items[8].textContent).toBe("Export as JSON");
    expect(items[11].textContent).toBe("Export as JSON");

    fireEvent.click(items[8]);
    expect(onExport).toHaveBeenLastCalledWith({
      format: "json",
      type: "models",
      startDate: start,
      endDate: end,
      granularity: "month",
    });

    await userEvent.click(screen.getByRole("button", { name: "Export data" }));
    fireEvent.click(screen.getAllByRole("menuitem")[3]);
    expect(onExport).toHaveBeenLastCalledWith({
      format: "csv",
      type: "providers",
      startDate: start,
      endDate: end,
      granularity: "month",
    });
  });
});

describe("CostAlerts (via analytics barrel)", () => {
  it("renders the healthy state when nothing trips", () => {
    render(<CostAlerts costTrending={trendingFixture()} creditBalance={500} />);

    expect(screen.getByText("All good")).toBeTruthy();
    expect(
      screen.getByText("Usage is tracking within healthy thresholds."),
    ).toBeTruthy();
    expect(screen.queryByText("Low Balance")).toBeNull();
  });

  it("raises the low-balance error strictly below 7 days of runway", () => {
    render(
      <CostAlerts
        costTrending={trendingFixture({ daysUntilBalanceZero: 3 })}
        creditBalance={40}
      />,
    );

    expect(screen.getByText("Low Balance")).toBeTruthy();
    expect(
      screen.getByText(
        "You will run out of balance in 3 days at current burn rate. Consider adding funds.",
      ),
    ).toBeTruthy();
  });

  it("does not warn at exactly 7 days of runway", () => {
    render(
      <CostAlerts
        costTrending={trendingFixture({ daysUntilBalanceZero: 7 })}
        creditBalance={90}
      />,
    );

    expect(screen.queryByText("Low Balance")).toBeNull();
    expect(screen.getByText("All good")).toBeTruthy();
  });

  it("warns on burn spikes strictly above 50 percent", () => {
    render(
      <CostAlerts
        costTrending={trendingFixture({ burnChangePercent: 80 })}
        creditBalance={500}
      />,
    );

    expect(screen.getByText("Burn Rate Increased")).toBeTruthy();
    expect(
      screen.getByText(
        "Your daily burn rate increased by 80% compared to yesterday. Monitor usage closely.",
      ),
    ).toBeTruthy();
  });

  it("does not warn at exactly 50 percent burn change", () => {
    render(
      <CostAlerts
        costTrending={trendingFixture({ burnChangePercent: 50 })}
        creditBalance={500}
      />,
    );

    expect(screen.queryByText("Burn Rate Increased")).toBeNull();
  });

  it("reports high projected monthly cost when the alert threshold is exceeded", () => {
    render(
      <CostAlerts
        costTrending={trendingFixture({
          burnAlertThresholdExceeded: true,
          projectedMonthlyBurn: 400.5,
          monthlyBurnPercent: 85.4,
        })}
        creditBalance={470}
      />,
    );

    expect(screen.getByText("High Projected Monthly Cost")).toBeTruthy();
    expect(
      screen.getByText(
        "At current burn rate, you'll spend $400.50 this month, which is 85% of your current balance.",
      ),
    ).toBeTruthy();
  });

  it("renders every tripped alert together in source order", () => {
    render(
      <CostAlerts
        costTrending={trendingFixture({
          daysUntilBalanceZero: 2,
          burnChangePercent: 120,
          burnAlertThresholdExceeded: true,
          projectedMonthlyBurn: 900,
          monthlyBurnPercent: 96,
        })}
        creditBalance={25}
      />,
    );

    const titles = [
      "Low Balance",
      "Burn Rate Increased",
      "High Projected Monthly Cost",
    ].map((title) => screen.getByText(title));
    expect(titles).toHaveLength(3);
    expect(screen.queryByText("All good")).toBeNull();

    let previous: Element | null = null;
    for (const title of titles) {
      if (previous) {
        expect(
          previous.compareDocumentPosition(title) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
      previous = title;
    }
  });
});

describe("CostInsightsCard (via analytics barrel)", () => {
  it("formats burn, projection and balance as USD currency", () => {
    render(
      <CostInsightsCard
        costTrending={trendingFixture({
          currentDailyBurn: 12.5,
          projectedMonthlyBurn: 456.789,
        })}
        creditBalance={1234.5}
      />,
    );

    expect(screen.getByText("$12.50")).toBeTruthy();
    expect(screen.getByText("$456.79")).toBeTruthy();
    expect(screen.getByText("$1,234.50")).toBeTruthy();
  });

  it("labels the runway as Stable when the balance never reaches zero", () => {
    render(
      <CostInsightsCard
        costTrending={trendingFixture({ daysUntilBalanceZero: null })}
        creditBalance={800}
      />,
    );

    expect(screen.getByText("Stable")).toBeTruthy();
  });

  it("collapses sub-day runway below the one-day mark", () => {
    for (const days of [0, 1]) {
      const { unmount } = render(
        <CostInsightsCard
          costTrending={trendingFixture({ daysUntilBalanceZero: days })}
          creditBalance={10}
        />,
      );

      expect(screen.getByText("< 1 day")).toBeTruthy();
      unmount();
    }
  });

  it("shows whole-day runway counts above one day", () => {
    render(
      <CostInsightsCard
        costTrending={trendingFixture({ daysUntilBalanceZero: 17 })}
        creditBalance={300}
      />,
    );

    expect(screen.getByText("17d")).toBeTruthy();
  });

  it("signs the burn-change badge only for increases and embeds a healthy CostAlerts block", () => {
    const { unmount } = render(
      <CostInsightsCard
        costTrending={trendingFixture({
          burnChangePercent: 8.04,
          burnAlertThresholdExceeded: false,
        })}
        creditBalance={600}
      />,
    );

    expect(screen.getByText("+8.0%")).toBeTruthy();
    expect(screen.getByText("All good")).toBeTruthy();
    unmount();

    render(
      <CostInsightsCard
        costTrending={trendingFixture({ burnChangePercent: -2.54 })}
        creditBalance={600}
      />,
    );

    expect(screen.getByText("-2.5%")).toBeTruthy();
  });
});
