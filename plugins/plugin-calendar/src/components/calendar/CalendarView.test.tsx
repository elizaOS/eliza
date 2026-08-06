// @vitest-environment jsdom

/**
 * CalendarView is the GUI data wrapper for the calendar surface. It
 * owns the live feed via `useCalendarWeek`, derives a presentational agenda,
 * and renders the unified `CalendarSpatialView` inside a `SpatialSurface` — the
 * same component the view bundle exports for the shipped GUI modality.
 *
 * These tests mock the host data hook and the app-state selector (so the feed
 * and `setActionNotice` stay offline), render the REAL spatial DOM, and drive
 * the agent-id controls: the prev/today/next nav and the segmented view modes
 * route through to the hook; selecting an event routes a chat-about-event
 * notice through `setActionNotice`.
 */

import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarSourceHealth,
  LifeOpsCalendarSummary,
} from "@elizaos/shared";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseCalendarSourcesResult } from "../../hooks/useCalendarSources.js";
import type { UseCalendarWeekResult } from "../../hooks/useCalendarWeek.js";

const setActionNotice = vi.hoisted(() => vi.fn());

const calendarViewAppValue = vi.hoisted(() => ({
  t: (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
  setActionNotice,
}));

vi.mock("@elizaos/ui/state", () => ({
  useAppSelector: <T,>(selector: (value: typeof calendarViewAppValue) => T) =>
    selector(calendarViewAppValue),
}));

const calendarState = vi.hoisted(() => ({
  current: null as UseCalendarWeekResult | null,
}));
const sourcePreferencesState = vi.hoisted(() => ({
  current: null as UseCalendarSourcesResult | null,
}));
const openCalendarConnectorSettings = vi.hoisted(() => vi.fn());

const goPrevious = vi.hoisted(() => vi.fn());
const goNext = vi.hoisted(() => vi.fn());
const goToToday = vi.hoisted(() => vi.fn());
const setViewMode = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../../hooks/useCalendarWeek.js", () => ({
  useCalendarWeek: () => calendarState.current,
}));

vi.mock("../../hooks/useCalendarSources.js", () => ({
  useCalendarSources: () => sourcePreferencesState.current,
}));

vi.mock("./source-navigation.js", () => ({
  openCalendarConnectorSettings,
}));

import { CalendarView } from "./CalendarView.js";

function agent(agentId: string): HTMLElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLElement;
}

function evt(
  over: Partial<LifeOpsCalendarEvent> & { id: string },
): LifeOpsCalendarEvent {
  return {
    externalId: over.id,
    agentId: "agent-1",
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: "Untitled",
    description: "",
    location: "",
    status: "confirmed",
    startAt: "2026-06-15T15:00:00.000Z",
    endAt: "2026-06-15T16:00:00.000Z",
    isAllDay: false,
    timezone: null,
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: "2026-06-15T00:00:00.000Z",
    updatedAt: "2026-06-15T00:00:00.000Z",
    ...over,
  };
}

function makeResult(
  over: Partial<UseCalendarWeekResult> = {},
): UseCalendarWeekResult {
  return {
    events: [],
    feedState: "complete",
    sources: [calendarSource()],
    status: "ready",
    loading: false,
    refreshing: false,
    error: null,
    viewMode: "week",
    setViewMode,
    baseDate: new Date("2026-06-15T12:00:00.000Z"),
    windowStart: new Date("2026-06-14T00:00:00.000Z"),
    windowEnd: new Date("2026-06-21T00:00:00.000Z"),
    refresh,
    goToToday,
    goPrevious,
    goNext,
    ...over,
  };
}

function calendarSource(
  over: Partial<LifeOpsCalendarSourceHealth> = {},
): LifeOpsCalendarSourceHealth {
  return {
    key: {
      provider: "google",
      side: "owner",
      grantId: "grant-work",
      connectorAccountId: "account-work",
      calendarId: "primary",
    },
    summary: "Work",
    accessRole: "owner",
    visibility: "details",
    status: "fresh",
    syncedAt: new Date().toISOString(),
    error: null,
    ...over,
  };
}

function calendarSummary(
  over: Partial<LifeOpsCalendarSummary> = {},
): LifeOpsCalendarSummary {
  return {
    provider: "google",
    side: "owner",
    grantId: "grant-work",
    connectorAccountId: "account-work",
    accountEmail: "work@example.com",
    calendarId: "primary",
    summary: "Work",
    description: null,
    primary: true,
    accessRole: "owner",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: "UTC",
    selected: true,
    includeInFeed: true,
    selectionVersion: 0,
    ...over,
  };
}

const refreshSourcePreferences = vi.hoisted(() => vi.fn(async () => {}));
const setSourceIncluded = vi.hoisted(() =>
  vi.fn(async () => "updated" as const),
);

function makeSourcePreferences(
  over: Partial<UseCalendarSourcesResult> = {},
): UseCalendarSourcesResult {
  return {
    calendars: [calendarSummary()],
    status: "ready",
    loading: false,
    refreshing: false,
    error: null,
    refreshError: null,
    pendingKeys: new Set(),
    mutationErrors: {},
    refresh: refreshSourcePreferences,
    setIncluded: setSourceIncluded,
    ...over,
  };
}

describe("CalendarView (unified spatial wrapper)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calendarState.current = makeResult();
    sourcePreferencesState.current = makeSourcePreferences();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the spatial surface with the period label and nav controls", () => {
    // The view-bundle host (DynamicViewLoader) mounts the wrapper inside a
    // SpatialSurface; mirror that so the host-provided surface attribute is present.
    const { container } = render(
      <SpatialSurface modality="gui">
        <CalendarView />
      </SpatialSurface>,
    );
    expect(container.querySelector("[data-spatial-surface]")).toBeTruthy();
    expect(agent("prev")).toBeTruthy();
    expect(agent("today")).toBeTruthy();
    expect(agent("next")).toBeTruthy();
    expect(agent("new")).toBeTruthy();
    expect(agent("mode:day")).toBeTruthy();
    expect(agent("mode:week")).toBeTruthy();
    expect(agent("mode:month")).toBeTruthy();
    expect(document.querySelector('[data-agent-id="mode"]')).toBeNull();
    expect(agent("period-label").parentElement).not.toBe(
      agent("prev").parentElement,
    );
  });

  it("renders populated agenda events from the feed", () => {
    calendarState.current = makeResult({
      events: [
        evt({
          id: "e1",
          title: "Design sync",
          location: "Room 4B",
          startAt: new Date(2026, 5, 15, 9, 0, 0).toISOString(),
          endAt: new Date(2026, 5, 15, 10, 0, 0).toISOString(),
        }),
      ],
    });

    render(<CalendarView />);

    expect(document.body.textContent).toContain("Design sync");
    expect(document.body.textContent).toContain("Room 4B");
    expect(agent("select:e1")).toBeTruthy();
  });

  it("drives the prev/today/next nav through to the hook", () => {
    render(<CalendarView />);
    fireEvent.click(agent("prev"));
    fireEvent.click(agent("next"));
    fireEvent.click(agent("today"));
    expect(goPrevious).toHaveBeenCalledTimes(1);
    expect(goNext).toHaveBeenCalledTimes(1);
    expect(goToToday).toHaveBeenCalledTimes(1);
  });

  it("the segmented mode buttons route through to setViewMode", () => {
    render(<CalendarView />);
    fireEvent.click(agent("mode:day"));
    fireEvent.click(agent("mode:month"));
    expect(setViewMode).toHaveBeenCalledWith("day");
    expect(setViewMode).toHaveBeenCalledWith("month");
  });

  it("selecting an event routes chat-about-event through setActionNotice", () => {
    calendarState.current = makeResult({
      events: [
        evt({
          id: "e1",
          title: "Design sync",
          startAt: new Date(2026, 5, 15, 9, 0, 0).toISOString(),
          endAt: new Date(2026, 5, 15, 10, 0, 0).toISOString(),
        }),
      ],
    });

    render(<CalendarView />);
    fireEvent.click(agent("select:e1"));

    expect(setActionNotice).toHaveBeenCalledTimes(1);
    expect(setActionNotice.mock.calls[0]?.[0]).toContain("Design sync");
    expect(setActionNotice.mock.calls[0]?.[1]).toBe("info");
  });

  it("New routes a create notice through setActionNotice", () => {
    render(<CalendarView />);
    fireEvent.click(agent("new"));
    expect(setActionNotice).toHaveBeenCalledTimes(1);
    expect(setActionNotice.mock.calls[0]?.[1]).toBe("info");
  });

  it("surfaces a feed error in the spatial view", () => {
    calendarState.current = makeResult({
      error: "Calendar failed to load.",
      status: "error",
      sources: [],
    });
    render(<CalendarView />);
    expect(document.body.textContent).toContain("Calendar failed to load.");
  });

  it("renders complete source provenance and freshness in the spatial view", () => {
    render(<CalendarView />);

    const sources = agent("calendar-sources");
    expect(sources.textContent).toContain("1 source current");
    expect(sources.textContent).toContain("Google · Work");
    expect(sources.textContent).toContain("just now");
  });

  it("renders partial stale source truth without exposing provider diagnostics", () => {
    calendarState.current = makeResult({
      feedState: "partial",
      status: "partial",
      sources: [
        calendarSource(),
        calendarSource({
          key: {
            provider: "microsoft",
            side: "owner",
            grantId: "grant-family",
            connectorAccountId: "account-family",
            calendarId: "family",
          },
          summary: "Family",
          status: "stale",
          syncedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          error: {
            code: "TOKEN_REFRESH_FAILED",
            message: "Private provider diagnostic.",
            retryable: true,
          },
        }),
      ],
    });

    render(<CalendarView />);

    const sources = agent("calendar-sources");
    expect(sources.textContent).toContain(
      "Partial calendar · 1 source needs attention",
    );
    expect(sources.textContent).toContain("Outlook · Family");
    expect(sources.textContent).toContain("stale · 2h ago");
    expect(sources.textContent).not.toContain("Private provider diagnostic");
  });

  it("renders disconnected unavailable coverage instead of a healthy empty agenda", () => {
    calendarState.current = makeResult({
      feedState: "unavailable",
      status: "unavailable",
      sources: [
        calendarSource({
          status: "disconnected",
          syncedAt: null,
          error: {
            code: "OAUTH_REVOKED",
            message: "Authorization revoked.",
            retryable: true,
          },
        }),
      ],
    });

    render(<CalendarView />);

    expect(agent("calendar-sources").textContent).toContain(
      "Calendar sources unavailable",
    );
    expect(document.body.textContent).toContain("Calendar unavailable");
    expect(document.body.textContent).not.toContain("No events in this range");
  });

  it("renders an authoritative empty state when complete coverage has no events", () => {
    calendarState.current = makeResult({ status: "empty" });

    render(<CalendarView />);

    expect(document.body.textContent).toContain("No events in this range");
  });

  it("routes source refresh through the hook and disables it while refreshing", () => {
    const { rerender } = render(<CalendarView />);
    fireEvent.click(agent("refresh"));
    expect(refresh).toHaveBeenCalledTimes(1);

    calendarState.current = makeResult({ loading: true, refreshing: true });
    rerender(<CalendarView />);
    expect(agent("refresh").hasAttribute("disabled")).toBe(true);
    expect(agent("calendar-sources").textContent).toContain(
      "Refreshing calendar sources",
    );
  });

  it("expands a serializable source manager with provider, account, access, privacy, and inclusion truth", () => {
    sourcePreferencesState.current = makeSourcePreferences({
      calendars: [
        calendarSummary(),
        calendarSummary({
          provider: "microsoft",
          grantId: "grant-family",
          connectorAccountId: "account-family",
          accountEmail: "family@example.com",
          calendarId: "family",
          summary: "Family",
          primary: false,
          accessRole: "reader",
          includeInFeed: false,
        }),
      ],
    });
    render(<CalendarView />);

    fireEvent.click(agent("manage-sources"));

    const manager = agent("calendar-source-manager");
    expect(manager.textContent).toContain("New calendars join automatically");
    expect(manager.textContent).not.toContain("work@example.com");
    const detailButtons = manager.querySelectorAll(
      '[data-agent-id^="source-details:calendar-source-"]',
    );
    expect(detailButtons).toHaveLength(2);
    for (const details of detailButtons) {
      fireEvent.click(details);
    }
    expect(manager.textContent).toContain("Google Calendar");
    expect(manager.textContent).toContain("work@example.com");
    expect(manager.textContent).toContain("Owner");
    expect(manager.textContent).toContain("Event details");
    expect(manager.textContent).toContain("Microsoft Outlook");
    expect(manager.textContent).toContain("family@example.com");
    expect(manager.textContent).toContain("Not in current feed");
    expect(manager.textContent).not.toContain("Stale · stale");
    const toggles = document.querySelectorAll(
      '[data-agent-id^="source-toggle:calendar-source-"]',
    );
    expect(toggles).toHaveLength(2);
    expect(document.body.innerHTML).not.toContain("grant-family");
    expect(document.body.innerHTML).not.toContain("account-family");
  });

  it("replaces duplicate source-health rows with the expanded source hierarchy", () => {
    render(<CalendarView />);

    const sources = agent("calendar-sources");
    expect(within(sources).getByText("Google · Work")).toBeTruthy();

    fireEvent.click(agent("manage-sources"));

    expect(within(sources).queryByText("Google · Work")).toBeNull();
    const manager = agent("calendar-source-manager");
    expect(manager.textContent).not.toContain("work@example.com");
    const details = manager.querySelector(
      '[data-agent-id^="source-details:calendar-source-"]',
    ) as HTMLElement | null;
    expect(details).toBeTruthy();
    fireEvent.click(details as HTMLElement);
    expect(
      within(manager).getByText("Google Calendar · work@example.com"),
    ).toBeTruthy();
    expect(manager.textContent).toContain(
      "Owner · Event details · Current · just now",
    );
  });

  it("routes a safe spatial source action to the exact account and refreshes feed truth", async () => {
    render(<CalendarView />);
    fireEvent.click(agent("manage-sources"));
    const toggle = document.querySelector(
      '[data-agent-id^="source-toggle:calendar-source-"]',
    ) as HTMLElement | null;
    expect(toggle).toBeTruthy();

    fireEvent.click(toggle as HTMLElement);

    await vi.waitFor(() =>
      expect(setSourceIncluded).toHaveBeenCalledWith(
        sourcePreferencesState.current?.calendars[0],
        false,
      ),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows pending and failed source writes without changing the server-backed state", () => {
    const work = calendarSummary();
    const key = JSON.stringify([
      work.provider,
      work.side,
      work.grantId,
      work.connectorAccountId,
      work.calendarId,
    ]);
    sourcePreferencesState.current = makeSourcePreferences({
      calendars: [work],
      pendingKeys: new Set([key]),
      mutationErrors: {
        [key]: "Couldn’t exclude “Work”. Your current setting was kept.",
      },
    });

    render(<CalendarView />);
    fireEvent.click(agent("manage-sources"));

    const toggle = document.querySelector(
      '[data-agent-id^="source-toggle:calendar-source-"]',
    ) as HTMLButtonElement | null;
    expect(toggle?.disabled).toBe(true);
    expect(toggle?.textContent).toContain("Excluding…");
    expect(agent("calendar-source-manager").textContent).toContain(
      "Your current setting was kept",
    );
  });

  it("routes only a registered Google reconnect action through the safe helper", () => {
    sourcePreferencesState.current = makeSourcePreferences({ calendars: [] });
    calendarState.current = makeResult({
      status: "unavailable",
      feedState: "unavailable",
      sources: [
        calendarSource({
          key: {
            provider: "google",
            side: "owner",
            grantId: "grant-retired",
            connectorAccountId: "account-retired",
            calendarId: "travel",
          },
          summary: "Travel",
          status: "disconnected",
          syncedAt: null,
        }),
        calendarSource({
          key: {
            provider: "microsoft",
            side: "owner",
            grantId: "grant-old-outlook",
            connectorAccountId: "account-old-outlook",
            calendarId: "archive",
          },
          summary: "Archive",
          status: "disconnected",
          syncedAt: null,
        }),
      ],
    });

    render(<CalendarView />);
    fireEvent.click(agent("manage-sources"));
    const details = document.querySelectorAll(
      '[data-agent-id^="source-details:calendar-source-"]',
    );
    expect(details).toHaveLength(2);
    for (const button of details) {
      fireEvent.click(button);
    }
    const reconnect = document.querySelector(
      '[data-agent-id^="source-reconnect:calendar-source-"]',
    ) as HTMLElement | null;
    expect(reconnect).toBeTruthy();
    fireEvent.click(reconnect as HTMLElement);

    expect(openCalendarConnectorSettings).toHaveBeenCalledWith("google");
    expect(agent("calendar-source-manager").textContent).toContain(
      "Reconnect unavailable here.",
    );
  });

  it("keeps event titles outside the source-health region", () => {
    calendarState.current = makeResult({
      events: [evt({ id: "private", title: "Private custody handoff" })],
    });

    render(<CalendarView />);

    const sources = agent("calendar-sources");
    expect(within(sources).queryByText("Private custody handoff")).toBeNull();
    expect(screen.getByText("Private custody handoff")).toBeTruthy();
  });
});
