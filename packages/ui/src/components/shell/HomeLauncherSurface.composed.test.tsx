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
import { useViewCatalog } from "../../hooks/useViewCatalog";
import { resetShellSurfaceForTests } from "../../state/shell-surface-store";
import { useEnabledViewKinds } from "../../state/useViewKinds";
import { runAnimationFramesImmediately } from "../../testing/run-animation-frames-immediately";
import { LauncherSurface } from "../pages/LauncherSurface";
import { HomeLauncherSurface } from "./HomeLauncherSurface";

vi.mock("../../hooks/useAvailableViews", () => ({
  useRoutableViews: vi.fn(),
}));
vi.mock("../../hooks/useViewCatalog", () => ({
  useViewCatalog: vi.fn(),
}));
vi.mock("../../state/useViewKinds", () => ({
  useEnabledViewKinds: vi.fn(),
}));
vi.mock("../../platform/platform-guards", () => ({
  getActiveViewModality: () => "gui",
}));

const useRoutableViewsMock = vi.mocked(useRoutableViews);
const useViewCatalogMock = vi.mocked(useViewCatalog);
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

// Four formerly dock-favorite views + 24 page views, which pack beyond one
// launcher page. The composed surface deliberately renders no page-indicator
// strip: home/launcher navigation is gesture-only, and the inner
// Launcher dots stay suppressed.
const DOCK_VIEWS = [
  view("settings", "Settings", "/settings", { icon: "Settings" }),
  view("files", "Files", "/apps/files", { icon: "FolderClosed" }),
  view("tasks", "Tasks", "/apps/tasks", { icon: "ListTodo" }),
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
  useViewCatalogMock.mockReturnValue({
    entries: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    get: vi.fn(async () => {}),
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
const swipeBackHome = () => flick("home-launcher-launcher-page", 140);

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
  });

  it("renders no page-indicator strips — no dots competing with the composer (#4)", () => {
    const surface = renderComposed();
    openLauncher();
    expect(surface.getAttribute("data-page")).toBe("launcher");

    expect(screen.queryByTestId("home-launcher-indicator")).toBeNull();
    expect(screen.queryByLabelText("Home")).toBeNull();
    expect(screen.queryByLabelText("Apps page 1")).toBeNull();
    expect(document.querySelectorAll('[aria-label^="Page "]').length).toBe(0);
  });

  it("swiping back from the launcher returns HOME and is NOT in edit mode (#3)", () => {
    const surface = renderComposed();
    openLauncher();
    expect(surface.getAttribute("data-page")).toBe("launcher");

    // Enter edit mode via a long-press on a tile (the Edit button was removed).
    vi.useFakeTimers();
    const settingsTile = screen
      .getByTestId("launcher-tile-settings")
      .querySelector("button");
    if (!settingsTile) throw new Error("settings tile button missing");
    fireEvent.pointerDown(settingsTile, { clientX: 50, clientY: 50 });
    act(() => vi.advanceTimersByTime(600));
    fireEvent.pointerUp(settingsTile);
    vi.useRealTimers();
    // Edit mode is on: per-tile pin affordances appear (no Done button now).
    expect(screen.getByTestId("launcher-fav-settings")).toBeTruthy();

    // Swipe back. This is the exact gesture that used to strand the user in
    // jiggle mode. It must return home AND drop edit mode (store invariant).
    swipeBackHome();
    expect(surface.getAttribute("data-page")).toBe("home");

    // Re-enter the launcher: it must be a CLEAN launch view, not stale edit.
    openLauncher();
    expect(surface.getAttribute("data-page")).toBe("launcher");
    expect(screen.queryByTestId("launcher-fav-settings")).toBeNull();
  });

  it("a horizontal swipe that starts ON a tile never ghost-fires edit mode (#3)", () => {
    vi.useFakeTimers();
    renderComposed();
    openLauncher();

    // Press a tile and PAN past the slop before the long-press timer elapses.
    const tile = screen
      .getByTestId("launcher-tile-app0")
      .querySelector("button");
    if (!tile) throw new Error("tile button missing");
    fireEvent.pointerDown(tile, { clientX: 50, clientY: 50 });
    fireEvent.pointerMove(tile, { clientX: 90, clientY: 52 }); // dx 40 > slop
    act(() => vi.advanceTimersByTime(600));
    // Swipe ⇒ NOT a long-press ⇒ NOT edit mode (no pin affordances surfaced).
    expect(screen.queryByTestId("launcher-fav-app0")).toBeNull();

    // Control: a STATIONARY hold past the threshold DOES enter edit mode, so the
    // intentional long-press affordance still works.
    const tile2 = screen
      .getByTestId("launcher-tile-app1")
      .querySelector("button");
    if (!tile2) throw new Error("tile button missing");
    fireEvent.pointerDown(tile2, { clientX: 50, clientY: 50 });
    act(() => vi.advanceTimersByTime(600));
    expect(screen.getByTestId("launcher-fav-app1")).toBeTruthy();
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

  it("launcher tiles render DISTINCT generated app-icon imagery (#5)", () => {
    renderComposed();
    openLauncher();

    const settingsVisual = document.querySelector<HTMLElement>(
      '[data-view-visual="settings"]',
    );
    const filesVisual = document.querySelector<HTMLElement>(
      '[data-view-visual="files"]',
    );
    expect(settingsVisual).toBeTruthy();
    expect(filesVisual).toBeTruthy();
    expect(screen.getByTestId("launcher-image-settings")).toBeTruthy();
    expect(screen.getByTestId("launcher-image-files")).toBeTruthy();
    expect(settingsVisual?.getAttribute("style")).toContain("linear-gradient");
    expect(filesVisual?.getAttribute("style")).toContain("linear-gradient");

    const settingsGlyph = settingsVisual
      ?.querySelector("svg")
      ?.getAttribute("class");
    const filesGlyph = filesVisual?.querySelector("svg")?.getAttribute("class");
    expect(settingsGlyph).toContain("lucide-settings");
    expect(filesGlyph).toContain("lucide-folder-closed");
    expect(settingsGlyph).not.toBe(filesGlyph);
  });
});
