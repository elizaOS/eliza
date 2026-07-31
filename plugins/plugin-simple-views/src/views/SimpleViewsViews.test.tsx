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
import type { SimpleViewsSnapshot, StickyNote } from "../types.js";
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
  it("uses accessible view names without rendering redundant summary headings", () => {
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
    expect(
      screen
        .getByRole("button", { name: "Clear" })
        .closest("section")
        ?.getAttribute("aria-label"),
    ).toBe("Notes");
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

  it("gives compact note controls native accessible names", () => {
    stateHook.mockReturnValue(hookState({ snapshot: snapshot(1) }));

    const notes = render(<NotesView />);
    const yellow = notes.container.querySelector(
      '[aria-label="Use yellow color"]',
    );

    expect(yellow).toBeTruthy();
    expect(yellow?.textContent).toBe("");
  });

  it.each([
    { height: 499, label: "compact", width: 315 },
    { height: 800, label: "desktop", width: 1280 },
  ])(
    "lets each view own scrolling inside the overflow-hidden host at $label size",
    ({ height, width }) => {
      Object.defineProperties(window, {
        innerHeight: { configurable: true, value: height },
        innerWidth: { configurable: true, value: width },
      });
      stateHook.mockReturnValue(hookState({ snapshot: snapshot(1) }));
      const notes = render(<NotesView />);
      const notesRoot = notes.getByTestId("simple-notes-view");
      expect(notesRoot.style.height).toContain("--eliza-chat-clearance");
      expect(notesRoot.style.width).toContain("--eliza-chat-side-clearance");
      expect(notesRoot.style.minHeight).toBe("0px");
      expect(notesRoot.style.overflowY).toBe("auto");
      expect(notesRoot.style.paddingBottom).not.toContain(
        "--eliza-chat-clearance",
      );
      expect(notesRoot.style.paddingInlineEnd).not.toContain(
        "--eliza-chat-side-clearance",
      );
      notes.unmount();

      const calendar = render(<SimpleCalendarView />);
      const calendarRoot = calendar.getByTestId("simple-calendar-view");
      expect(calendarRoot.style.height).toContain("--eliza-chat-clearance");
      expect(calendarRoot.style.width).toContain("--eliza-chat-side-clearance");
      expect(calendarRoot.style.minHeight).toBe("0px");
      expect(calendarRoot.style.overflowY).toBe("auto");
      expect(calendarRoot.style.paddingBottom).not.toContain(
        "--eliza-chat-clearance",
      );
      expect(calendarRoot.style.paddingInlineEnd).not.toContain(
        "--eliza-chat-side-clearance",
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

  it("does not report healthy zero counts while synchronization is in error", () => {
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

describe("Notes direct interactions", () => {
  it("creates a colored note and resets an abandoned draft", async () => {
    const mutate = vi.fn().mockResolvedValue(undefined);
    stateHook.mockReturnValue(hookState({ snapshot: snapshot(1), mutate }));
    render(<NotesView />);

    const title = screen.getByLabelText<HTMLInputElement>("Note title");
    const details = screen.getByLabelText<HTMLTextAreaElement>("Note details");
    fireEvent.change(title, { target: { value: "Throw this away" } });
    fireEvent.change(details, { target: { value: "Temporary draft" } });
    fireEvent.click(screen.getByTitle("Reset draft"));
    expect(title.value).toBe("");
    expect(details.value).toBe("");

    fireEvent.change(title, { target: { value: "  Demo notes  " } });
    fireEvent.change(details, {
      target: { value: "Keep this across view switches" },
    });
    fireEvent.click(screen.getByTitle("Green"));
    const form = title.closest("form");
    if (!form) throw new Error("Notes form is required.");
    fireEvent.submit(form);

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith("create-note", {
        title: "Demo notes",
        body: "Keep this across view switches",
        color: "green",
      }),
    );
    await waitFor(() => expect(title.value).toBe(""));
  });

  it("renders, edits, deletes, and clears authoritative notes", async () => {
    const mutate = vi.fn().mockResolvedValue(undefined);
    const populated = snapshot(4);
    populated.notes = [stickyNote()];
    stateHook.mockReturnValue(hookState({ snapshot: populated, mutate }));
    render(<NotesView />);

    expect(screen.getByText("Release checklist")).toBeTruthy();
    expect(screen.getByText("Verify the signed build")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Edit note"));
    const title = screen.getByLabelText<HTMLInputElement>("Note title");
    expect(title.value).toBe("Release checklist");
    fireEvent.change(title, { target: { value: "Release ready" } });
    fireEvent.click(screen.getByTitle("Rose"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith("update-note", {
        id: "note-1",
        title: "Release ready",
        body: "Verify the signed build",
        color: "rose",
      }),
    );

    fireEvent.click(screen.getByTitle("Delete note"));
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith("delete-note", { id: "note-1" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm clear" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledWith("clear-notes"));
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

  it("stacks native date controls before their values can truncate", () => {
    stateHook.mockReturnValue(hookState({ snapshot: snapshot(7) }));
    render(<SimpleCalendarView />);

    const fields = screen.getByTestId("calendar-event-schedule-fields");
    expect(fields.style.gridTemplateColumns).toBe(
      "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
    );
    expect(
      screen.getByLabelText<HTMLInputElement>("Calendar event date").value,
    ).toBe("2026-07-15");
    expect(
      screen.getByLabelText<HTMLInputElement>("Calendar event time").value,
    ).toBe("09:00");
  });
});
