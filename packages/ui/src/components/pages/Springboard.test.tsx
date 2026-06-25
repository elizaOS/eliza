// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewEntry } from "../../hooks/view-catalog";
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

/**
 * Enter edit mode the only way the springboard now offers it — a long-press on a
 * tile (the visible Edit button was removed per product). Self-contained: it
 * installs fake timers just for the long-press window so callers that otherwise
 * run on real timers stay unaffected.
 */
function longPressToEdit(label: string): void {
  vi.useFakeTimers();
  const tile = screen.getByRole("button", { name: label });
  fireEvent.pointerDown(tile);
  act(() => {
    vi.advanceTimersByTime(450);
  });
  fireEvent.pointerUp(tile);
  vi.useRealTimers();
}

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
    longPressToEdit("Settings");
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("renders no favorites dock — every tile is a uniform page tile", () => {
    const entries = [entry("notes", "Notes"), entry("settings", "Settings")];
    render(<Springboard entries={entries} onLaunch={() => {}} />);
    // The dark favorites dock is gone entirely.
    expect(screen.queryByTestId("springboard-dock")).toBeNull();
    // Both views render as ordinary page tiles (nothing held back in a dock).
    expect(screen.getByTestId("springboard-tile-notes")).toBeTruthy();
    expect(screen.getByTestId("springboard-tile-settings")).toBeTruthy();
  });

  it("renders every tile uniformly with no dark card or border", () => {
    const entries = [entry("notes", "Notes"), entry("settings", "Settings")];
    const { container } = render(
      <Springboard entries={entries} onLaunch={() => {}} />,
    );
    // No tile carries the old dark-card / border classes.
    expect(container.querySelector(".bg-black\\/35")).toBeNull();
    expect(container.querySelector(".bg-black\\/45")).toBeNull();
    expect(container.querySelector(".border-white\\/10")).toBeNull();
    // Both launch buttons share the identical naked tile class string.
    const buttons = Array.from(
      container.querySelectorAll(
        '[data-testid^="springboard-tile-"] > div > button',
      ),
    );
    expect(buttons).toHaveLength(2);
    const classes = new Set(buttons.map((b) => b.getAttribute("class")));
    expect(classes.size).toBe(1);
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

  /** Edit mode pulses every tile (the only resting→editing visual now that the
   *  pin badge is gone). A pulsing tile is the edit-mode signal. */
  const editingTileCount = () =>
    document.querySelectorAll(
      '[data-testid^="springboard-tile-"] button.animate-pulse',
    ).length;

  it("enters edit mode after a long press on a tile", () => {
    vi.useFakeTimers();
    render(<Springboard entries={FEW} onLaunch={() => {}} />);
    // Resting: no tile is pulsing.
    expect(editingTileCount()).toBe(0);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Chat" }));
    act(() => {
      vi.advanceTimersByTime(450);
    });

    // Edit mode is on: tiles pulse.
    expect(editingTileCount()).toBeGreaterThan(0);
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
    // Still resting: no pulse.
    expect(editingTileCount()).toBe(0);
  });

  it("cancels the long-press when the pointer is cancelled (touch scroll)", () => {
    // On touch, a scroll/system gesture fires pointercancel (not pointerup); the
    // long-press timer must be cleared so edit mode never ghost-fires.
    vi.useFakeTimers();
    render(<Springboard entries={FEW} onLaunch={() => {}} />);
    const tile = screen.getByRole("button", { name: "Chat" });
    fireEvent.pointerDown(tile);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.pointerCancel(tile);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(editingTileCount()).toBe(0);
  });
});

describe("Springboard desktop-tab props (favorites dock removed)", () => {
  it("ignores favoriteIds / onToggleFavorite — renders no dock, plain page tiles", () => {
    // The favorites props are retained for desktop-tab type compatibility but
    // no longer render a dock. Supplying them must not produce a dock.
    const ids = ["a", "b", "c", "d", "e", "f"];
    render(
      <Springboard
        entries={ids.map((id) => entry(id, id.toUpperCase()))}
        onLaunch={() => {}}
        favoriteIds={ids}
        onToggleFavorite={() => {}}
      />,
    );
    expect(screen.queryByTestId("springboard-dock")).toBeNull();
    // Every supplied view renders exactly once as a page tile.
    for (const id of ids) {
      expect(screen.getAllByTestId(`springboard-tile-${id}`)).toHaveLength(1);
    }
  });
});
