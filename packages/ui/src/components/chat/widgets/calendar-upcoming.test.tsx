// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Auth gate (#11084) — mutable so tests can flip the session state. Default
// authenticated so the pre-gate behavior tests exercise the live poll path.
const { authMock } = vi.hoisted(() => ({
  authMock: { authenticated: true },
}));
vi.mock("../../../hooks/useAuthStatus", () => ({
  useIsAuthenticated: () => authMock.authenticated,
}));

import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";

const { getBaseUrlMock, publishMock, listConnectorAccountsMock } = vi.hoisted(
  () => ({
    getBaseUrlMock: vi.fn(() => "http://localhost"),
    publishMock: vi.fn(),
    listConnectorAccountsMock: vi.fn(),
  }),
);

// Mock the client: getBaseUrl resolves without booting the real ElizaClient,
// and listConnectorAccounts is the connection probe driven per-test.
vi.mock("../../../api", () => ({
  client: {
    getBaseUrl: getBaseUrlMock,
    listConnectorAccounts: listConnectorAccountsMock,
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
import { CalendarUpcomingWidget } from "./calendar-upcoming";

// Minimal wire event matching LifeOpsCalendarEvent (@elizaos/shared
// contracts/calendar.ts) — only the fields the widget reads.
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

function mockFeed(events: ReturnType<typeof event>[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ events }),
    })),
  );
}

/** A linked Google account makes the connection probe resolve "connected". */
function connectedGoogle() {
  listConnectorAccountsMock.mockResolvedValue({
    provider: "google",
    connectorId: "google",
    accounts: [
      {
        id: "g1",
        provider: "google",
        connectorId: "google",
        label: "Work",
        status: "connected",
      },
    ],
  });
}

/** No accounts → the probe resolves "disconnected" (connect affordance). */
function disconnectedGoogle() {
  listConnectorAccountsMock.mockResolvedValue({
    provider: "google",
    connectorId: "google",
    accounts: [],
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
  listConnectorAccountsMock.mockReset();
});

describe("CalendarUpcomingWidget", () => {
  it("renders nothing and skips full-shell probes on limited cloud agent bases", async () => {
    getBaseUrlMock.mockReturnValue("https://agent-1.elizacloud.ai");
    vi.stubGlobal("fetch", vi.fn());

    const { container } = render(<CalendarUpcomingWidget {...homeProps} />);

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
    expect(listConnectorAccountsMock).not.toHaveBeenCalled();
    expect(globalThis.fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("renders NOTHING when no Google account is linked — no connect-CTA tile", async () => {
    disconnectedGoogle();
    mockFeed([]);
    const { container } = render(<CalendarUpcomingWidget {...homeProps} />);

    // The probe settles to "disconnected" and the widget self-hides; the
    // connect flow lives in Settings → Connectors, not the home grid.
    await waitFor(() => {
      expect(listConnectorAccountsMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
    expect(
      screen.queryByTestId("chat-widget-calendar-upcoming-connect"),
    ).toBeNull();
  });

  it("renders NOTHING when connected but no upcoming events — the row must earn its place", async () => {
    connectedGoogle();
    // A past event only — filtered out (startAt < now).
    mockFeed([
      event({
        id: "past",
        startAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      }),
    ]);
    const { container } = render(<CalendarUpcomingWidget {...homeProps} />);

    await waitFor(() => {
      expect(listConnectorAccountsMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
    expect(screen.queryByTestId("chat-widget-calendar-upcoming")).toBeNull();
  });

  it("shows ONE high-priority datum — the soonest event — with a +N more badge", async () => {
    connectedGoogle();
    mockFeed([
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
    expect(widget.getAttribute("aria-label")).toMatch(/Open Calendar/);
  });

  it("applies the grid span to its single root element", async () => {
    connectedGoogle();
    mockFeed([event({ id: "a", title: "Standup" })]);
    const { container } = render(<CalendarUpcomingWidget {...homeProps} />);
    await screen.findByTestId("chat-widget-calendar-upcoming");
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("col-span-4");
    expect(root.className).toContain("row-span-1");
  });

  it("publishes the reminder weight when the next event starts within 2 hours (home slot)", async () => {
    connectedGoogle();
    mockFeed([
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
    connectedGoogle();
    mockFeed([event({ id: "a", title: "Standup" })]);
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

  // #11084 — the widget mounts before the auth probe resolves; the connector
  // probe and the calendar feed must stay dormant while unauthenticated.
  it("does not probe the connector or fetch the feed while unauthenticated", async () => {
    authMock.authenticated = false;
    connectedGoogle();
    mockFeed([event({ id: "a", title: "Standup" })]);

    render(<CalendarUpcomingWidget {...homeProps} />);

    await Promise.resolve();
    expect(listConnectorAccountsMock).not.toHaveBeenCalled();
    expect(globalThis.fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("starts the probe + feed once the session flips to authenticated", async () => {
    authMock.authenticated = false;
    connectedGoogle();
    mockFeed([event({ id: "a", title: "Standup" })]);

    const { rerender } = render(<CalendarUpcomingWidget {...homeProps} />);
    await Promise.resolve();
    expect(listConnectorAccountsMock).not.toHaveBeenCalled();

    authMock.authenticated = true;
    rerender(<CalendarUpcomingWidget {...homeProps} />);

    const card = await screen.findByTestId("chat-widget-calendar-upcoming");
    expect(card.textContent).toContain("Standup");
    expect(listConnectorAccountsMock).toHaveBeenCalled();
    expect(globalThis.fetch as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });
});
