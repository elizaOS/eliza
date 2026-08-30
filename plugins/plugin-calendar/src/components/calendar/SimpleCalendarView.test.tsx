/**
 * Verifies the chat-only calendar projection against canonical feed snapshots,
 * including local dates, event counts, refresh events, and shell clearance.
 *
 * @vitest-environment jsdom
 */

import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarSourceHealth,
} from "@elizaos/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseCalendarWeekResult } from "../../hooks/useCalendarWeek.js";

const fixtures = vi.hoisted(() => ({
  calendar: vi.fn(),
  sourceManager: vi.fn(),
  viewEvents: new Map<string, () => void>(),
}));

vi.mock("../../hooks/useCalendarWeek.js", () => ({
  useCalendarWeek: fixtures.calendar,
}));

vi.mock("@elizaos/ui/events", () => ({
  NETWORK_STATUS_CHANGE_EVENT: "eliza:network-status-change",
  VIEW_EVENTS: { VIEW_REFRESH: "view:refresh" },
  useViewEvent: (eventType: string, callback: () => void) => {
    fixtures.viewEvents.set(eventType, callback);
  },
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

vi.mock("../CalendarSourceManager.js", () => ({
  CalendarSourceManager: ({
    sourceHealth,
    onSelectionChanged,
    sourceNotice,
  }: {
    sourceHealth: readonly LifeOpsCalendarSourceHealth[];
    onSelectionChanged?: () => void;
    sourceNotice?: {
      label: string;
      tone: "warning" | "danger";
    };
  }) => {
    fixtures.sourceManager({ sourceHealth, onSelectionChanged, sourceNotice });
    return (
      <section data-testid="calendar-source-manager">
        {sourceNotice ? (
          <span role="status" aria-label={sourceNotice.label} />
        ) : null}
        <button type="button" onClick={onSelectionChanged}>
          Manage calendar sources
        </button>
      </section>
    );
  },
}));

import { SimpleCalendarView } from "./SimpleCalendarView.js";

function event(
  title: string,
  hour: number,
  overrides: Partial<LifeOpsCalendarEvent> = {},
): LifeOpsCalendarEvent {
  const start = new Date(2026, 7, 4, hour, 0, 0, 0);
  const end = new Date(start);
  end.setHours(hour + 1);
  return {
    id: `event-${title}`,
    externalId: `external-${title}`,
    agentId: "agent-1",
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title,
    description: "Film on the Light Phone",
    location: "",
    status: "confirmed",
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    isAllDay: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: start.toISOString(),
    updatedAt: start.toISOString(),
    ...overrides,
  };
}

function calendarState(
  overrides: Partial<UseCalendarWeekResult> = {},
): UseCalendarWeekResult {
  const baseDate = new Date(2026, 7, 4, 12, 0, 0, 0);
  const windowStart = new Date(2026, 6, 26, 0, 0, 0, 0);
  const windowEnd = new Date(2026, 8, 6, 0, 0, 0, 0);
  return {
    events: [],
    feedState: "complete",
    sources: [],
    status: "empty",
    loading: false,
    refreshing: false,
    issue: null,
    error: null,
    viewMode: "month",
    setViewMode: vi.fn(),
    baseDate,
    windowStart,
    windowEnd,
    refresh: vi.fn().mockResolvedValue(undefined),
    goToDate: vi.fn(),
    goToToday: vi.fn(),
    goPrevious: vi.fn(),
    goNext: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  fixtures.calendar.mockReset();
  fixtures.sourceManager.mockReset();
  fixtures.viewEvents.clear();
  window.history.replaceState(null, "", "/calendar");
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("SimpleCalendarView", () => {
  it("can render the shared route header when used standalone", () => {
    fixtures.calendar.mockReturnValue(calendarState());
    render(<SimpleCalendarView standalone />);

    const headings = screen.getAllByRole("heading", {
      level: 1,
      name: "Calendar",
    });
    expect(headings).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Back to launcher" }));
    expect(window.location.pathname).toBe("/views");
  });

  it("defaults to shell-owned route chrome", () => {
    fixtures.calendar.mockReturnValue(calendarState());
    render(<SimpleCalendarView />);

    expect(screen.queryByTestId("view-header")).toBeNull();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Back to launcher" }),
    ).toBeNull();
  });

  it("keeps healthy calendar source controls out of the primary view", () => {
    const sources: LifeOpsCalendarSourceHealth[] = [
      {
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
        syncedAt: "2026-08-04T12:00:00.000Z",
        error: null,
      },
    ];
    fixtures.calendar.mockReturnValue(
      calendarState({ sources, status: "ready" }),
    );

    render(<SimpleCalendarView />);

    expect(screen.queryByTestId("simple-calendar-source-manager")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Manage calendar sources" }),
    ).toBeNull();
    expect(fixtures.sourceManager).not.toHaveBeenCalled();
  });

  it("renders canonical events with month navigation and selectable days", () => {
    const events = [event("Demo", 10), event("Team sync", 15)];
    fixtures.calendar.mockReturnValue(
      calendarState({ events, status: "ready" }),
    );

    const view = render(<SimpleCalendarView />);

    expect(
      screen.getByRole("main", { name: "Calendar. 2 events" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Choose month and year. Current month is August 2026",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Demo")).toBeTruthy();
    expect(screen.getByText("Team sync")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Tuesday, August 4, 2026. 2 events",
      }),
    ).toBeTruthy();
    const selectedDay = screen.getByRole("button", {
      name: "Tuesday, August 4, 2026. 2 events",
    });
    expect(
      selectedDay.querySelector(".eliza-calendar-day-marker")?.textContent,
    ).toBe("4");
    expect(selectedDay.querySelector(".eliza-calendar-event-dot")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Previous month/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Next month/ })).toBeTruthy();
    const toolbar = screen.getByTestId("calendar-month-toolbar");
    expect(toolbar.style.gridTemplateColumns).toBe(
      "minmax(64px, 88px) minmax(0, 1fr) 88px",
    );
    expect(
      toolbar.contains(screen.getByRole("button", { name: "Today" })),
    ).toBe(true);
    expect(
      toolbar.contains(screen.getByRole("button", { name: /Previous month/ })),
    ).toBe(true);
    expect(
      toolbar.contains(screen.getByRole("button", { name: /Next month/ })),
    ).toBe(true);
    const monthPanel = screen.getByRole("region", { name: "Calendar month" });
    const agendaPanel = screen.getByRole("region", {
      name: "Events for 2026-08-04",
    });
    const content = screen.getByTestId("simple-calendar-content");
    expect(content.contains(monthPanel)).toBe(true);
    expect(content.contains(agendaPanel)).toBe(true);
    expect(monthPanel.classList.contains("eliza-calendar-month")).toBe(true);
    expect(agendaPanel.classList.contains("eliza-calendar-agenda")).toBe(true);
    expect(monthPanel.style.boxShadow).toBe("");
    expect(agendaPanel.style.backdropFilter).toBe("");
    const augustSixth = screen.getByRole("button", {
      name: "Thursday, August 6, 2026. No events",
    });
    fireEvent.click(augustSixth);
    expect(augustSixth.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByRole("region", { name: "Events for 2026-08-06" }),
    ).toBeTruthy();
    expect(view.container.querySelector("form")).toBeNull();
  });

  it("changes month/year without walking every intermediate month", () => {
    const goToDate = vi.fn();
    fixtures.calendar.mockReturnValue(calendarState({ goToDate }));
    render(<SimpleCalendarView />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Choose month and year. Current month is August 2026",
      }),
    );
    fireEvent.click(screen.getByLabelText("Calendar year"));
    fireEvent.click(screen.getByRole("option", { name: "2027" }));
    fireEvent.click(screen.getByRole("button", { name: "Mar" }));

    expect(goToDate).toHaveBeenCalledTimes(1);
    expect(goToDate.mock.calls[0]?.[0]).toEqual(
      new Date(2027, 2, 1, 12, 0, 0, 0),
    );
  });

  it("composes the canonical full-bleed frame, scroll owner, and wide rail", () => {
    fixtures.calendar.mockReturnValue(calendarState());
    const view = render(<SimpleCalendarView />);
    const root = view.getByTestId("simple-calendar-view");
    const scroll = view.getByTestId("simple-calendar-scroll-region");
    const rail = root.querySelector<HTMLElement>(
      '[data-slot="page-panel-content-rail"]',
    );

    expect(root.tagName).toBe("MAIN");
    expect(scroll.parentElement).toBe(root);
    expect(scroll.tabIndex).toBe(0);
    expect(
      root.querySelectorAll('[data-slot="page-panel-content-rail"]'),
    ).toHaveLength(1);
    expect(rail).not.toBeNull();
    expect(rail?.dataset.width).toBe("wide");
    expect(scroll.contains(rail)).toBe(true);
    expect(rail?.style.paddingBlockStart).toContain("--view-pad-top");
    expect(rail?.style.paddingBlockEnd).toContain("--view-pad-bottom");
    expect(scroll.getAttribute("style") ?? "").not.toContain("safe-area");
    expect(scroll.getAttribute("style") ?? "").not.toContain(
      "eliza-chat-clearance",
    );
    expect(rail?.getAttribute("style") ?? "").not.toContain("safe-area");
    expect(rail?.getAttribute("style") ?? "").not.toContain(
      "eliza-chat-clearance",
    );
    expect(rail?.classList.contains("eliza-calendar-layout")).toBe(true);
    expect(rail?.style.gridTemplateColumns).toBe("");
    expect(rail?.style.alignContent).toBe("start");
  });

  it("refreshes the canonical feed after a completed chat action", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    fixtures.calendar.mockReturnValue(calendarState({ refresh }));
    render(<SimpleCalendarView />);

    fixtures.viewEvents.get("view:refresh")?.();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("settles a typed transport failure without retaining the loading state", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    fixtures.calendar.mockReturnValue(
      calendarState({
        issue: {
          kind: "network",
          message:
            "Calendar couldn’t connect. Check your connection and try again.",
          retryable: true,
          upgradeRequired: false,
        },
        error:
          "Calendar couldn’t connect. Check your connection and try again.",
        feedState: null,
        loading: false,
        status: "error",
        refresh,
      }),
    );
    render(<SimpleCalendarView />);

    expect(
      screen.getByRole("main", { name: "Calendar. Calendar unavailable" }),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Calendar couldn’t connect",
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Check your connection and try again.",
    );
    expect(
      screen.queryByRole("status", { name: "Calendar events are loading" }),
    ).toBeNull();
    expect(screen.queryByText("Loading events")).toBeNull();
    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("collapses a generic blocking failure into one concise recovery row", () => {
    fixtures.calendar.mockReturnValue(
      calendarState({
        issue: {
          kind: "network",
          message: "Calendar is temporarily unavailable. Try again.",
          retryable: true,
          upgradeRequired: false,
        },
        error: "Calendar is temporarily unavailable. Try again.",
        feedState: null,
        status: "error",
      }),
    );
    render(<SimpleCalendarView />);

    const alert = screen.getByRole("alert", { name: "Calendar unavailable" });
    expect(alert.textContent).toBe("Calendar unavailableRetry");
    expect(screen.queryByText(/temporarily unavailable/)).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("renders the initial loading state only while the request is in flight", () => {
    fixtures.calendar.mockReturnValue(
      calendarState({
        feedState: null,
        loading: true,
        status: "loading",
      }),
    );
    render(<SimpleCalendarView />);

    expect(
      screen.getByRole("status", { name: "Calendar events are loading" }),
    ).toBeTruthy();
    expect(screen.getByText("Loading events")).toBeTruthy();
  });

  it("explains the Shared capability gate without offering a futile retry", () => {
    fixtures.calendar.mockReturnValue(
      calendarState({
        issue: {
          kind: "runtime_unavailable",
          message:
            "Calendar isn’t available with this cloud setup yet. Connect a dedicated agent to use calendar sources.",
          retryable: false,
          upgradeRequired: true,
        },
        error:
          "Calendar isn’t available with this cloud setup yet. Connect a dedicated agent to use calendar sources.",
        feedState: null,
        status: "unavailable",
      }),
    );
    render(<SimpleCalendarView />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Calendar needs a dedicated agent",
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Connect a dedicated agent to use calendar sources.",
    );
    expect(screen.queryByText(/cloud setup yet/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText("No plans yet")).toBeNull();
    expect(
      screen.queryByRole("status", { name: "Calendar events are loading" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Thursday, August 6, 2026. Events unavailable",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Thursday, August 6, 2026. No events",
      }),
    ).toBeNull();
  });

  it("labels partial coverage and never presents it as a healthy empty day", () => {
    fixtures.calendar.mockReturnValue(
      calendarState({ feedState: "partial", status: "partial" }),
    );
    render(<SimpleCalendarView />);

    const notice = screen.getByRole("status", {
      name: "Some calendars are delayed",
    });
    const managerSlot = screen.getByTestId("simple-calendar-source-manager");
    const content = screen.getByTestId("simple-calendar-content");
    expect(managerSlot.dataset.placement).toBe("promoted");
    expect(
      managerSlot.compareDocumentPosition(content) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      notice.closest("[data-testid='calendar-source-manager']"),
    ).toBeTruthy();
    expect(fixtures.sourceManager).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceNotice: {
          label: "Some calendars are delayed",
          tone: "warning",
        },
      }),
    );
    expect(document.querySelector(".eliza-calendar-status")).toBeNull();
    expect(screen.queryByText("Some calendars may be out of date")).toBeNull();
    expect(screen.getByText("Available calendars only")).toBeTruthy();
    expect(screen.getByText("No events in available calendars.")).toBeTruthy();
    expect(screen.queryByText("No plans yet")).toBeNull();
  });

  it("promotes unavailable sources without describing unloaded dates as empty", () => {
    fixtures.calendar.mockReturnValue(
      calendarState({ feedState: null, status: "unavailable" }),
    );
    render(<SimpleCalendarView />);

    expect(
      screen.getByRole("status", { name: "Calendar sources unavailable" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Thursday, August 6, 2026. Events unavailable",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Thursday, August 6, 2026. No events",
      }),
    ).toBeNull();
    expect(screen.queryByText("Events unavailable")).toBeNull();
    expect(screen.queryByText("No plans yet")).toBeNull();
  });
});
