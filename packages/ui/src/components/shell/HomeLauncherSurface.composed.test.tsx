// @vitest-environment jsdom
//
// COMPOSED screen-state test — the gap the audit flagged. Every prior test
// rendered HomeLauncherSurface against a one-button stub and the Launcher
// in isolation, so the bugs that live in the COMPOSITION (two stacked dot
// strips, swipe-back landing in jiggle mode) were structurally unreachable.
// This renders the REAL HomeLauncherSurface wrapping the REAL
// LauncherSurface, driven by the single shell-surface store, and asserts the
// real transitions across the seam.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewRegistryEntry } from "../../hooks/useAvailableViews";
import { useRoutableViews } from "../../hooks/useAvailableViews";
import {
  getShellSurface,
  resetShellSurfaceForTests,
} from "../../state/shell-surface-store";
import { useEnabledViewKinds } from "../../state/useViewKinds";
import { runAnimationFramesImmediately } from "../../testing/run-animation-frames-immediately";
import { LauncherSurface } from "../pages/LauncherSurface";
import { HomeLauncherSurface } from "./HomeLauncherSurface";

vi.mock("../../hooks/useAvailableViews", () => ({
  useRoutableViews: vi.fn(),
}));
vi.mock("../../state/useViewKinds", () => ({
  useEnabledViewKinds: vi.fn(),
}));
vi.mock(import("../../platform/platform-guards"), async (importOriginal) => {
  // Partial mock: only pin the view modality. The rest stays real because the
  // home now reaches platform guards through more paths (notification store →
  // push registration) than just the modality read.
  const actual = await importOriginal();
  return { ...actual, getActiveViewModality: () => "gui" as const };
});

const useRoutableViewsMock = vi.mocked(useRoutableViews);
const useEnabledViewKindsMock = vi.mocked(useEnabledViewKinds);

function view(
  id: string,
  label: string,
  path: string,
  options: Partial<ViewRegistryEntry> = {},
): ViewRegistryEntry {
  return {
    id,
    label,
    viewType: "gui",
    path,
    available: true,
    pluginName: "@elizaos/builtin",
    visibleInManager: true,
    builtin: true,
    viewKind: "release",
    ...options,
  };
}

// Curated apps + 24 extra loaded apps, all on the launcher's single scrolling
// page. The composed surface deliberately renders no page-indicator strip:
// home/launcher navigation is gesture-only.
const DOCK_VIEWS = [
  view("settings", "Settings", "/settings", { icon: "Settings" }),
  view("browser", "Browser", "/browser", { icon: "Globe" }),
  view("character", "Character", "/character", { icon: "Bot" }),
  view("activity", "Activity", "/activity", { icon: "Activity" }),
];
const PAGE_VIEWS = Array.from({ length: 24 }, (_, i) =>
  view(`app${i}`, `App ${i}`, `/apps/app${i}`),
);
const HIDDEN_VIEWS = [
  view("background", "Background", "/background", {
    icon: "Image",
    viewKind: "system",
  }),
];
const ALL_VIEWS = [...DOCK_VIEWS, ...PAGE_VIEWS, ...HIDDEN_VIEWS];

beforeEach(() => {
  resetShellSurfaceForTests();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  useEnabledViewKindsMock.mockReturnValue({ developer: true, preview: true });
  useRoutableViewsMock.mockReturnValue({
    views: ALL_VIEWS,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  resetShellSurfaceForTests();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function renderComposed() {
  render(
    <HomeLauncherSurface
      home={<div data-testid="home-content">home</div>}
      launcher={<LauncherSurface />}
    />,
  );
  return screen.getByTestId("home-launcher-surface");
}

function flick(testid: string, dx: number, dy = 4): void {
  const el = screen.getByTestId(testid);
  fireEvent.pointerDown(el, {
    isPrimary: true,
    pointerId: 1,
    clientX: 260,
    clientY: 300,
  });
  fireEvent.pointerMove(el, {
    isPrimary: true,
    pointerId: 1,
    clientX: 260 + dx,
    clientY: 300 + dy,
  });
  fireEvent.pointerUp(el, {
    isPrimary: true,
    pointerId: 1,
    clientX: 260 + dx,
    clientY: 300 + dy,
  });
}

const openLauncher = () => flick("home-launcher-home-page", -140);
// A real finger on the launcher lands on the page window (it fills the launcher
// half); the events bubble up to the outer rail's half div, which owns the
// back-to-home gesture and tracks it 1:1 (there is no inner grid pager).
const swipeBackHome = () => flick("launcher-page-window", 140);

describe("Home ↔ Launcher composed surface", () => {
  it("tracks the rail with the finger before committing a home ↔ launcher swipe", () => {
    runAnimationFramesImmediately();
    const surface = renderComposed();
    Object.defineProperty(surface, "clientWidth", {
      configurable: true,
      value: 390,
    });
    const homePage = screen.getByTestId("home-launcher-home-page");
    const rail = screen.getByTestId("home-launcher-rail");

    fireEvent.pointerDown(homePage, {
      isPrimary: true,
      pointerId: 2,
      clientX: 260,
      clientY: 300,
    });
    fireEvent.pointerMove(homePage, {
      isPrimary: true,
      pointerId: 2,
      clientX: 170,
      clientY: 304,
    });

    expect(rail.style.transform).toContain("-90px");
    expect(rail.style.transition).toBe("none");

    fireEvent.pointerUp(homePage, {
      isPrimary: true,
      pointerId: 2,
      clientX: 120,
      clientY: 304,
    });

    expect(surface.getAttribute("data-page")).toBe("launcher");
    expect(rail.style.transform).toContain("translate3d(-390px,0,0)");
  }, 15_000);

  it("renders no page-indicator strips — no dots competing with the composer (#4)", () => {
    const surface = renderComposed();
    openLauncher();
    expect(surface.getAttribute("data-page")).toBe("launcher");

    expect(screen.queryByTestId("home-launcher-indicator")).toBeNull();
    expect(screen.queryByLabelText("Home")).toBeNull();
    expect(screen.queryByLabelText("Apps page 1")).toBeNull();
    expect(document.querySelectorAll('[aria-label^="Page "]').length).toBe(0);
  });

  it("swiping back from the launcher returns HOME (#3)", () => {
    const surface = renderComposed();
    openLauncher();
    expect(surface.getAttribute("data-page")).toBe("launcher");

    // Swipe back. This is the exact gesture that used to strand the user in
    // jiggle mode; the curated launcher is read-only, so it just returns home.
    swipeBackHome();
    expect(surface.getAttribute("data-page")).toBe("home");

    openLauncher();
    expect(surface.getAttribute("data-page")).toBe("launcher");
  });

  it("is read-only: a long-press never enters edit mode (#3)", () => {
    vi.useFakeTimers();
    renderComposed();
    openLauncher();

    // A stationary hold past the long-press threshold must NOT enter edit mode —
    // the curated launcher has a fixed placement, no reordering. Edit mode
    // animates tiles with `animate-pulse`, so its absence is the read-only proof.
    const tile = screen
      .getByTestId("launcher-tile-settings")
      .querySelector("button");
    if (!tile) throw new Error("settings tile button missing");
    fireEvent.pointerDown(tile, { clientX: 50, clientY: 50 });
    act(() => vi.advanceTimersByTime(600));
    expect(tile.className).not.toContain("animate-pulse");
    vi.useRealTimers();
  });

  it("does not render a Background tile because backgrounds live in Settings", () => {
    renderComposed();
    openLauncher();

    expect(screen.queryByTestId("launcher-tile-background")).toBeNull();
    expect(screen.queryByRole("button", { name: "Background" })).toBeNull();
  });

  it("uses horizontal swipes, not rail dots, to move between home and launcher", () => {
    const surface = renderComposed();
    openLauncher();
    expect(surface.getAttribute("data-page")).toBe("launcher");
    expect(screen.queryByTestId("home-launcher-indicator")).toBeNull();

    swipeBackHome();
    expect(surface.getAttribute("data-page")).toBe("home");
  });

  // ── Gestures that start on a launcher tile ride the OUTER rail ────────────
  // Every gesture below starts on a TILE inside the launcher page window. The
  // Launcher has no inner grid pager, so the pointer events bubble straight to
  // the outer rail's half-div handlers, which own home↔launcher navigation.

  /** Mock a fixed layout width (jsdom reports 0) on the rail viewport. */
  function mockClientWidth(el: HTMLElement, value: number): void {
    Object.defineProperty(el, "clientWidth", { configurable: true, value });
  }

  /** A tile inside the launcher page window — NOT the dock. */
  function tileInLauncher(): HTMLElement {
    const tile = screen
      .getByTestId("launcher-page-window")
      .querySelector<HTMLElement>('[data-testid^="launcher-tile-"]');
    if (!tile) throw new Error("no tile inside the launcher page window");
    return tile;
  }

  function renderComposedOnLauncher(): {
    surface: HTMLElement;
    outerRail: HTMLElement;
    tile: HTMLElement;
  } {
    runAnimationFramesImmediately();
    const surface = renderComposed();
    mockClientWidth(surface, 390);
    openLauncher();
    expect(surface.getAttribute("data-page")).toBe("launcher");
    return {
      surface,
      outerRail: screen.getByTestId("home-launcher-rail"),
      tile: tileInLauncher(),
    };
  }

  it("a left drag on a launcher tile does NOT navigate — the launcher is the last rail page", () => {
    const { surface, outerRail, tile } = renderComposedOnLauncher();
    const outerResting = outerRail.style.transform;
    const opts = {
      isPrimary: true,
      pointerId: 11,
      pointerType: "mouse",
      clientY: 300,
    } as const;

    fireEvent.pointerDown(tile, { ...opts, clientX: 300 });
    fireEvent.pointerMove(tile, { ...opts, clientX: 280 });
    fireEvent.pointerMove(tile, { ...opts, clientX: 100 });
    fireEvent.pointerUp(tile, { ...opts, clientX: 100 });

    // The launcher is the rail's last page, so a left-drag has nowhere to go:
    // the outer rail settles back to its resting launcher offset (the drag only
    // painted its damped right-edge rubber-band).
    expect(surface.getAttribute("data-page")).toBe("launcher");
    expect(outerRail.style.transform).toBe(outerResting);
  });

  it("a left drag on a launcher tile rubber-bands the OUTER rail (last rail page)", () => {
    const { outerRail, tile } = renderComposedOnLauncher();
    const opts = {
      isPrimary: true,
      pointerId: 12,
      pointerType: "touch",
      clientY: 300,
    } as const;

    fireEvent.pointerDown(tile, { ...opts, clientX: 300 });
    fireEvent.pointerMove(tile, { ...opts, clientX: 280 });
    fireEvent.pointerMove(tile, { ...opts, clientX: 180 });

    // The launcher is the rail's LAST page, so the left-drag paints the damped
    // rubber-band on the OUTER rail (-390 + -120·EDGE_RESISTANCE = -432px),
    // exactly like iOS's last-home-page overscroll.
    expect(outerRail.style.transform).toContain("-432px");

    fireEvent.pointerUp(tile, { ...opts, clientX: 180 });
    // No commit: still on the launcher, rail settled back.
    expect(getShellSurface().page).toBe("launcher");
    expect(outerRail.style.transform).toContain("-390px");
  });

  it("a swipe right on a launcher tile returns HOME (the outer rail owns the back-swipe)", () => {
    const { surface, tile } = renderComposedOnLauncher();
    const opts = {
      isPrimary: true,
      pointerId: 13,
      pointerType: "touch",
      clientY: 300,
    } as const;

    fireEvent.pointerDown(tile, { ...opts, clientX: 100 });
    fireEvent.pointerMove(tile, { ...opts, clientX: 120 });
    fireEvent.pointerMove(tile, { ...opts, clientX: 300 });
    fireEvent.pointerUp(tile, { ...opts, clientX: 300 });

    // The outer rail owns the swipe-right-back-to-home gesture, tracks it 1:1,
    // and commits home on release.
    expect(surface.getAttribute("data-page")).toBe("home");
    expect(getShellSurface().page).toBe("home");
  });

  it("launcher tiles render DISTINCT generated app-icon imagery (#5)", () => {
    renderComposed();
    openLauncher();

    const settingsVisual = document.querySelector<HTMLElement>(
      '[data-view-visual="settings"]',
    );
    const browserVisual = document.querySelector<HTMLElement>(
      '[data-view-visual="browser"]',
    );
    expect(settingsVisual).toBeTruthy();
    expect(browserVisual).toBeTruthy();
    expect(screen.getByTestId("launcher-image-settings")).toBeTruthy();
    expect(screen.getByTestId("launcher-image-browser")).toBeTruthy();
    expect(settingsVisual?.getAttribute("style")).toContain("linear-gradient");
    expect(browserVisual?.getAttribute("style")).toContain("linear-gradient");

    const settingsGlyph = settingsVisual
      ?.querySelector("svg")
      ?.getAttribute("class");
    const browserGlyph = browserVisual
      ?.querySelector("svg")
      ?.getAttribute("class");
    expect(settingsGlyph).toContain("lucide-settings");
    expect(browserGlyph).toContain("lucide-globe");
    expect(settingsGlyph).not.toBe(browserGlyph);
  });
});
