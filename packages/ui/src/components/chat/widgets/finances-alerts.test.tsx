// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Auth gate (#11084) — mutable so tests can flip the session state. Default
// authenticated so the pre-gate behavior tests exercise the live poll path.
const { authMock } = vi.hoisted(() => ({
  authMock: { authenticated: true },
}));
vi.mock("../../../hooks/useAuthStatus", () => ({
  useIsAuthenticated: () => authMock.authenticated,
}));

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

// useWidgetNavigation → reportUserViewSwitch (from the slash-command controller);
// stub it so the click test isolates the navigation rail (the CustomEvent).
vi.mock("../../../chat/useSlashCommandController", () => ({
  reportUserViewSwitch: vi.fn(),
}));

import { fireEvent } from "@testing-library/react";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import { FinancesAlertsWidget } from "./finances-alerts";

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

const fetchProps: Partial<WidgetProps> = { slot: "home" };

describe("FinancesAlertsWidget (#9143)", () => {
  beforeEach(() => {
    authMock.authenticated = true;
    publishHomeAttentionSpy.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows ONE high-priority datum — the overdrawn balance — when overdrawn (minimal, icon-first)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        dashboard: dashboard(-42.5),
        recurring: recurring([
          billDueInDays("Netflix", 15.99, 3),
          billDueInDays("Rent", 1200, 5),
        ]),
        sources: sources(true),
      }),
    );

    render(<FinancesAlertsWidget {...fetchProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-finances-alerts")).toBeTruthy();
    });

    const widget = screen.getByTestId("chat-widget-finances-alerts");
    // The card is a button (whole-card clickable) and minimal: overdrawn wins,
    // the bill list is NOT shown (only the single highest-priority datum).
    expect(widget.tagName).toBe("BUTTON");
    expect(widget.textContent).toContain("Overdrawn");
    expect(widget.textContent).not.toContain("Netflix");
    expect(widget.textContent).not.toContain("Rent");
    // The full meaning lives in the aria-label since visible text is minimal.
    expect(widget.getAttribute("aria-label")).toMatch(/overdrawn/i);

    // Overdrawn dominates -> escalation weight published.
    expect(publishHomeAttentionSpy).toHaveBeenLastCalledWith(
      "finances/finances.alerts",
      HOME_SIGNAL_WEIGHTS.escalation,
    );
  });

  it("shows the soonest bill (minimal) + reminder weight when balance is healthy", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        dashboard: dashboard(500),
        recurring: recurring([
          billDueInDays("Spotify", 9.99, 2),
          billDueInDays("Gym", 40, 6),
        ]),
        sources: sources(true),
      }),
    );

    render(<FinancesAlertsWidget {...fetchProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-finances-alerts")).toBeTruthy();
    });

    const widget = screen.getByTestId("chat-widget-finances-alerts");
    expect(widget.textContent).not.toContain("Overdrawn");
    // The soonest bill is the single datum shown; the count is a badge.
    expect(widget.textContent).toContain("Spotify");
    expect(widget.textContent).toContain("2 due");
    expect(publishHomeAttentionSpy).toHaveBeenLastCalledWith(
      "finances/finances.alerts",
      HOME_SIGNAL_WEIGHTS.reminder,
    );
  });

  it("navigates to the Finances view when the card is clicked", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        dashboard: dashboard(-10),
        recurring: recurring([]),
        sources: sources(true),
      }),
    );
    const navEvents: string[] = [];
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ viewPath?: string }>).detail;
      if (detail?.viewPath) navEvents.push(detail.viewPath);
    };
    window.addEventListener("eliza:navigate:view", onNav);

    render(<FinancesAlertsWidget {...fetchProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-finances-alerts")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("chat-widget-finances-alerts"));
    window.removeEventListener("eliza:navigate:view", onNav);

    expect(navEvents).toContain("/finances");
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

  it("applies the host-supplied spanClassName to its single root grid-item element (#11752)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        dashboard: dashboard(-42.5),
        recurring: recurring([]),
        sources: sources(true),
      }),
    );

    const { container } = render(
      <FinancesAlertsWidget
        {...fetchProps}
        spanClassName="col-span-2 row-span-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-finances-alerts")).toBeTruthy();
    });
    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    expect(root?.className).toContain("col-span-2");
    expect(root?.className).toContain("row-span-1");
    expect(
      root?.querySelector('[data-testid="chat-widget-finances-alerts"]'),
    ).not.toBeNull();
  });

  it("falls back to the default 2x1 span when no spanClassName is supplied (#11752)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        dashboard: dashboard(-42.5),
        recurring: recurring([]),
        sources: sources(true),
      }),
    );

    const { container } = render(<FinancesAlertsWidget {...fetchProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-finances-alerts")).toBeTruthy();
    });
    expect(container.firstElementChild?.className).toContain("col-span-2");
  });
});
