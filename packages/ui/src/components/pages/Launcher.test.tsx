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
import { runAnimationFramesImmediately } from "../../testing/run-animation-frames-immediately";
import { Launcher } from "./Launcher";

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
const LEGACY_SPRINGBOARD_STORAGE_KEY = "elizaos.views.springboard";

/**
 * Enter edit mode the only way the launcher offers it — a long-press on a tile.
 * Self-contained: it installs fake timers just for the long-press window so
 * callers that otherwise run on real timers stay unaffected.
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

describe("Launcher", () => {
  it("renders every view as a page tile (no dock)", () => {
    render(<Launcher entries={FEW} onLaunch={() => {}} />);
    // The featured-views dock was removed: every view lives on the pages.
    expect(screen.queryByTestId("launcher-dock")).toBeNull();
    const page = within(screen.getByTestId("launcher-page-0"));
    expect(page.getByTestId("launcher-tile-chat")).toBeTruthy();
    expect(page.getByTestId("launcher-tile-settings")).toBeTruthy();
    // Label text is present (names below icons), no descriptions.
    expect(screen.getByText("Chat")).toBeTruthy();
  });

  it("renders all curated ids on the page in grouped mode (no dock)", () => {
    render(
      <Launcher
        entries={[
          entry("chat", "Chat"),
          entry("settings", "Settings"),
          entry("wallet", "Wallet"),
        ]}
        pageGroups={[["chat", "settings", "wallet"]]}
        onLaunch={() => {}}
      />,
    );

    expect(screen.queryByTestId("launcher-dock")).toBeNull();
    const page = within(screen.getByTestId("launcher-page-0"));
    expect(page.getByTestId("launcher-tile-chat")).toBeTruthy();
    expect(page.getByTestId("launcher-tile-settings")).toBeTruthy();
    expect(page.getByTestId("launcher-tile-wallet")).toBeTruthy();
  });

  it("migrates a Springboard layout onto the pages (legacy favorites flow back to the grid)", () => {
    // A pre-removal layout carried a `favorites` array; parsing drops it, so any
    // previously-docked id flows back onto the grid via reconcile while the
    // manual page order is preserved.
    window.localStorage.setItem(
      LEGACY_SPRINGBOARD_STORAGE_KEY,
      JSON.stringify({
        favorites: ["chat"],
        pages: [["settings"]],
        manual: true,
      }),
    );

    render(<Launcher entries={FEW} onLaunch={() => {}} />);

    expect(screen.queryByTestId("launcher-dock")).toBeNull();
    const tileIds = Array.from(
      screen
        .getByTestId("launcher-page-0")
        .querySelectorAll<HTMLElement>('[data-testid^="launcher-tile-"]'),
    ).map((node) =>
      node.getAttribute("data-testid")?.replace("launcher-tile-", ""),
    );
    // Manual order preserved (settings first), legacy-docked chat appended.
    expect(tileIds).toEqual(["settings", "chat"]);
  });

  it("preserves the manual page order from a migrated Springboard layout", () => {
    window.localStorage.setItem(
      LEGACY_SPRINGBOARD_STORAGE_KEY,
      JSON.stringify({
        favorites: [],
        pages: [["beta", "alpha"]],
        manual: true,
      }),
    );

    render(
      <Launcher
        entries={[entry("alpha", "Alpha"), entry("beta", "Beta")]}
        onLaunch={() => {}}
      />,
    );

    const tileIds = Array.from(
      screen
        .getByTestId("launcher-page-0")
        .querySelectorAll<HTMLElement>('[data-testid^="launcher-tile-"]'),
    ).map((node) =>
      node.getAttribute("data-testid")?.replace("launcher-tile-", ""),
    );
    expect(tileIds).toEqual(["beta", "alpha"]);
  });

  it("marks preview and developer tiles without changing release tiles", () => {
    render(
      <Launcher
        entries={[
          entry("settings", "Settings"),
          { ...entry("alpha", "Alpha"), viewKind: "preview" },
          { ...entry("trace", "Trace"), viewKind: "developer" },
        ]}
        onLaunch={() => {}}
      />,
    );

    expect(screen.queryByTestId("launcher-kind-settings")).toBeNull();
    expect(screen.getByTestId("launcher-kind-alpha").textContent).toBe(
      "Preview",
    );
    expect(screen.getByTestId("launcher-kind-trace").textContent).toBe("Dev");
  });

  it("launches a view on tap (not in edit mode)", () => {
    const onLaunch = vi.fn();
    render(<Launcher entries={FEW} onLaunch={onLaunch} />);
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch.mock.calls[0][0].id).toBe("chat");
  });

  it("does not launch while editing", () => {
    const onLaunch = vi.fn();
    render(<Launcher entries={FEW} onLaunch={onLaunch} />);
    longPressToEdit("Settings");
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("shows page dots when there is more than one page", () => {
    const many = Array.from({ length: 49 }, (_, i) =>
      entry(`v${i}`, `View ${i}`),
    );
    render(<Launcher entries={many} onLaunch={() => {}} />);
    expect(screen.getByRole("button", { name: "Page 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Page 2" })).toBeTruthy();
  });

  it("navigates pages via the page dots", () => {
    const many = Array.from({ length: 49 }, (_, i) =>
      entry(`v${i}`, `View ${i}`),
    );
    render(<Launcher entries={many} onLaunch={() => {}} />);
    // Page 1 shows the first page's views, not the first item on page 2.
    expect(
      within(screen.getByTestId("launcher-page-0")).queryByTestId(
        "launcher-tile-v24",
      ),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Page 2" }));
    const secondPage = screen.getByTestId("launcher-page-1");
    expect(secondPage.getAttribute("aria-hidden")).toBe("false");
    expect(within(secondPage).getByTestId("launcher-tile-v24")).toBeTruthy();
  });

  it("slides adjacent pages with the finger before committing a page swipe", () => {
    runAnimationFramesImmediately();
    const many = Array.from({ length: 49 }, (_, i) =>
      entry(`v${i}`, `View ${i}`),
    );
    render(<Launcher entries={many} onLaunch={() => {}} />);

    const pageWindow = screen.getByTestId("launcher-page-window");
    Object.defineProperty(pageWindow, "clientWidth", {
      configurable: true,
      value: 390,
    });
    const rail = screen.getByTestId("launcher-page-rail");
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
    render(<Launcher entries={many} onLaunch={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Page 3" }));
    const pageWindow = screen.getByTestId("launcher-page-window");
    Object.defineProperty(pageWindow, "clientWidth", {
      configurable: true,
      value: 390,
    });
    const rail = screen.getByTestId("launcher-page-rail");

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
    const { rerender } = render(<Launcher entries={FEW} onLaunch={() => {}} />);
    expect(screen.getByTestId("launcher-tile-settings")).toBeTruthy();
    rerender(
      <Launcher entries={[entry("chat", "Chat")]} onLaunch={() => {}} />,
    );
    expect(screen.queryByTestId("launcher-tile-settings")).toBeNull();
  });

  it("appends a newly-available view as a tile on re-render", () => {
    const { rerender } = render(
      <Launcher entries={[entry("chat", "Chat")]} onLaunch={() => {}} />,
    );
    expect(screen.queryByTestId("launcher-tile-notes")).toBeNull();
    rerender(
      <Launcher
        entries={[entry("chat", "Chat"), entry("notes", "Notes")]}
        onLaunch={() => {}}
      />,
    );
    expect(screen.getByTestId("launcher-tile-notes")).toBeTruthy();
  });
});

describe("Launcher image tiles", () => {
  it("renders a compact image icon over a glyph fallback when imageUrl is set", () => {
    const { container } = render(
      <Launcher
        entries={[imageEntry("notes", "Notes", "/api/views/notes/hero")]}
        onLaunch={() => {}}
      />,
    );
    const image = screen.getByTestId("launcher-image-notes");
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
      <Launcher entries={[entry("notes", "Notes")]} onLaunch={() => {}} />,
    );
    expect(screen.queryByTestId("launcher-image-notes")).toBeNull();
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("falls back to a glyph instead of probing API heroes on dedicated cloud agents", () => {
    vi.spyOn(client, "getBaseUrl").mockReturnValue(
      "https://23766030-c096-4a14-932a-a4e43c562432.elizacloud.ai",
    );

    const { container } = render(
      <Launcher
        entries={[imageEntry("notes", "Notes", "/api/views/notes/hero")]}
        onLaunch={() => {}}
      />,
    );

    expect(screen.queryByTestId("launcher-image-notes")).toBeNull();
    const visual = container.querySelector<HTMLElement>(
      '[data-view-visual="notes"]',
    );
    expect(visual?.querySelector("svg")).toBeTruthy();
  });

  it("falls back to a glyph for already-resolved dedicated cloud API heroes", () => {
    const { container } = render(
      <Launcher
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

    expect(screen.queryByTestId("launcher-image-notes")).toBeNull();
    const visual = container.querySelector<HTMLElement>(
      '[data-view-visual="notes"]',
    );
    expect(visual?.querySelector("svg")).toBeTruthy();
  });
});

describe("Launcher long-press to edit", () => {
  afterEach(() => vi.useRealTimers());

  it("enters edit mode after a long press on a tile", () => {
    vi.useFakeTimers();
    render(<Launcher entries={FEW} onLaunch={() => {}} />);
    // Resting: tiles are not animated.
    expect(
      screen.getByRole("button", { name: "Chat" }).className,
    ).not.toContain("animate-pulse");

    fireEvent.pointerDown(screen.getByRole("button", { name: "Chat" }));
    act(() => {
      vi.advanceTimersByTime(450);
    });

    // Edit mode is on: tiles animate (the iOS-style jiggle proxy).
    expect(screen.getByRole("button", { name: "Chat" }).className).toContain(
      "animate-pulse",
    );
  });

  it("does not enter edit mode when the press is released early", () => {
    vi.useFakeTimers();
    render(<Launcher entries={FEW} onLaunch={() => {}} />);
    const tile = screen.getByRole("button", { name: "Chat" });
    fireEvent.pointerDown(tile);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.pointerUp(tile);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    // Still resting: no animation.
    expect(
      screen.getByRole("button", { name: "Chat" }).className,
    ).not.toContain("animate-pulse");
  });

  it("cancels the long-press when the pointer is cancelled (touch scroll)", () => {
    // On touch, a scroll/system gesture fires pointercancel (not pointerup); the
    // long-press timer must be cleared so edit mode never ghost-fires.
    vi.useFakeTimers();
    render(<Launcher entries={FEW} onLaunch={() => {}} />);
    const tile = screen.getByRole("button", { name: "Chat" });
    fireEvent.pointerDown(tile);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.pointerCancel(tile);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(
      screen.getByRole("button", { name: "Chat" }).className,
    ).not.toContain("animate-pulse");
  });
});
