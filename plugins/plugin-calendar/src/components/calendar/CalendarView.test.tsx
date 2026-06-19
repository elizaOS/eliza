// @vitest-environment jsdom

import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UseCalendarWeekResult } from "../../hooks/useCalendarWeek.js";

/**
 * CalendarView is the registered top-level calendar overlay view. It is a thin
 * host wrapper that mounts the rich `CalendarSection` (nav + view-mode control +
 * grids + event editor), owns the selection id, and routes a chat-about-event
 * request through `setActionNotice`.
 *
 * These tests mock the same modules CalendarSection.test.tsx does (so the host
 * data hook, agent surface, and editor drawer stay offline) and assert the wrap
 * actually renders CalendarSection (grid/nav + populated events), drives the
 * navigation through to the hook, and propagates selection to the drawer — i.e.
 * the old day/week/month placeholder is gone.
 */

const setActionNotice = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Spinner: () => <span data-testid="spinner" />,
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode; asChild?: boolean }) =>
    children,
  PopoverContent: ({
    children,
    ...props
  }: { children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  SegmentedControl: <T extends string>({
    value,
    onValueChange,
    items,
  }: {
    value: T;
    onValueChange: (value: T) => void;
    items: Array<{ value: T; label: ReactNode }>;
  }) => (
    <div data-segmented-control>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={item.value === value}
          data-testid={`view-${item.value}`}
          onClick={() => onValueChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
  useApp: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? _key,
    setActionNotice,
  }),
  useMediaQuery: () => false,
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: () => {}, agentProps: {} }),
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

// Drawer stub: surfaces open state + the selected event title + an onChat hook
// so CalendarView's chat-about-event wiring is observable.
vi.mock("../EventEditorDrawer.js", () => ({
  EventEditorDrawer: ({
    open,
    mode,
    event,
    onChat,
  }: {
    open: boolean;
    mode?: string;
    event: LifeOpsCalendarEvent | null;
    onChat?: (event: LifeOpsCalendarEvent) => void;
  }) =>
    open ? (
      <div data-testid={`event-editor-drawer-${mode}`}>
        <span data-testid="drawer-event-title">{event?.title ?? ""}</span>
        {event && onChat ? (
          <button
            type="button"
            data-testid="drawer-chat"
            onClick={() => onChat(event)}
          >
            chat
          </button>
        ) : null}
      </div>
    ) : null,
}));

import { CalendarView } from "./CalendarView.js";

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

describe("CalendarView (mounts CalendarSection)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calendarState.current = makeResult();
  });

  afterEach(() => {
    cleanup();
  });

  it("mounts CalendarSection — the rich nav/grid, not the old placeholder", () => {
    render(<CalendarView />);

    // CalendarSection's section + nav controls render.
    expect(screen.getByTestId("lifeops-calendar-section")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Today" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
    // The view-mode SegmentedControl is present (not the old role=tab switcher).
    expect(screen.getByTestId("view-week")).toBeTruthy();
    expect(screen.getByTestId("lifeops-calendar-new-event")).toBeTruthy();

    // The old stub placeholders are gone.
    expect(screen.queryByText("Week view — 7-day event grid.")).toBeNull();
    expect(screen.queryByText("No conflicts detected.")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Week" })).toBeNull();
  });

  it("renders populated week-view events from the feed", () => {
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

    expect(screen.getByText("Design sync")).toBeTruthy();
    expect(screen.getByText("Room 4B")).toBeTruthy();
  });

  it("drives the navigation callbacks through to the hook", () => {
    render(<CalendarView />);

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(goPrevious).toHaveBeenCalledTimes(1);
    expect(goNext).toHaveBeenCalledTimes(1);
  });

  it("selecting an event opens the edit drawer with that event", () => {
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

    // No drawer until an event is selected.
    expect(screen.queryByTestId("event-editor-drawer-edit")).toBeNull();

    fireEvent.click(screen.getByText("Design sync"));

    // CalendarView owns selectedEventId; selecting keeps the drawer open with
    // the right event (proves the state round-trips through the wrapper).
    const drawer = screen.getByTestId("event-editor-drawer-edit");
    expect(within(drawer).getByTestId("drawer-event-title").textContent).toBe(
      "Design sync",
    );
  });

  it("routes chat-about-event through setActionNotice", () => {
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
    fireEvent.click(screen.getByText("Design sync"));
    fireEvent.click(screen.getByTestId("drawer-chat"));

    expect(setActionNotice).toHaveBeenCalledTimes(1);
    expect(setActionNotice.mock.calls[0]?.[0]).toContain("Design sync");
    expect(setActionNotice.mock.calls[0]?.[1]).toBe("info");
  });
});
