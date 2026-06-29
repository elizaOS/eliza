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
import { client } from "../../api";
import type { ViewEntry } from "../../hooks/view-catalog";
import {
  SPRINGBOARD_DOCK_LIMIT,
  SPRINGBOARD_STORAGE_KEY,
} from "../../state/springboard-layout";
import { runAnimationFramesImmediately } from "../../testing/run-animation-frames-immediately";
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
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Springboard", () => {
  it("renders every view as a names-only icon tile", () => {
    render(<Springboard entries={FEW} onLaunch={() => {}} />);
    expect(screen.getByTestId("springboard-tile-chat")).toBeTruthy();
    expect(screen.getByTestId("springboard-tile-settings")).toBeTruthy();
    // Label text is present (names below icons), no descriptions.
    expect(screen.getByText("Chat")).toBeTruthy();
  });

  it("marks preview and developer tiles without changing release tiles", () => {
    render(
      <Springboard
        entries={[
          entry("settings", "Settings"),
          { ...entry("alpha", "Alpha"), viewKind: "preview" },
          { ...entry("trace", "Trace"), viewKind: "developer" },
        ]}
        onLaunch={() => {}}
      />,
    );

    expect(screen.queryByTestId("springboard-kind-settings")).toBeNull();
    expect(screen.getByTestId("springboard-kind-alpha").textContent).toBe(
      "Preview",
    );
    expect(screen.getByTestId("springboard-kind-trace").textContent).toBe(
      "Dev",
    );
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

  it("favorites a view into the dock and persists the layout", () => {
    // `notes` is not in DEFAULT_SPRINGBOARD_FAVORITES (#9144), so favoriting it
    // genuinely adds it to the dock rather than toggling off a pre-seeded id.
    const entries = [entry("notes", "Notes"), entry("settings", "Settings")];
    render(<Springboard entries={entries} onLaunch={() => {}} />);
    longPressToEdit("Notes");
    fireEvent.click(screen.getByTestId("springboard-fav-notes"));
    // The dock now contains a Notes tile (keyed dock-notes).
    expect(screen.getByTestId("springboard-tile-notes")).toBeTruthy();
    const stored = JSON.parse(
      window.localStorage.getItem(SPRINGBOARD_STORAGE_KEY) ?? "{}",
    );
    expect(stored.favorites).toContain("notes");
  });

  it("shows page dots when there is more than one page", () => {
    const many = Array.from({ length: 49 }, (_, i) =>
      entry(`v${i}`, `View ${i}`),
    );
    render(<Springboard entries={many} onLaunch={() => {}} />);
    expect(screen.getByRole("button", { name: "Page 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Page 2" })).toBeTruthy();
  });

  it("navigates pages via the page dots", () => {
    const many = Array.from({ length: 49 }, (_, i) =>
      entry(`v${i}`, `View ${i}`),
    );
    render(<Springboard entries={many} onLaunch={() => {}} />);
    // Page 1 shows the first page's views, not the first item on page 2.
    expect(
      within(screen.getByTestId("springboard-page-0")).queryByTestId(
        "springboard-tile-v24",
      ),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Page 2" }));
    const secondPage = screen.getByTestId("springboard-page-1");
    expect(secondPage.getAttribute("aria-hidden")).toBe("false");
    expect(within(secondPage).getByTestId("springboard-tile-v24")).toBeTruthy();
  });

  it("slides adjacent pages with the finger before committing a page swipe", () => {
    runAnimationFramesImmediately();
    const many = Array.from({ length: 49 }, (_, i) =>
      entry(`v${i}`, `View ${i}`),
    );
    render(<Springboard entries={many} onLaunch={() => {}} />);

    const pageWindow = screen.getByTestId("springboard-page-window");
    Object.defineProperty(pageWindow, "clientWidth", {
      configurable: true,
      value: 390,
    });
    const rail = screen.getByTestId("springboard-page-rail");
    fireEvent.pointerDown(pageWindow, {
      isPrimary: true,
      pointerId: 3,
      clientX: 320,
      clientY: 300,
    });
    fireEvent.pointerMove(pageWindow, {
      isPrimary: true,
      pointerId: 3,
      clientX: 220,
      clientY: 304,
    });

    expect(rail.style.transform).toContain("-100px");
    expect(rail.style.transition).toBe("none");

    fireEvent.pointerUp(pageWindow, {
      isPrimary: true,
      pointerId: 3,
      clientX: 170,
      clientY: 304,
    });

    expect(
      screen
        .getByRole("button", { name: "Page 2" })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(rail.style.transform).toContain("translate3d(-390px,0,0)");
  });

  it("rubber-bands at the last page edge instead of dead-stopping", () => {
    runAnimationFramesImmediately();
    const many = Array.from({ length: 49 }, (_, i) =>
      entry(`v${i}`, `View ${i}`),
    );
    render(<Springboard entries={many} onLaunch={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Page 3" }));
    const pageWindow = screen.getByTestId("springboard-page-window");
    Object.defineProperty(pageWindow, "clientWidth", {
      configurable: true,
      value: 390,
    });
    const rail = screen.getByTestId("springboard-page-rail");

    fireEvent.pointerDown(pageWindow, {
      isPrimary: true,
      pointerId: 4,
      clientX: 120,
      clientY: 300,
    });
    fireEvent.pointerMove(pageWindow, {
      isPrimary: true,
      pointerId: 4,
      clientX: 20,
      clientY: 304,
    });

    expect(rail.style.transform).toContain("-815px");
    expect(rail.style.transition).toBe("none");

    fireEvent.pointerUp(pageWindow, {
      isPrimary: true,
      pointerId: 4,
      clientX: 20,
      clientY: 304,
    });

    expect(rail.style.transform).toContain("translate3d(-780px,0,0)");
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
  it("renders a compact image icon over a glyph fallback when imageUrl is set", () => {
    const { container } = render(
      <Springboard
        entries={[imageEntry("notes", "Notes", "/api/views/notes/hero")]}
        onLaunch={() => {}}
      />,
    );
    const image = screen.getByTestId("springboard-image-notes");
    expect(image.getAttribute("src")).toBe("/api/views/notes/hero");
    const visual = container.querySelector<HTMLElement>(
      '[data-view-visual="notes"]',
    );
    expect(visual).toBeTruthy();
    expect(visual?.querySelector("img")).toBeTruthy();
    expect(visual?.querySelector("svg")).toBeTruthy();
    // The launch button is still labelled for a11y + tap.
    expect(screen.getByRole("button", { name: "Notes" })).toBeTruthy();
  });

  it("renders the icon glyph when imageUrl is absent", () => {
    const { container } = render(
      <Springboard entries={[entry("notes", "Notes")]} onLaunch={() => {}} />,
    );
    expect(screen.queryByTestId("springboard-image-notes")).toBeNull();
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("falls back to a glyph instead of probing API heroes on dedicated cloud agents", () => {
    vi.spyOn(client, "getBaseUrl").mockReturnValue(
      "https://23766030-c096-4a14-932a-a4e43c562432.elizacloud.ai",
    );

    const { container } = render(
      <Springboard
        entries={[imageEntry("notes", "Notes", "/api/views/notes/hero")]}
        onLaunch={() => {}}
      />,
    );

    expect(screen.queryByTestId("springboard-image-notes")).toBeNull();
    const visual = container.querySelector<HTMLElement>(
      '[data-view-visual="notes"]',
    );
    expect(visual?.querySelector("svg")).toBeTruthy();
  });

  it("falls back to a glyph for already-resolved dedicated cloud API heroes", () => {
    const { container } = render(
      <Springboard
        entries={[
          imageEntry(
            "notes",
            "Notes",
            "https://23766030-c096-4a14-932a-a4e43c562432.elizacloud.ai/api/views/notes/hero",
          ),
        ]}
        onLaunch={() => {}}
      />,
    );

    expect(screen.queryByTestId("springboard-image-notes")).toBeNull();
    const visual = container.querySelector<HTMLElement>(
      '[data-view-visual="notes"]',
    );
    expect(visual?.querySelector("svg")).toBeTruthy();
  });
});

describe("Springboard long-press to edit", () => {
  afterEach(() => vi.useRealTimers());

  it("enters edit mode after a long press on a tile", () => {
    vi.useFakeTimers();
    render(<Springboard entries={FEW} onLaunch={() => {}} />);
    // Resting: no per-tile pin affordances (there is no Edit button anymore).
    expect(screen.queryByTestId("springboard-fav-chat")).toBeNull();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Chat" }));
    act(() => {
      vi.advanceTimersByTime(450);
    });

    // Edit mode is on: per-tile pin affordances appear.
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
    // Still resting: no pin affordances surfaced.
    expect(screen.queryByTestId("springboard-fav-chat")).toBeNull();
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
    expect(screen.queryByTestId("springboard-fav-chat")).toBeNull();
  });
});

describe("Springboard controlled favorites (desktop tabs)", () => {
  it("clamps the dock to SPRINGBOARD_DOCK_LIMIT even when more are supplied", () => {
    // Controlled mode (onToggleFavorite set) renders the caller's favoriteIds.
    // A caller that supplies more than the cap must still render at most
    // SPRINGBOARD_DOCK_LIMIT dock tiles (the iOS-style 4-slot dock).
    const ids = ["a", "b", "c", "d", "e", "f"];
    render(
      <Springboard
        entries={ids.map((id) => entry(id, id.toUpperCase()))}
        onLaunch={() => {}}
        favoriteIds={ids}
        onToggleFavorite={() => {}}
      />,
    );
    const dockTiles = screen
      .getByTestId("springboard-dock")
      .querySelectorAll('[data-testid^="springboard-tile-"]');
    expect(dockTiles).toHaveLength(SPRINGBOARD_DOCK_LIMIT);
  });
});

describe("Springboard dock favorites (local, uncontrolled)", () => {
  // None of these ids are in DEFAULT_SPRINGBOARD_FAVORITES, so the seeded dock
  // reconciles to empty and each favorite is a genuine add.
  const MANY = ["a", "b", "c", "d", "e"].map((id) =>
    entry(id, id.toUpperCase()),
  );

  it("unpins a favorited view from the dock", () => {
    // `notes` and `archive` are not default-dock ids (#9144), so the seeded dock
    // reconciles to empty and the dock only exists once we pin `notes`.
    render(
      <Springboard
        entries={[entry("notes", "Notes"), entry("archive", "Archive")]}
        onLaunch={() => {}}
      />,
    );
    longPressToEdit("Notes");
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
    longPressToEdit("A");
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
