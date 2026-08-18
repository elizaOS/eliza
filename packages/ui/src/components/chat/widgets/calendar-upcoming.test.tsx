/** Verifies CalendarUpcomingWidget through the package's configured test harness. */
// @vitest-environment jsdom
//
// CalendarUpcomingWidget self-hide rules: renders nothing (and skips full-shell
// probes) on limited cloud bases, when no Google account is linked, or when there
// are no upcoming events; otherwise shows the single soonest event with a +N
// badge and applies its grid span. jsdom render with the API client mocked.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Auth gate (#11084), mutable so tests can flip the session state. Default
// authenticated so the pre-gate behavior tests exercise the live poll path.
const { authMock } = vi.hoisted(() => ({
  authMock: { authenticated: true },
}));
vi.mock("../../../hooks/useAuthStatus", () => ({
  useIsAuthenticated: () => authMock.authenticated,
}));

import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";

const { getBaseUrlMock, publishMock, fetchMock } = vi.hoisted(() => ({
  getBaseUrlMock: vi.fn(() => "http://localhost"),
  publishMock: vi.fn(),
  fetchMock: vi.fn(),
}));

// Mock the client: getBaseUrl resolves without booting the real ElizaClient,
// and fetch is the native-complete seam for probe + feed hops.
vi.mock("../../../api", () => ({
  client: {
    getBaseUrl: getBaseUrlMock,
    fetch: fetchMock,
  },
}));

// Spy on the self-signal hook to assert the urgent weight is published.
vi.mock("../../../widgets/home-attention-store", () => ({
  usePublishHomeAttention: publishMock,
}));

// useWidgetNavigation → reportUserViewSwitch (from the slash-command controller);
// stub it so the click tests isolate the navigation rail (the CustomEvent).
vi.mock("../../../chat/useSlashCommandController", () => ({
  reportUserViewSwitch: vi.fn(),
}));

import type { WidgetProps } from "../../../widgets/types";
import {
  CALENDAR_FEED_FETCH_TIMEOUT_MS,
  CALENDAR_PROBE_FETCH_TIMEOUT_MS,
  CalendarUpcomingWidget,
  fetchCalendarConnectorAccounts,
  fetchCalendarUpcomingFeed,
} from "./calendar-upcoming";

// Minimal wire event matching LifeOpsCalendarEvent (@elizaos/shared
// contracts/calendar.ts), only the fields the widget reads.
function event(
  overrides: Partial<{
    id: string;
    title: string;
    startAt: string;
    endAt: string;
    isAllDay: boolean;
    location: string;
  }> = {},
) {
  return {
    id: "evt-1",
    title: "Standup",
    startAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    endAt: new Date(Date.now() + 90 * 60_000).toISOString(),
    isAllDay: false,
    location: "",
    ...overrides,
  };
}

function connectedGoogleWithFeed(events: ReturnType<typeof event>[]) {
  fetchMock.mockImplementation(async (path: string) => {
    if (String(path).includes("/api/connectors/")) {
      return {
        accounts: [
          {
            id: "g1",
            provider: "google",
            connectorId: "google",
            label: "Work",
            status: "connected",
          },
        ],
      };
    }
    if (String(path).includes("/api/lifeops/calendar/feed")) {
      return { events };
    }
    return { events: [] };
  });
}

/** No accounts → the probe resolves "disconnected" (connect affordance). */
function disconnectedGoogle() {
  fetchMock.mockImplementation(async (path: string) => {
    if (String(path).includes("/api/connectors/")) {
      return { accounts: [] };
    }
    return { events: [] };
  });
}

// Mirrors the registry declaration: the calendar owns a full-width row.
const homeProps: Partial<WidgetProps> = {
  slot: "home",
  spanClassName: "col-span-4 row-span-1",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  authMock.authenticated = true;
  getBaseUrlMock.mockReset();
  getBaseUrlMock.mockReturnValue("http://localhost");
  publishMock.mockReset();
  fetchMock.mockReset();
});

describe("CalendarUpcomingWidget", () => {
  it("renders nothing and skips full-shell probes on limited cloud agent bases", async () => {
    getBaseUrlMock.mockReturnValue("https://agent-1.elizacloud.ai");
    vi.stubGlobal("fetch", vi.fn());

    const { container } = render(<CalendarUpcomingWidget {...homeProps} />);

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders NOTHING when no Google account is linked, no connect-CTA tile", async () => {
    disconnectedGoogle();
    const { container } = render(<CalendarUpcomingWidget {...homeProps} />);

    // The probe settles to "disconnected" and the widget self-hides; the
    // connect flow lives in Settings → Connectors, not the home grid.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
    expect(
      screen.queryByTestId("chat-widget-calendar-upcoming-connect"),
    ).toBeNull();
  });

  it("renders NOTHING when connected but no upcoming events, the row must earn its place", async () => {
    connectedGoogleWithFeed([
      event({
        id: "past",
        startAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      }),
    ]);
    const { container } = render(<CalendarUpcomingWidget {...homeProps} />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
    expect(screen.queryByTestId("chat-widget-calendar-upcoming")).toBeNull();
  });

  it("shows ONE high-priority datum, the soonest event, with a +N more badge", async () => {
    connectedGoogleWithFeed([
      event({
        id: "a",
        title: "Standup",
        startAt: new Date(Date.now() + 5 * 60 * 60_000).toISOString(),
      }),
      event({
        id: "b",
        title: "Lunch",
        startAt: new Date(Date.now() + 7 * 60 * 60_000).toISOString(),
      }),
    ]);
    render(<CalendarUpcomingWidget {...homeProps} />);

    const widget = await screen.findByTestId("chat-widget-calendar-upcoming");
    expect(widget.tagName).toBe("BUTTON");
    // Only the soonest event renders; later events do not (just a count badge).
    expect(widget.textContent).toContain("Standup");
    expect(widget.textContent).not.toContain("Lunch");
    expect(widget.textContent).toContain("+1");
    expect(widget.getAttribute("aria-label")).toMatch(/Standup/);
    // Sentence-case copy law (spec §copy): "Open calendar.", not "Open Calendar".
    expect(widget.getAttribute("aria-label")).toMatch(/Open calendar/);
  });

  // --- 18h lookahead gate (§B "Up Next", issue #14564) -----------------------
  // The card earns its home slot ONLY when the next event starts within 18h; a
  // more-distant event yields the slot (renders null). "An event next Tuesday is
  // not glanceable urgency." The feed is queried 14d wide, but the render gate
  // is the narrower 18h window.

  it("renders the card when the next event is just inside the 18h gate (17h59m)", async () => {
    connectedGoogleWithFeed([
      event({
        id: "soon",
        title: "Design sync",
        startAt: new Date(Date.now() + (17 * 60 + 59) * 60_000).toISOString(),
      }),
    ]);
    render(<CalendarUpcomingWidget {...homeProps} />);

    const card = await screen.findByTestId("chat-widget-calendar-upcoming");
    expect(card.textContent).toContain("Design sync");
  });

  it("yields its slot (renders null) when the next event is just past the 18h gate (18h01m)", async () => {
    connectedGoogleWithFeed([
      event({
        id: "far",
        title: "Next Tuesday",
        startAt: new Date(Date.now() + (18 * 60 + 1) * 60_000).toISOString(),
      }),
    ]);
    const { container } = render(<CalendarUpcomingWidget {...homeProps} />);

    // The connector probe + feed both run (the event exists), but the card is
    // gated out, no tile occupies the home grid.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
    expect(screen.queryByTestId("chat-widget-calendar-upcoming")).toBeNull();
  });

  it("does not publish home attention for a beyond-18h event (no card = no signal)", async () => {
    connectedGoogleWithFeed([
      event({
        id: "far",
        title: "Next Tuesday",
        startAt: new Date(Date.now() + 20 * 60 * 60_000).toISOString(),
      }),
    ]);
    render(<CalendarUpcomingWidget {...homeProps} />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    // A gated-out card must never float the tile up; every publish call is null.
    await waitFor(() => {
      expect(publishMock).toHaveBeenCalled();
    });
    for (const call of publishMock.mock.calls) {
      expect(call).toEqual(["calendar/calendar.upcoming", null]);
    }
  });

  it("holds null on the deterministic first render (now === 0), before the clock installs", async () => {
    // useNow returns 0 on first render (no Date.now in render, determinism
    // convention). With a real upcoming event queued, the FIRST synchronous
    // render must still be null (the `now === 0` guard), the card only appears
    // after the effect installs the live clock. We assert the pre-effect frame,
    // then let the async probe/feed settle so nothing leaks past the test.
    connectedGoogleWithFeed([
      event({
        id: "soon",
        title: "Design sync",
        startAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      }),
    ]);
    const { container } = render(<CalendarUpcomingWidget {...homeProps} />);
    // Synchronous first paint: feed not loaded + now === 0 → null.
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("chat-widget-calendar-upcoming")).toBeNull();

    // Once the clock + feed install, the card appears (proving the null above
    // was the first-render guard, not a permanent self-hide) and the effects
    // are flushed under act.
    await screen.findByTestId("chat-widget-calendar-upcoming");
  });

  it("publishes the reminder weight when the next event starts within 2 hours (home slot)", async () => {
    connectedGoogleWithFeed([
      event({
        id: "imminent",
        title: "Call",
        startAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      }),
    ]);
    render(<CalendarUpcomingWidget {...homeProps} />);
    await screen.findByTestId("chat-widget-calendar-upcoming");
    expect(publishMock).toHaveBeenLastCalledWith(
      "calendar/calendar.upcoming",
      HOME_SIGNAL_WEIGHTS.reminder,
    );
  });

  it("navigates to the Calendar view when the populated card is clicked", async () => {
    connectedGoogleWithFeed([event({ id: "a", title: "Standup" })]);
    const navEvents: string[] = [];
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ viewPath?: string }>).detail;
      if (detail?.viewPath) navEvents.push(detail.viewPath);
    };
    window.addEventListener("eliza:navigate:view", onNav);

    render(<CalendarUpcomingWidget {...homeProps} />);
    fireEvent.click(await screen.findByTestId("chat-widget-calendar-upcoming"));
    window.removeEventListener("eliza:navigate:view", onNav);

    expect(navEvents).toContain("/calendar");
  });

  // #11084, the widget mounts before the auth probe resolves; the connector
  // probe and the calendar feed must stay dormant while unauthenticated.
  it("does not probe the connector or fetch the feed while unauthenticated", async () => {
    authMock.authenticated = false;
    connectedGoogleWithFeed([event({ id: "a", title: "Standup" })]);

    render(<CalendarUpcomingWidget {...homeProps} />);

    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("starts the probe + feed once the session flips to authenticated", async () => {
    authMock.authenticated = false;
    connectedGoogleWithFeed([event({ id: "a", title: "Standup" })]);

    const { rerender } = render(<CalendarUpcomingWidget {...homeProps} />);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();

    authMock.authenticated = true;
    rerender(<CalendarUpcomingWidget {...homeProps} />);

    const card = await screen.findByTestId("chat-widget-calendar-upcoming");
    expect(card.textContent).toContain("Standup");
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("calendar-upcoming native-complete deadlines", () => {
  it("keeps a documented budget per hop", () => {
    expect(CALENDAR_PROBE_FETCH_TIMEOUT_MS).toBe(6_000);
    expect(CALENDAR_FEED_FETCH_TIMEOUT_MS).toBe(8_000);
  });

  it("passes probe timeoutMs through client.fetch", async () => {
    fetchMock.mockResolvedValue({ accounts: [{ status: "connected" }] });
    const accounts = await fetchCalendarConnectorAccounts({
      fetch: fetchMock,
    });
    expect(accounts).toEqual([{ status: "connected" }]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/connectors/google/accounts",
      undefined,
      { timeoutMs: CALENDAR_PROBE_FETCH_TIMEOUT_MS },
    );
  });

  it("passes feed timeoutMs through client.fetch", async () => {
    fetchMock.mockResolvedValue({
      events: [
        {
          id: "evt-1",
          title: "Standup",
          startAt: "2026-08-18T10:00:00.000Z",
          endAt: "2026-08-18T10:30:00.000Z",
          isAllDay: false,
          location: "",
        },
      ],
    });
    const events = await fetchCalendarUpcomingFeed(
      { fetch: fetchMock },
      new URLSearchParams({ side: "owner" }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe("Standup");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/lifeops/calendar/feed?side=owner",
      undefined,
      { timeoutMs: CALENDAR_FEED_FETCH_TIMEOUT_MS },
    );
  });

  it("aborts a stalled feed hop as TimeoutError", async () => {
    const timeout = Object.assign(new Error("Request timed out after 10ms"), {
      name: "ApiError",
      kind: "timeout",
    });
    fetchMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(timeout), 10);
        }),
    );
    await expect(
      fetchCalendarUpcomingFeed(
        { fetch: fetchMock },
        new URLSearchParams({ side: "owner" }),
        10,
      ),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
  });

  it("surfaces a provider error from a completed feed GET", async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error("Goals request failed (503)"), {
        name: "ApiError",
        kind: "http",
        status: 503,
      }),
    );
    await expect(
      fetchCalendarUpcomingFeed(
        { fetch: fetchMock },
        new URLSearchParams({ side: "owner" }),
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
});
