/**
 * Verifies the chat-only calendar projection against canonical feed snapshots,
 * including local dates, event counts, refresh events, and shell clearance.
 *
 * @vitest-environment jsdom
 */

import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseCalendarWeekResult } from "../../hooks/useCalendarWeek.js";

const fixtures = vi.hoisted(() => ({
  calendar: vi.fn(),
  viewEvents: new Map<string, () => void>(),
}));

vi.mock("../../hooks/useCalendarWeek.js", () => ({
  useCalendarWeek: fixtures.calendar,
}));

vi.mock("@elizaos/ui/events", () => ({
  VIEW_EVENTS: { VIEW_REFRESH: "view:refresh" },
  useViewEvent: (eventType: string, callback: () => void) => {
    fixtures.viewEvents.set(eventType, callback);
  },
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
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
    error: null,
    viewMode: "month",
    setViewMode: vi.fn(),
    baseDate,
    windowStart,
    windowEnd,
    refresh: vi.fn().mockResolvedValue(undefined),
    goToToday: vi.fn(),
    goPrevious: vi.fn(),
    goNext: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  fixtures.calendar.mockReset();
  fixtures.viewEvents.clear();
});

afterEach(cleanup);

describe("SimpleCalendarView", () => {
  it("renders today's canonical events without direct controls", () => {
    const events = [event("Demo", 10), event("Team sync", 15)];
    fixtures.calendar.mockReturnValue(
      calendarState({ events, status: "ready" }),
    );

    const view = render(<SimpleCalendarView />);

    expect(
      screen.getByRole("main", { name: "Calendar. 2 events" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "August 2026" })).toBeTruthy();
    expect(screen.getByText("Demo")).toBeTruthy();
    expect(screen.getByText("Team sync")).toBeTruthy();
    expect(
      screen.getByLabelText("2 events on Tuesday, August 4, 2026"),
    ).toBeTruthy();
    expect(
      view.container.querySelector("button, input, textarea, form"),
    ).toBeNull();
  });

  it("extends content beneath chat while keeping its tail reachable", () => {
    fixtures.calendar.mockReturnValue(calendarState());
    const view = render(<SimpleCalendarView />);
    const root = view.getByTestId("simple-calendar-view");
    const scroll = view.getByTestId("simple-calendar-scroll-region");

    expect(root.style.height).toBe("100%");
    expect(root.style.position).toBe("relative");
    expect(root.style.overflow).toBe("hidden");
    expect(scroll.style.position).toBe("absolute");
    expect(scroll.style.overflowY).toBe("auto");
    expect(scroll.style.paddingBottom).toContain("--eliza-chat-clearance");
    expect(scroll.style.paddingInlineEnd).toContain(
      "--eliza-chat-side-clearance",
    );
    expect(scroll.style.gridTemplateColumns).toBe(
      "repeat(auto-fit, minmax(280px, 1fr))",
    );
  });

  it("refreshes the canonical feed after a completed chat action", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    fixtures.calendar.mockReturnValue(calendarState({ refresh }));
    render(<SimpleCalendarView />);

    fixtures.viewEvents.get("view:refresh")?.();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("distinguishes transport failure from an empty calendar", () => {
    fixtures.calendar.mockReturnValue(
      calendarState({
        error: "Calendar agent disconnected",
        feedState: null,
        loading: false,
        status: "error",
      }),
    );
    render(<SimpleCalendarView />);

    expect(
      screen.getByRole("main", { name: "Calendar. Calendar unavailable" }),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Calendar agent disconnected",
    );
  });
});
