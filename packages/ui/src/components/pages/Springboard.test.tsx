// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewEntry } from "../../hooks/view-catalog";
import { SPRINGBOARD_STORAGE_KEY } from "../../state/springboard-layout";
import { Springboard } from "./Springboard";

function entry(id: string, label: string): ViewEntry {
  return {
    key: `view:${id}`,
    id,
    label,
    icon: "LayoutGrid",
    hasHero: false,
    modality: "gui",
    state: "loaded",
    kind: "view",
    viewKind: "release",
  } as ViewEntry;
}

function imageEntry(id: string, label: string, imageUrl: string): ViewEntry {
  return { ...entry(id, label), imageUrl };
}

const FEW = [entry("chat", "Chat"), entry("settings", "Settings")];

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

describe("Springboard", () => {
  it("renders every view as a names-only icon tile", () => {
    render(<Springboard entries={FEW} onLaunch={() => {}} />);
    expect(screen.getByTestId("springboard-tile-chat")).toBeTruthy();
    expect(screen.getByTestId("springboard-tile-settings")).toBeTruthy();
    // Label text is present (names below icons), no descriptions.
    expect(screen.getByText("Chat")).toBeTruthy();
  });

  it("launches a view on tap (not in edit mode)", () => {
    const onLaunch = vi.fn();
    render(<Springboard entries={FEW} onLaunch={onLaunch} />);
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch.mock.calls[0][0].id).toBe("chat");
  });

  it("does not launch while editing", () => {
    const onLaunch = vi.fn();
    render(<Springboard entries={FEW} onLaunch={onLaunch} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("favorites a view into the dock and persists the layout", () => {
    // `notes` is not in DEFAULT_SPRINGBOARD_FAVORITES (#9144), so favoriting it
    // genuinely adds it to the dock rather than toggling off a pre-seeded id.
    const entries = [entry("notes", "Notes"), entry("settings", "Settings")];
    render(<Springboard entries={entries} onLaunch={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByTestId("springboard-fav-notes"));
    // The dock now contains a Notes tile (keyed dock-notes).
    expect(screen.getByTestId("springboard-tile-notes")).toBeTruthy();
    const stored = JSON.parse(
      window.localStorage.getItem(SPRINGBOARD_STORAGE_KEY) ?? "{}",
    );
    expect(stored.favorites).toContain("notes");
  });

  it("shows page dots when there is more than one page", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      entry(`v${i}`, `View ${i}`),
    );
    render(<Springboard entries={many} onLaunch={() => {}} />);
    expect(screen.getByRole("button", { name: "Page 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Page 2" })).toBeTruthy();
  });

  it("navigates pages via the page dots", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      entry(`v${i}`, `View ${i}`),
    );
    render(<Springboard entries={many} onLaunch={() => {}} />);
    // Page 1 shows the first page's views, not the 21st.
    expect(screen.queryByTestId("springboard-tile-v20")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Page 2" }));
    expect(screen.getByTestId("springboard-tile-v20")).toBeTruthy();
  });

  it("drops views that are no longer available on re-render", () => {
    const { rerender } = render(
      <Springboard entries={FEW} onLaunch={() => {}} />,
    );
    expect(screen.getByTestId("springboard-tile-settings")).toBeTruthy();
    rerender(
      <Springboard entries={[entry("chat", "Chat")]} onLaunch={() => {}} />,
    );
    expect(screen.queryByTestId("springboard-tile-settings")).toBeNull();
  });

  it("appends a newly-available view as a tile on re-render", () => {
    const { rerender } = render(
      <Springboard entries={[entry("chat", "Chat")]} onLaunch={() => {}} />,
    );
    expect(screen.queryByTestId("springboard-tile-notes")).toBeNull();
    rerender(
      <Springboard
        entries={[entry("chat", "Chat"), entry("notes", "Notes")]}
        onLaunch={() => {}}
      />,
    );
    expect(screen.getByTestId("springboard-tile-notes")).toBeTruthy();
  });
});

describe("Springboard image tiles", () => {
  it("renders the view's hero image as the tile when imageUrl is set", () => {
    render(
      <Springboard
        entries={[imageEntry("notes", "Notes", "/api/views/notes/hero")]}
        onLaunch={() => {}}
      />,
    );
    const img = screen.getByTestId("springboard-image-notes");
    expect(img.getAttribute("src")).toBe("/api/views/notes/hero");
    // The launch button is still labelled for a11y + tap.
    expect(screen.getByRole("button", { name: "Notes" })).toBeTruthy();
  });

  it("falls back to the icon glyph when the hero image fails to load", () => {
    const { container } = render(
      <Springboard
        entries={[imageEntry("notes", "Notes", "/api/views/notes/hero")]}
        onLaunch={() => {}}
      />,
    );
    const img = screen.getByTestId("springboard-image-notes");
    act(() => {
      fireEvent.error(img);
    });
    // Image is gone; the Lucide fallback glyph renders so the tile is never blank.
    expect(screen.queryByTestId("springboard-image-notes")).toBeNull();
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("renders the icon glyph (no image) when imageUrl is absent", () => {
    const { container } = render(
      <Springboard entries={[entry("notes", "Notes")]} onLaunch={() => {}} />,
    );
    expect(screen.queryByTestId("springboard-image-notes")).toBeNull();
    expect(container.querySelector("svg")).toBeTruthy();
  });
});

describe("Springboard long-press to edit", () => {
  afterEach(() => vi.useRealTimers());

  it("enters edit mode after a long press on a tile", () => {
    vi.useFakeTimers();
    render(<Springboard entries={FEW} onLaunch={() => {}} />);
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Chat" }));
    act(() => {
      vi.advanceTimersByTime(450);
    });

    // Edit mode is on: the toggle now reads "Done" and per-tile pin affordances
    // appear.
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.getByTestId("springboard-fav-chat")).toBeTruthy();
  });

  it("does not enter edit mode when the press is released early", () => {
    vi.useFakeTimers();
    render(<Springboard entries={FEW} onLaunch={() => {}} />);
    const tile = screen.getByRole("button", { name: "Chat" });
    fireEvent.pointerDown(tile);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.pointerUp(tile);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    // Still resting: toggle reads "Edit", no pin affordances.
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.queryByTestId("springboard-fav-chat")).toBeNull();
  });
});

describe("Springboard dock favorites (local, uncontrolled)", () => {
  // None of these ids are in DEFAULT_SPRINGBOARD_FAVORITES, so the seeded dock
  // reconciles to empty and each favorite is a genuine add.
  const MANY = ["a", "b", "c", "d", "e"].map((id) =>
    entry(id, id.toUpperCase()),
  );

  it("unpins a favorited view from the dock", () => {
    // `notes` and `files` are not default-dock ids (#9144), so the seeded dock
    // reconciles to empty and the dock only exists once we pin `notes`.
    render(
      <Springboard
        entries={[entry("notes", "Notes"), entry("files", "Files")]}
        onLaunch={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByTestId("springboard-fav-notes"));
    expect(
      within(screen.getByTestId("springboard-dock")).getByText("Notes"),
    ).toBeTruthy();

    // Toggle it off again → the dock empties and unmounts.
    fireEvent.click(screen.getByTestId("springboard-fav-notes"));
    expect(screen.queryByTestId("springboard-dock")).toBeNull();
    const stored = JSON.parse(
      window.localStorage.getItem(SPRINGBOARD_STORAGE_KEY) ?? "{}",
    );
    expect(stored.favorites).not.toContain("notes");
  });

  it("evicts the oldest favorite when the dock is full", () => {
    render(<Springboard entries={MANY} onLaunch={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    for (const id of ["a", "b", "c", "d", "e"]) {
      fireEvent.click(screen.getByTestId(`springboard-fav-${id}`));
    }
    // Dock caps at 4 → the first-added ("A") is evicted, B–E remain.
    const dock = within(screen.getByTestId("springboard-dock"));
    expect(dock.queryByText("A")).toBeNull();
    expect(dock.getByText("B")).toBeTruthy();
    expect(dock.getByText("E")).toBeTruthy();
    const stored = JSON.parse(
      window.localStorage.getItem(SPRINGBOARD_STORAGE_KEY) ?? "{}",
    );
    expect(stored.favorites).toEqual(["b", "c", "d", "e"]);
  });
});

// Keep `within` referenced for future grouped-dock assertions without lint noise.
void within;
