/**
 * Verifies the Notes and Calendar state labels plus Calendar month navigation
 * without replacing their real rendered component structure.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimpleViewsSnapshot } from "../types.js";
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

beforeEach(() => stateHook.mockReset());
afterEach(cleanup);

describe("Simple Views state labels", () => {
  it("lets each view own scrolling inside the overflow-hidden host", () => {
    stateHook.mockReturnValue(hookState({ snapshot: snapshot(1) }));
    const notes = render(<NotesView />);
    const notesRoot = notes.getByTestId("simple-notes-view");
    expect(notesRoot.style.overflowY).toBe("auto");
    expect(notesRoot.style.scrollPaddingBottom).toContain(
      "--eliza-continuous-chat-clearance",
    );
    expect(notesRoot.style.scrollPaddingInlineEnd).toContain(
      "--eliza-continuous-chat-side-clearance",
    );
    notes.unmount();

    const calendar = render(<SimpleCalendarView />);
    const calendarRoot = calendar.getByTestId("simple-calendar-view");
    expect(calendarRoot.style.overflowY).toBe("auto");
    expect(calendarRoot.style.scrollPaddingBottom).toContain(
      "--eliza-continuous-chat-clearance",
    );
    expect(calendarRoot.style.scrollPaddingInlineEnd).toContain(
      "--eliza-continuous-chat-side-clearance",
    );
  });

  it("does not report healthy zero counts before the first snapshot", () => {
    stateHook.mockReturnValue(hookState({ loading: true }));
    const notes = render(<NotesView />);
    expect(screen.getByText("Loading shared notes…")).toBeTruthy();
    expect(screen.queryByText(/0 notes/)).toBeNull();
    notes.unmount();

    render(<SimpleCalendarView />);
    expect(screen.getByText("Loading shared calendar…")).toBeTruthy();
    expect(screen.queryByText(/0 events/)).toBeNull();
  });

  it("does not report healthy zero counts while synchronization is in error", () => {
    stateHook.mockReturnValue(
      hookState({ snapshot: snapshot(4), error: "Agent disconnected" }),
    );
    const notes = render(<NotesView />);
    expect(screen.getByText("Sync unavailable · revision 4")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Agent disconnected",
    );
    expect(screen.queryByText(/0 notes/)).toBeNull();
    notes.unmount();

    render(<SimpleCalendarView />);
    expect(screen.getByText("Sync unavailable · revision 4")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Agent disconnected",
    );
    expect(screen.queryByText(/0 events/)).toBeNull();
  });

  it("reports empty counts only after a successful snapshot", () => {
    stateHook.mockReturnValue(hookState({ snapshot: snapshot(7) }));
    const notes = render(<NotesView />);
    expect(screen.getByText("0 notes · revision 7")).toBeTruthy();
    notes.unmount();

    render(<SimpleCalendarView />);
    expect(screen.getByText("0 events · revision 7")).toBeTruthy();
  });
});

describe("Simple Calendar month cursor", () => {
  it("preserves manual month navigation across unrelated snapshot revisions", async () => {
    stateHook.mockReturnValue(hookState({ snapshot: snapshot(1) }));
    const view = render(<SimpleCalendarView />);

    fireEvent.click(screen.getByTitle("Next month"));
    expect(screen.getByRole("heading", { name: "August 2026" })).toBeTruthy();

    stateHook.mockReturnValue(hookState({ snapshot: snapshot(2) }));
    view.rerender(<SimpleCalendarView />);
    expect(screen.getByRole("heading", { name: "August 2026" })).toBeTruthy();

    stateHook.mockReturnValue(
      hookState({ snapshot: snapshot(3, "2026-09-08") }),
    );
    view.rerender(<SimpleCalendarView />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "September 2026" }),
      ).toBeTruthy(),
    );
  });
});
