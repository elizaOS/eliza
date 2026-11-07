// @vitest-environment jsdom

import type { LifeOpsCalendarEvent } from "@elizaos/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CalendarWorkspace,
  type CalendarWorkspaceProps,
} from "./CalendarWorkspace";

afterEach(cleanup);
const event: LifeOpsCalendarEvent = {
  id: "event",
  externalId: "external",
  agentId: "agent",
  provider: "eliza",
  side: "owner",
  calendarId: "calendar",
  title: "Planning",
  description: "",
  location: "",
  status: "confirmed",
  startAt: new Date(2026, 9, 30, 10).toISOString(),
  endAt: new Date(2026, 9, 30, 11).toISOString(),
  isAllDay: false,
  timezone: "UTC",
  htmlLink: null,
  conferenceLink: null,
  organizer: null,
  attendees: [],
  metadata: {},
  syncedAt: "2026-10-30T09:00:00Z",
  updatedAt: "2026-10-30T09:00:00Z",
};
function props(): CalendarWorkspaceProps {
  return {
    calendar: {
      events: [event],
      status: "ready",
      error: null,
      refreshing: false,
      viewMode: "day",
      setViewMode: vi.fn(),
      baseDate: new Date(2026, 9, 30),
      windowStart: new Date(2026, 9, 30),
      windowEnd: new Date(2026, 9, 31),
      refresh: vi.fn(async () => {}),
      goToToday: vi.fn(),
      goPrevious: vi.fn(),
      goNext: vi.fn(),
    },
    selectedEventId: null,
    onOpenEvent: vi.fn(),
    onCreateEvent: vi.fn(),
  };
}
describe("controlled Calendar workspace", () => {
  it("opens the exact displayed event and delegates creation/navigation without owning a client", () => {
    const p = props();
    render(<CalendarWorkspace {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /Planning/ }));
    expect(p.onOpenEvent).toHaveBeenCalledWith(event);
    fireEvent.click(screen.getByRole("button", { name: "New event" }));
    expect(p.onCreateEvent).toHaveBeenCalledWith(p.calendar.windowStart);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(p.calendar.goNext).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    expect(p.calendar.setViewMode).toHaveBeenCalledWith("month");
  });
  it("keeps source uncertainty visible and never labels an unavailable feed empty", () => {
    const p = props();
    p.calendar = {
      ...p.calendar,
      events: [],
      status: "unavailable",
      error: "The source did not answer",
    };
    render(<CalendarWorkspace {...p} />);
    expect(screen.getByText("The source did not answer")).toBeTruthy();
    expect(screen.getByText("Calendar unavailable")).toBeTruthy();
    expect(screen.queryByText("No events in this range")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(p.calendar.refresh).toHaveBeenCalledOnce();
  });
  it("retains a partial feed while reporting that sources are incomplete", () => {
    const p = props();
    p.calendar = { ...p.calendar, status: "partial" };
    render(<CalendarWorkspace {...p} />);
    expect(
      screen.getByText(
        "Some calendar sources are unavailable. Events may be incomplete.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Planning/ })).toBeTruthy();
    expect(screen.queryByText("No events in this range")).toBeNull();
  });
});
