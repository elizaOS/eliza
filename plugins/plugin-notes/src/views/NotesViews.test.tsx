/**
 * Verifies that Notes is a read-only projection of authoritative capability
 * state across loading, empty, populated, and error conditions.
 *
 * @vitest-environment jsdom
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotesSnapshot, StickyNote } from "../types.js";
import type { NotesState } from "./useNotesState.js";

const stateHook = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: (definition: { id: string }) => ({
    ref: { current: null },
    agentProps: { "data-agent-id": definition.id },
  }),
}));

vi.mock("./useNotesState.js", () => ({
  useNotesState: stateHook,
}));

import { NotesView } from "./NotesView.js";

function snapshot(revision: number): NotesSnapshot {
  return { notes: [], revision };
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

function hookState(overrides: Partial<NotesState> = {}): NotesState {
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

describe("Notes state labels", () => {
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
    },
  );

  it("does not report healthy zero counts before the first snapshot", () => {
    stateHook.mockReturnValue(hookState({ loading: true }));
    const _notes = render(<NotesView />);
    expect(
      screen.getByRole("main", {
        name: "Notes. Loading shared notes…",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Loading…");
    expect(screen.queryByText(/0 notes/)).toBeNull();
  });

  it("distinguishes synchronization errors from healthy empty state", () => {
    stateHook.mockReturnValue(
      hookState({ snapshot: snapshot(4), error: "Agent disconnected" }),
    );
    const _notes = render(<NotesView />);
    expect(
      screen.getByRole("main", {
        name: "Notes. Sync unavailable · revision 4",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Agent disconnected",
    );
    expect(screen.queryByText(/0 notes/)).toBeNull();
  });

  it("reports empty counts only after a successful snapshot", () => {
    stateHook.mockReturnValue(hookState({ snapshot: snapshot(7) }));
    const _notes = render(<NotesView />);
    expect(
      screen.getByRole("main", {
        name: "Notes. 0 notes · revision 7",
      }),
    ).toBeTruthy();
    expect(screen.getByText("A quiet note wall")).toBeTruthy();
  });
});

describe("chat-only presentation", () => {
  it("renders authoritative notes without direct mutation controls", () => {
    const populated = snapshot(4);
    populated.notes = [stickyNote()];
    const mutate = vi.fn();
    stateHook.mockReturnValue(hookState({ snapshot: populated, mutate }));

    const notes = render(<NotesView />);

    expect(
      notes.container.querySelector('[data-agent-id="note-1"] p')?.textContent,
    ).toBe("Release checklist\nVerify the signed build");
    expect(
      notes.container
        .querySelector("[data-agent-id]")
        ?.getAttribute("data-agent-id"),
    ).toBe("note-1");
    expectNoDirectControls(notes.container);
    expect(mutate).not.toHaveBeenCalled();
  });
});
