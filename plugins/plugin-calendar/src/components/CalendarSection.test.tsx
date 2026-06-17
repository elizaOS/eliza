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
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UseCalendarWeekResult } from "../hooks/useCalendarWeek.js";

// ---------------------------------------------------------------------------
// Mocks: @elizaos/ui primitives, agent-surface, the data hook, and the drawer.
// ---------------------------------------------------------------------------

const mediaQueryState = vi.hoisted(() => ({ compact: false }));

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
  // Popover stub: render trigger + content inline so we can click and assert.
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
    setActionNotice: vi.fn(),
  }),
  useMediaQuery: () => mediaQueryState.compact,
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: () => {}, agentProps: {} }),
}));

const calendarState = vi.hoisted(() => ({
  current: null as UseCalendarWeekResult | null,
}));

vi.mock("../hooks/useCalendarWeek.js", () => ({
  useCalendarWeek: () => calendarState.current,
}));

// Lightweight drawer stub: exposes the open state + mode and an onClose hook so
// CalendarSection's open/close wiring is observable without the real drawer's
// network calls.
vi.mock("./EventEditorDrawer.js", () => ({
  EventEditorDrawer: ({
    open,
    mode,
    event,
    onClose,
  }: {
    open: boolean;
    mode?: string;
    event: LifeOpsCalendarEvent | null;
    onClose: () => void;
  }) =>
    open ? (
      <div data-testid={`event-editor-drawer-${mode}`}>
        <span data-testid="drawer-event-title">{event?.title ?? ""}</span>
        <button type="button" data-testid="drawer-close" onClick={onClose}>
          close
        </button>
      </div>
    ) : null,
}));

import { CalendarSection } from "./CalendarSection.js";

// ---------------------------------------------------------------------------
// Fixtures + default hook result.
// ---------------------------------------------------------------------------

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

const goPrevious = vi.fn();
const goNext = vi.fn();
const goToToday = vi.fn();
const setViewMode = vi.fn();
const refresh = vi.fn(async () => {});

function makeResult(
  over: Partial<UseCalendarWeekResult> = {},
): UseCalendarWeekResult {
  const baseDate = new Date("2026-06-15T12:00:00.000Z");
  const windowStart = new Date("2026-06-14T00:00:00.000Z");
  const windowEnd = new Date("2026-06-21T00:00:00.000Z");
  return {
    events: [],
    loading: false,
    error: null,
    viewMode: "week",
    setViewMode,
    baseDate,
    windowStart,
    windowEnd,
    refresh,
    goToToday,
    goPrevious,
    goNext,
    ...over,
  };
}

const noopProps = {
  selectedEventId: null as string | null,
  onSelectEvent: vi.fn(),
  onChatAboutEvent: vi.fn(),
  getPrimedEvent: () => null,
};

/**
 * Host harness that owns `selectedEventId` the way the real dashboard shell
 * does, so clicking an event both notifies selection AND keeps the edit drawer
 * open (CalendarSection's sync effect resets the drawer when selectedEventId is
 * null). `onSelectEvent` is spied via the injected callback.
 */
function ControlledCalendarSection({
  onSelect,
  onChatAboutEvent = vi.fn(),
}: {
  onSelect: (id: string | null) => void;
  onChatAboutEvent?: (event: LifeOpsCalendarEvent) => void;
}) {
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  return (
    <CalendarSection
      selectedEventId={selectedEventId}
      onSelectEvent={(id) => {
        setSelectedEventId(id);
        onSelect(id);
      }}
      onChatAboutEvent={onChatAboutEvent}
      getPrimedEvent={() => null}
    />
  );
}

describe("CalendarSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mediaQueryState.compact = false;
    calendarState.current = makeResult();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders week-view events with their titles and times in the time grid", () => {
    // 09:00-10:00 local (built from a local-tz time so the rendered hour is
    // stable regardless of test-runner timezone).
    const start = new Date(2026, 5, 15, 9, 0, 0);
    const end = new Date(2026, 5, 15, 10, 0, 0);
    calendarState.current = makeResult({
      events: [
        evt({
          id: "e1",
          title: "Design sync",
          location: "Room 4B",
          startAt: start.toISOString(),
          endAt: end.toISOString(),
        }),
        evt({
          id: "e2",
          title: "Lunch",
          startAt: new Date(2026, 5, 16, 12, 0, 0).toISOString(),
          endAt: new Date(2026, 5, 16, 13, 0, 0).toISOString(),
        }),
      ],
    });

    render(<CalendarSection {...noopProps} />);

    // Specific event data is on screen.
    expect(screen.getByText("Design sync")).toBeTruthy();
    expect(screen.getByText("Room 4B")).toBeTruthy();
    expect(screen.getByText("Lunch")).toBeTruthy();
    // The event block renders its formatted start time (e.g. "9:00 AM").
    expect(screen.getByText(/9:00\s*AM/i)).toBeTruthy();
    // The week range header is present.
    expect(screen.getByText(/June 2026/)).toBeTruthy();
  });

  it("invokes the navigation callbacks for prev/today/next", () => {
    render(<CalendarSection {...noopProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(goPrevious).toHaveBeenCalledTimes(1);
    expect(goToToday).toHaveBeenCalledTimes(1);
    expect(goNext).toHaveBeenCalledTimes(1);
  });

  it("switches the view mode through the SegmentedControl", () => {
    render(<CalendarSection {...noopProps} />);

    fireEvent.click(screen.getByTestId("view-day"));
    expect(setViewMode).toHaveBeenCalledWith("day");

    fireEvent.click(screen.getByTestId("view-month"));
    expect(setViewMode).toHaveBeenCalledWith("month");
  });

  it("opens the create drawer when the New button is clicked", () => {
    render(<CalendarSection {...noopProps} />);

    expect(screen.queryByTestId("event-editor-drawer-create")).toBeNull();
    fireEvent.click(screen.getByTestId("lifeops-calendar-new-event"));
    expect(screen.getByTestId("event-editor-drawer-create")).toBeTruthy();
  });

  it("opens the edit drawer with the event and notifies selection when an event is clicked", () => {
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
    const onSelect = vi.fn();
    render(<ControlledCalendarSection onSelect={onSelect} />);

    fireEvent.click(screen.getByText("Design sync"));

    expect(onSelect).toHaveBeenCalledWith("e1");
    const drawer = screen.getByTestId("event-editor-drawer-edit");
    expect(within(drawer).getByTestId("drawer-event-title").textContent).toBe(
      "Design sync",
    );
  });

  it("renders the +N more overflow popover listing every event in month view", () => {
    const day = (h: number) => new Date(2026, 5, 15, h, 0, 0).toISOString();
    calendarState.current = makeResult({
      viewMode: "month",
      events: [
        evt({ id: "m1", title: "Standup", startAt: day(8), endAt: day(9) }),
        evt({ id: "m2", title: "1:1", startAt: day(10), endAt: day(11) }),
        evt({ id: "m3", title: "Review", startAt: day(13), endAt: day(14) }),
        evt({ id: "m4", title: "Retro", startAt: day(15), endAt: day(16) }),
        evt({ id: "m5", title: "Demo", startAt: day(17), endAt: day(18) }),
      ],
    });

    render(<CalendarSection {...noopProps} />);

    // Month cells show only the first 3; the overflow trigger covers the rest.
    expect(screen.getByText("+2 more")).toBeTruthy();
    // The overflow popover content lists ALL five events (4th + 5th included).
    const overflow = screen.getByTestId("lifeops-calendar-day-overflow");
    expect(within(overflow).getByText("Retro")).toBeTruthy();
    expect(within(overflow).getByText("Demo")).toBeTruthy();
  });

  it("renders the agenda layout with meta lines on compact (mobile) screens", () => {
    mediaQueryState.compact = true;
    calendarState.current = makeResult({
      events: [
        evt({
          id: "a1",
          title: "Dentist",
          location: "Downtown Clinic",
          calendarSummary: "Personal",
          startAt: new Date(2026, 5, 15, 9, 0, 0).toISOString(),
          endAt: new Date(2026, 5, 15, 10, 0, 0).toISOString(),
        }),
      ],
    });

    render(<CalendarSection {...noopProps} />);

    expect(screen.getByText("Dentist")).toBeTruthy();
    // Agenda meta line concatenates time range, location, and calendar summary.
    const meta = screen.getByText(/Downtown Clinic/);
    expect(meta.textContent).toContain("Personal");
    expect(meta.textContent).toMatch(/9[:.]?0?0?\s*AM/i);
  });

  it("shows the empty status when the agenda feed has no events", () => {
    mediaQueryState.compact = true;
    calendarState.current = makeResult({ events: [] });

    render(<CalendarSection {...noopProps} />);

    expect(screen.getByRole("status", { name: "Calendar clear" })).toBeTruthy();
  });

  it("renders the error banner when the hook reports an error", () => {
    calendarState.current = makeResult({ error: "Calendar failed to load." });

    render(<CalendarSection {...noopProps} />);

    expect(screen.getByText("Calendar failed to load.")).toBeTruthy();
  });
});
