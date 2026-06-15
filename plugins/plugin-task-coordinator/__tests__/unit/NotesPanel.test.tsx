// @vitest-environment jsdom
//
// Behavioral tests for the Google-Keep-style NotesPanel
// (src/odysseus/NotesPanel.tsx).
//
// NotesPanel owns real client-side logic worth locking down: it hydrates from
// localStorage on open, filters the visible list by the search box (across
// title / body / labels / checklist items), drives the label filter-chip bar,
// expands the quick-add bar into an editor that moves focus into the title
// field, persists a saved note back to localStorage with a normalized payload
// (tags parsed, todo vs. note body split), sorts pinned notes to the top, and
// archives a note with an Undo affordance. We render it standalone (no
// WindowManagerProvider — useWindowControls degrades to a no-op there) and
// assert on the DOM plus the persisted localStorage payload.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotesPanel } from "../../src/odysseus/NotesPanel";

// NotesPanel persists under the namespaced "odysseus:notes" localStorage key
// (util/storage NS prefix + PREF_KEYS.notes).
const NOTES_KEY = "odysseus:notes";

type StoredNote = {
  id: string;
  type: "note" | "todo";
  title: string;
  content: string;
  items: { id: string; text: string; done: boolean }[];
  color: string;
  labels: string[];
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
};

const note = (over: Partial<StoredNote> & { id: string }): StoredNote => ({
  type: "note",
  title: "",
  content: "",
  items: [],
  color: "",
  labels: [],
  pinned: false,
  archived: false,
  createdAt: 1_000,
  updatedAt: 1_000,
  ...over,
});

function seedNotes(notes: StoredNote[]) {
  window.localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
}

function storedNotes(): StoredNote[] {
  const raw = window.localStorage.getItem(NOTES_KEY);
  return raw ? (JSON.parse(raw) as StoredNote[]) : [];
}

function renderOpen() {
  const onClose = vi.fn();
  const utils = render(<NotesPanel open onClose={onClose} />);
  return { ...utils, onClose };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("NotesPanel", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<NotesPanel open={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the empty-state message with no stored notes", () => {
    renderOpen();
    expect(screen.getByText("No notes yet")).toBeTruthy();
  });

  it("hydrates the list from localStorage on open", () => {
    seedNotes([
      note({ id: "a", title: "Buy milk" }),
      note({ id: "b", title: "Call dentist" }),
    ]);
    renderOpen();
    expect(screen.getByText("Buy milk")).toBeTruthy();
    expect(screen.getByText("Call dentist")).toBeTruthy();
    expect(screen.queryByText("No notes yet")).toBeNull();
  });

  it("sorts pinned notes ahead of unpinned ones regardless of recency", () => {
    seedNotes([
      note({ id: "recent", title: "Recent unpinned", updatedAt: 9_000 }),
      note({ id: "old", title: "Old pinned", pinned: true, updatedAt: 1 }),
    ]);
    renderOpen();
    const titles = [...document.querySelectorAll(".od-note-card-title")].map(
      (el) => el.textContent,
    );
    expect(titles[0]).toBe("Old pinned");
    expect(titles[1]).toBe("Recent unpinned");
  });

  it("filters the list by the search box across title and body", () => {
    seedNotes([
      note({ id: "a", title: "Grocery list", content: "milk and eggs" }),
      note({ id: "b", title: "Workout", content: "leg day" }),
    ]);
    renderOpen();
    fireEvent.change(screen.getByLabelText("Search notes"), {
      target: { value: "leg" },
    });
    expect(screen.queryByText("Grocery list")).toBeNull();
    expect(screen.getByText("Workout")).toBeTruthy();
  });

  it("search also matches checklist item text on a todo note", () => {
    seedNotes([
      note({
        id: "a",
        type: "todo",
        title: "Errands",
        items: [{ id: "i1", text: "pick up parcel", done: false }],
      }),
      note({ id: "b", title: "Unrelated", content: "nope" }),
    ]);
    renderOpen();
    fireEvent.change(screen.getByLabelText("Search notes"), {
      target: { value: "parcel" },
    });
    expect(screen.getByText("Errands")).toBeTruthy();
    expect(screen.queryByText("Unrelated")).toBeNull();
  });

  it("Escape in the search box clears a non-empty query, then closes on a second press", () => {
    seedNotes([note({ id: "a", title: "Anything" })]);
    const { onClose } = renderOpen();
    const input = screen.getByLabelText("Search notes") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "xyz" } });
    expect(input.value).toBe("xyz");
    // First Escape clears the query rather than closing.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
    // Second Escape (now empty) closes the panel.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("label filter chips narrow the list to a tag, and 'All' clears the filter", () => {
    seedNotes([
      note({ id: "a", title: "Tagged work", labels: ["work"] }),
      note({ id: "b", title: "Tagged home", labels: ["home"] }),
    ]);
    renderOpen();
    // Scope to the filter-chip bar — the card's own #work label chip would
    // otherwise also match by accessible name.
    const chipBar = document.querySelector(".od-notes-labels") as HTMLElement;
    // The #work chip filters to only the work-tagged note.
    fireEvent.click(within(chipBar).getByRole("button", { name: "#work" }));
    expect(screen.getByText("Tagged work")).toBeTruthy();
    expect(screen.queryByText("Tagged home")).toBeNull();
    // The "All" chip restores the full list.
    fireEvent.click(within(chipBar).getByRole("button", { name: "All" }));
    expect(screen.getByText("Tagged work")).toBeTruthy();
    expect(screen.getByText("Tagged home")).toBeTruthy();
  });

  it("the Default chip surfaces only untagged notes and shows their count", () => {
    seedNotes([
      note({ id: "a", title: "No tags here" }),
      note({ id: "b", title: "Has a tag", labels: ["work"] }),
    ]);
    renderOpen();
    const defaultChip = screen.getByTitle("Notes without tags");
    // Count badge reflects the one untagged note.
    expect(within(defaultChip).getByText("1")).toBeTruthy();
    fireEvent.click(defaultChip);
    expect(screen.getByText("No tags here")).toBeTruthy();
    expect(screen.queryByText("Has a tag")).toBeNull();
  });

  it("typing in the quick-add bar expands the editor and focuses the title field", () => {
    renderOpen();
    const quickInput = screen.getByLabelText("Add note");
    fireEvent.change(quickInput, { target: { value: "New idea" } });
    // The editor's title input is now present, pre-seeded and focused.
    const titleInput = screen.getByLabelText("Note title") as HTMLInputElement;
    expect(titleInput.value).toBe("New idea");
    expect(document.activeElement).toBe(titleInput);
  });

  it("saving a new note persists a normalized payload and renders the card", () => {
    renderOpen();
    // Default quick-add type is "todo"; switch to a free-text note so we can
    // assert the body is saved on the content field.
    fireEvent.change(screen.getByLabelText("Add note"), {
      target: { value: "Seed title" },
    });
    fireEvent.change(screen.getByLabelText("Note title"), {
      target: { value: "Real title" },
    });
    // Switch the editor to a "Note" so the body textarea appears.
    fireEvent.click(screen.getByRole("button", { name: /^Note$/ }));
    fireEvent.change(screen.getByLabelText("Note body"), {
      target: { value: "body text" },
    });
    fireEvent.change(screen.getByLabelText("Tags"), {
      target: { value: "#alpha #beta #alpha" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const saved = storedNotes();
    expect(saved).toHaveLength(1);
    const [n] = saved;
    expect(n.type).toBe("note");
    expect(n.title).toBe("Real title");
    expect(n.content).toBe("body text");
    // Tags are parsed: leading '#' stripped and duplicates removed.
    expect(n.labels).toEqual(["alpha", "beta"]);
    expect(n.archived).toBe(false);
    // The saved card is rendered.
    expect(screen.getByText("Real title")).toBeTruthy();
  });

  it("does not persist an empty draft (no title, no body, no items)", () => {
    renderOpen();
    // Open the editor via the quick-add, then clear the seeded title.
    fireEvent.change(screen.getByLabelText("Add note"), {
      target: { value: "x" },
    });
    fireEvent.change(screen.getByLabelText("Note title"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(storedNotes()).toHaveLength(0);
    expect(screen.getByText("No notes yet")).toBeTruthy();
  });

  it("archiving a note removes it from the active list and offers Undo that restores it", () => {
    seedNotes([note({ id: "a", title: "Keep me" })]);
    renderOpen();
    fireEvent.click(screen.getByRole("button", { name: "Archive note" }));
    // Gone from the active list; the persisted note is now archived.
    expect(screen.queryByText("Keep me")).toBeNull();
    expect(storedNotes()[0].archived).toBe(true);
    // Undo banner is shown and restores the note.
    expect(screen.getByText("Note archived.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByText("Keep me")).toBeTruthy();
    expect(storedNotes()[0].archived).toBe(false);
  });

  it("the archive view lists archived notes and hides them from the active list", () => {
    seedNotes([
      note({ id: "a", title: "Active note" }),
      note({ id: "b", title: "Archived note", archived: true }),
    ]);
    renderOpen();
    // Active list shows only the active note.
    expect(screen.getByText("Active note")).toBeTruthy();
    expect(screen.queryByText("Archived note")).toBeNull();
    // Toggle into the archive view via the header button (title "View archive"
    // distinguishes it from each card's "Archive note" action).
    fireEvent.click(screen.getByTitle("View archive"));
    expect(screen.getByText("Archived note")).toBeTruthy();
    expect(screen.queryByText("Active note")).toBeNull();
  });

  it("toggling a checklist item on a todo card persists the done flag", () => {
    seedNotes([
      note({
        id: "a",
        type: "todo",
        title: "Tasks",
        items: [{ id: "i1", text: "first", done: false }],
      }),
    ]);
    renderOpen();
    fireEvent.click(screen.getByRole("button", { name: "Mark done" }));
    expect(storedNotes()[0].items[0].done).toBe(true);
  });

  it("pinning a note from its card persists the pinned flag", () => {
    seedNotes([note({ id: "a", title: "Pin target" })]);
    renderOpen();
    fireEvent.click(screen.getByRole("button", { name: "Pin note" }));
    expect(storedNotes()[0].pinned).toBe(true);
  });

  it("opening a note's title for edit reveals the editor seeded with its values", () => {
    seedNotes([
      note({ id: "a", title: "Editable", content: "old body", labels: ["x"] }),
    ]);
    renderOpen();
    // Clicking the card title opens the in-place editor.
    fireEvent.click(screen.getByRole("button", { name: "Editable" }));
    const titleInput = screen.getByLabelText("Note title") as HTMLInputElement;
    expect(titleInput.value).toBe("Editable");
    const labelsInput = screen.getByLabelText("Tags") as HTMLInputElement;
    // Labels are re-hydrated back into the "#tag" text form.
    expect(labelsInput.value).toBe("#x");
  });

  it("editing an existing note updates the persisted record in place (no duplicate)", () => {
    seedNotes([note({ id: "a", title: "Before", content: "body" })]);
    renderOpen();
    fireEvent.click(screen.getByRole("button", { name: "Before" }));
    fireEvent.change(screen.getByLabelText("Note title"), {
      target: { value: "After" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const saved = storedNotes();
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe("a");
    expect(saved[0].title).toBe("After");
    expect(screen.getByText("After")).toBeTruthy();
  });
});
