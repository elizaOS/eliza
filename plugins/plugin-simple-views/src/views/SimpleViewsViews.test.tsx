/**
 * Verifies that Notes and Calendar are read-only projections of authoritative
 * capability state across loading, empty, populated, and error conditions.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SimpleCalendarEvent,
  SimpleViewsSnapshot,
  StickyNote,
} from "../types.js";
import type { SimpleViewsState } from "./useSimpleViewsState.js";

const stateHook = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

vi.mock("./useSimpleViewsState.js", () => ({
  useSimpleViewsState: stateHook,
}));

import { NotesView } from "./NotesView.js";
import { SimpleCalendarView } from "./SimpleCalendarView.js";

function snapshot(
  revision: number,
  selectedDate = "2026-07-15",
): SimpleViewsSnapshot {
  return { notes: [], events: [], selectedDate, revision };
}

function stickyNote(overrides: Partial<StickyNote> = {}): StickyNote {
  return {
    id: "note-1",
    title: "Release checklist",
    body: "Verify the signed build",
    color: "yellow",
    createdAt: "2026-07-22T12:00:00.000Z",
    updatedAt: "2026-07-22T12:00:00.000Z",
    ...overrides,
  };
}

function calendarEvent(
  overrides: Partial<SimpleCalendarEvent> = {},
): SimpleCalendarEvent {
  return {
    id: "event-1",
    title: "Cloud review",
    date: "2026-07-15",
    time: "15:00",
    notes: "Verify the signed native build",
    color: "green",
    createdAt: "2026-07-22T12:00:00.000Z",
    updatedAt: "2026-07-22T12:00:00.000Z",
    ...overrides,
  };
}

function hookState(
  overrides: Partial<SimpleViewsState> = {},
): SimpleViewsState {
  return {
    snapshot: null,
    loading: false,
    busy: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    mutate: vi.fn(),
    ...overrides,
  };
}

function expectNoDirectControls(container: HTMLElement): void {
  expect(container.querySelector("form")).toBeNull();
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelector("input")).toBeNull();
  expect(container.querySelector("textarea")).toBeNull();
  expect(container.querySelector("select")).toBeNull();
}

beforeEach(() => stateHook.mockReset());
afterEach(cleanup);

describe("Simple Views state labels", () => {
  it("uses accessible view names without redundant summary headings", () => {
    const notesSnapshot = snapshot(4);
    notesSnapshot.notes = [stickyNote()];
    stateHook.mockReturnValue(hookState({ snapshot: notesSnapshot }));
    const notes = render(<NotesView />);
    expect(
      screen.getByRole("main", {
        name: "Notes. 1 note · revision 4",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { level: 1, name: "Notes" }),
    ).toBeNull();
    expect(screen.getByRole("region", { name: "Notes" })).toBeTruthy();
    notes.unmount();

    render(<SimpleCalendarView />);
    expect(
      screen.getByRole("main", {
        name: "Calendar. 0 events · revision 4",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { level: 1, name: "Calendar" }),
    ).toBeNull();
  });

  it.each([
    { height: 499, label: "compact", width: 315 },
    { height: 800, label: "desktop", width: 1280 },
  ])(
    "extends each scroll surface beneath chat while keeping its tail reachable at $label size",
    ({ height, width }) => {
      Object.defineProperties(window, {
        innerHeight: { configurable: true, value: height },
        innerWidth: { configurable: true, value: width },
      });
      const surfaceSnapshot = snapshot(1);
      surfaceSnapshot.notes = [stickyNote()];
      stateHook.mockReturnValue(hookState({ snapshot: surfaceSnapshot }));
      const notes = render(<NotesView />);
      const notesRoot = notes.getByTestId("simple-notes-view");
      expect(notesRoot.style.height).toBe("100%");
      expect(notesRoot.style.width).toBe("100%");
      expect(notesRoot.style.minHeight).toBe("0px");
      expect(notesRoot.style.position).toBe("relative");
      expect(notesRoot.style.overflowY).toBe("hidden");
      const notesScroll = notes.getByTestId("simple-notes-scroll-region");
      expect(notesScroll.style.position).toBe("absolute");
      expect(notesScroll.style.overflowY).toBe("auto");
      expect(notesScroll.style.insetBlockEnd).toBe("0px");
      expect(notesScroll.style.insetInlineEnd).toBe("0px");
      expect(notesScroll.style.paddingBottom).toContain(
        "--eliza-chat-clearance",
      );
      expect(notesScroll.style.paddingInlineEnd).toContain(
        "--eliza-chat-side-clearance",
      );
      expect(notesScroll.style.scrollPaddingBottom).toContain(
        "--eliza-chat-clearance",
      );
      const notesGrid = notes.getByRole("region", {
        name: "Notes",
      }).firstElementChild as HTMLElement;
      expect(notesGrid.style.gridTemplateColumns).toBe(
        "repeat(auto-fill, minmax(230px, 1fr))",
      );
      notes.unmount();

      const calendar = render(<SimpleCalendarView />);
      const calendarRoot = calendar.getByTestId("simple-calendar-view");
      expect(calendarRoot.style.height).toBe("100%");
      expect(calendarRoot.style.width).toBe("100%");
      expect(calendarRoot.style.minHeight).toBe("0px");
      expect(calendarRoot.style.position).toBe("relative");
      expect(calendarRoot.style.overflowY).toBe("hidden");
      const calendarScroll = calendar.getByTestId(
        "simple-calendar-scroll-region",
      );
      expect(calendarScroll.style.position).toBe("absolute");
      expect(calendarScroll.style.overflowY).toBe("auto");
      expect(calendarScroll.style.insetBlockEnd).toBe("0px");
      expect(calendarScroll.style.insetInlineEnd).toBe("0px");
      expect(calendarScroll.style.paddingBottom).toContain(
        "--eliza-chat-clearance",
      );
      expect(calendarScroll.style.paddingInlineEnd).toContain(
        "--eliza-chat-side-clearance",
      );
      expect(calendarScroll.style.scrollPaddingBottom).toContain(
        "--eliza-chat-clearance",
      );
      expect(calendarScroll.style.gridTemplateColumns).toBe(
        "repeat(auto-fit, minmax(280px, 1fr))",
      );
    },
  );

  it("does not report healthy zero counts before the first snapshot", () => {
    stateHook.mockReturnValue(hookState({ loading: true }));
    const notes = render(<NotesView />);
    expect(
      screen.getByRole("main", {
        name: "Notes. Loading shared notes…",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Loading…");
    expect(screen.queryByText(/0 notes/)).toBeNull();
    notes.unmount();

    render(<SimpleCalendarView />);
    expect(
      screen.getByRole("main", {
        name: "Calendar. Loading shared calendar…",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Loading…");
    expect(screen.queryByText(/0 events/)).toBeNull();
  });

  it("distinguishes synchronization errors from healthy empty state", () => {
    stateHook.mockReturnValue(
      hookState({ snapshot: snapshot(4), error: "Agent disconnected" }),
    );
    const notes = render(<NotesView />);
    expect(
      screen.getByRole("main", {
        name: "Notes. Sync unavailable · revision 4",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Agent disconnected",
    );
    expect(screen.queryByText(/0 notes/)).toBeNull();
    notes.unmount();

    render(<SimpleCalendarView />);
    expect(
      screen.getByRole("main", {
        name: "Calendar. Sync unavailable · revision 4",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Agent disconnected",
    );
    expect(screen.queryByText(/0 events/)).toBeNull();
  });

  it("reports empty counts only after a successful snapshot", () => {
    stateHook.mockReturnValue(hookState({ snapshot: snapshot(7) }));
    const notes = render(<NotesView />);
    expect(
      screen.getByRole("main", {
        name: "Notes. 0 notes · revision 7",
      }),
    ).toBeTruthy();
    expect(screen.getByText("A quiet note wall")).toBeTruthy();
    notes.unmount();

    render(<SimpleCalendarView />);
    expect(
      screen.getByRole("main", {
        name: "Calendar. 0 events · revision 7",
      }),
    ).toBeTruthy();
    expect(screen.getByText("No plans yet")).toBeTruthy();
  });
});

describe("chat-only presentation", () => {
  it("renders authoritative notes without direct mutation controls", () => {
    const populated = snapshot(4);
    populated.notes = [stickyNote()];
    const mutate = vi.fn();
    stateHook.mockReturnValue(hookState({ snapshot: populated, mutate }));

    const notes = render(<NotesView />);

    expect(screen.getByText("Release checklist")).toBeTruthy();
    expect(screen.getByText("Verify the signed build")).toBeTruthy();
    expectNoDirectControls(notes.container);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("renders the capability-selected date and events without direct controls", () => {
    const populated = snapshot(5);
    populated.events = [
      calendarEvent(),
      { ...calendarEvent(), id: "event-2", title: "Investor follow-up" },
    ];
    const mutate = vi.fn();
    stateHook.mockReturnValue(hookState({ snapshot: populated, mutate }));

    const calendar = render(<SimpleCalendarView />);

    expect(screen.getByRole("heading", { name: "July 2026" })).toBeTruthy();
    expect(screen.getByText("Cloud review")).toBeTruthy();
    expect(screen.getByText("Investor follow-up")).toBeTruthy();
    expect(screen.getAllByText("Verify the signed native build")).toHaveLength(
      2,
    );
    expect(
      screen.getByLabelText("2 events on Wednesday, July 15, 2026"),
    ).toBeTruthy();
    expectNoDirectControls(calendar.container);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("follows a selected-date capability update without local cursor state", () => {
    stateHook.mockReturnValue(hookState({ snapshot: snapshot(1) }));
    const view = render(<SimpleCalendarView />);
    expect(screen.getByRole("heading", { name: "July 2026" })).toBeTruthy();

    stateHook.mockReturnValue(
      hookState({ snapshot: snapshot(2, "2026-09-08") }),
    );
    view.rerender(<SimpleCalendarView />);

    expect(
      screen.getByRole("heading", { name: "September 2026" }),
    ).toBeTruthy();
    expectNoDirectControls(view.container);
  });
});
