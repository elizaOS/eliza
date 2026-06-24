// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// client.getBaseUrl() — the widget builds raw fetch URLs from it (FinancesView
// pattern). Keep the mock minimal: a stable base.
vi.mock("../../../api", () => ({
  client: { getBaseUrl: () => "http://test.local" },
}));

// Spy on the self-signal hook so we can assert the published weight without
// reaching into the store internals.
const { publishHomeAttentionSpy } = vi.hoisted(() => ({
  publishHomeAttentionSpy: vi.fn(),
}));
vi.mock("../../../widgets/home-attention-store", () => ({
  usePublishHomeAttention: (widgetKey: string, weight: number | null) =>
    publishHomeAttentionSpy(widgetKey, weight),
}));

import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import { FinancesAlertsWidget } from "./finances-alerts";
import type { ChatSidebarWidgetProps } from "./types";

// Wire-shape fixtures mirroring the PA money routes (USD floats).
function dashboard(netUsd: number) {
  return { spending: { netUsd }, generatedAt: new Date().toISOString() };
}

function sources(connected: boolean) {
  return {
    sources: connected ? [{ status: "active" }] : [{ status: "disconnected" }],
  };
}

function recurring(charges: Array<Record<string, unknown>>) {
  return { charges };
}

function billDueInDays(label: string, amountUsd: number, days: number) {
  const next = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  return {
    merchantNormalized: label.toLowerCase(),
    merchantDisplay: label,
    cadence: "monthly",
    averageAmountUsd: amountUsd,
    nextExpectedAt: next,
    category: null,
  };
}

/** Route raw fetch() to the right wire fixture by path. */
function mockFetch(map: {
  dashboard: unknown;
  recurring: unknown;
  sources: unknown;
}) {
  return vi.fn(async (url: string) => {
    const body = url.includes("/dashboard")
      ? map.dashboard
      : url.includes("/recurring")
        ? map.recurring
        : map.sources;
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response;
  });
}

const fetchProps: ChatSidebarWidgetProps = {
  events: [],
  clearEvents: () => undefined,
};

describe("FinancesAlertsWidget (#9143)", () => {
  beforeEach(() => {
    publishHomeAttentionSpy.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders an overdrawn escalation row and bills due within 7 days", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        dashboard: dashboard(-42.5),
        recurring: recurring([
          billDueInDays("Netflix", 15.99, 3),
          billDueInDays("Rent", 1200, 5),
          billDueInDays("FarAway", 9.99, 30), // outside the 7-day window
        ]),
        sources: sources(true),
      }),
    );

    render(<FinancesAlertsWidget {...fetchProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-finances-alerts")).toBeTruthy();
    });

    const widget = screen.getByTestId("chat-widget-finances-alerts");
    expect(widget.textContent).toContain("Overdrawn");
    expect(widget.textContent).toContain("Netflix");
    expect(widget.textContent).toContain("Rent");
    // Bill outside the window is hidden.
    expect(widget.textContent).not.toContain("FarAway");

    // Overdrawn dominates -> escalation weight published.
    expect(publishHomeAttentionSpy).toHaveBeenLastCalledWith(
      "finances/finances.alerts",
      HOME_SIGNAL_WEIGHTS.escalation,
    );
  });

  it("publishes a reminder weight when bills are due but balance is healthy", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        dashboard: dashboard(500),
        recurring: recurring([billDueInDays("Spotify", 9.99, 2)]),
        sources: sources(true),
      }),
    );

    render(<FinancesAlertsWidget {...fetchProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-finances-alerts")).toBeTruthy();
    });

    expect(
      screen.getByTestId("chat-widget-finances-alerts").textContent,
    ).not.toContain("Overdrawn");
    expect(publishHomeAttentionSpy).toHaveBeenLastCalledWith(
      "finances/finances.alerts",
      HOME_SIGNAL_WEIGHTS.reminder,
    );
  });

  it("renders null when balance is healthy and no bills are due within 7 days", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        dashboard: dashboard(500),
        recurring: recurring([billDueInDays("FarAway", 9.99, 30)]),
        sources: sources(true),
      }),
    );

    const { container } = render(<FinancesAlertsWidget {...fetchProps} />);

    // Let the fetch resolve.
    await waitFor(() => {
      expect(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThan(0);
    });
    await Promise.resolve();

    expect(screen.queryByTestId("chat-widget-finances-alerts")).toBeNull();
    expect(container.firstChild).toBeNull();
    // No urgent state -> clears its attention (weight null).
    expect(publishHomeAttentionSpy).toHaveBeenLastCalledWith(
      "finances/finances.alerts",
      null,
    );
  });

  it("renders null when there is no connected source even if overdrawn", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        dashboard: dashboard(-100),
        recurring: recurring([billDueInDays("Netflix", 15.99, 3)]),
        sources: sources(false),
      }),
    );

    const { container } = render(<FinancesAlertsWidget {...fetchProps} />);
    await waitFor(() => {
      expect(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThan(0);
    });
    await Promise.resolve();

    expect(screen.queryByTestId("chat-widget-finances-alerts")).toBeNull();
    expect(container.firstChild).toBeNull();
  });
});
