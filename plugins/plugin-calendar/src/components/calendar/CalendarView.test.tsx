// @vitest-environment jsdom

/**
 * CalendarView is the GUI data wrapper for the calendar surface. It
 * owns the live feed via `useCalendarWeek`, derives a presentational agenda,
 * and renders the unified `CalendarSpatialView` inside a `SpatialSurface` — the
 * same component the view bundle exports for the shipped GUI modality.
 *
 * These tests mock the host data hook and the app-state selector (so the feed
 * and `setActionNotice` stay offline), render the REAL spatial DOM, and drive
 * the agent-id controls: the prev/today/next nav and the view-mode selector
 * route through to the hook; selecting an event routes a chat-about-event
 * notice through `setActionNotice`.
 */

import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { SpatialSurface } from "@elizaos/ui/spatial";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const goPrevious = vi.hoisted(() => vi.fn());
const goNext = vi.hoisted(() => vi.fn());
const goToToday = vi.hoisted(() => vi.fn());
const setViewMode = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../../hooks/useCalendarWeek.js", () => ({
  useCalendarWeek: () => calendarState.current,
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
    loading: false,
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

describe("CalendarView (unified spatial wrapper)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calendarState.current = makeResult();
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
    expect(agent("mode")).toBeTruthy();
  });

  it("keeps the spatial root at content height so short viewports scroll instead of overprinting rows (#15911)", () => {
    // The host SpatialSurface is a height-constrained scrollport. If the root
    // card is allowed to flex-shrink, a short landscape viewport compresses
    // the toolbar/agenda rows through each other instead of scrolling.
    const { container } = render(
      <SpatialSurface modality="gui">
        <CalendarView />
      </SpatialSurface>,
    );
    const root = container.querySelector(
      '[data-spatial-surface] > [data-spatial-kind="box"]',
    ) as HTMLElement | null;
    expect(root).toBeTruthy();
    expect(root?.style.flexShrink).toBe("0");
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

  it("switching to the month view routes through to setViewMode", () => {
    render(<CalendarView />);
    fireEvent.click(agent("mode:month"));
    expect(setViewMode).toHaveBeenCalledWith("month");
  });

  it("the per-mode buttons also route through to setViewMode", () => {
    render(<CalendarView />);
    fireEvent.click(agent("mode:day"));
    expect(setViewMode).toHaveBeenCalledWith("day");
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
    calendarState.current = makeResult({ error: "Calendar failed to load." });
    render(<CalendarView />);
    expect(document.body.textContent).toContain("Calendar failed to load.");
  });
});
