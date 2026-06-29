// @vitest-environment jsdom
//
// COMPOSED screen-state test — the gap the audit flagged. Every prior test
// rendered HomeSpringboardSurface against a one-button stub and the Springboard
// in isolation, so the bugs that live in the COMPOSITION (two stacked dot
// strips, swipe-back landing in jiggle mode) were structurally unreachable.
// This renders the REAL HomeSpringboardSurface wrapping the REAL
// SpringboardSurface, driven by the single shell-surface store, and asserts the
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
import { SpringboardSurface } from "../pages/SpringboardSurface";
import { HomeSpringboardSurface } from "./HomeSpringboardSurface";

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

// Four dock favorites (so the dock fills) + 24 page views, which pack into TWO
// springboard pages (page size 20). Two pages is what makes the doubled-dots
// bug observable: the inner Springboard WOULD render its own dot strip here if
// it weren't suppressed in favor of the rail's single indicator.
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
    <HomeSpringboardSurface
      home={<div data-testid="home-content">home</div>}
      springboard={<SpringboardSurface />}
    />,
  );
  return screen.getByTestId("home-springboard-surface");
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

const openSpringboard = () => flick("home-springboard-home-page", -140);
const swipeBackHome = () => flick("home-springboard-springboard-page", 140);

describe("Home ↔ Springboard composed surface", () => {
  it("tracks the rail with the finger before committing a home ↔ springboard swipe", () => {
    runAnimationFramesImmediately();
    const surface = renderComposed();
    Object.defineProperty(surface, "clientWidth", {
      configurable: true,
      value: 390,
    });
    const homePage = screen.getByTestId("home-springboard-home-page");
    const rail = screen.getByTestId("home-springboard-rail");

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

    expect(surface.getAttribute("data-page")).toBe("springboard");
    expect(rail.style.transform).toContain("translate3d(-390px,0,0)");
  });

  it("suppresses nested page-indicator strips (#4)", () => {
    const surface = renderComposed();
    openSpringboard();
    expect(surface.getAttribute("data-page")).toBe("springboard");

    // HomeSpringboardSurface intentionally renders no dot strip: the dots
    // collided with the floating chat composer. The inner Springboard's own dot
    // strip is also suppressed while nested, so there are no stacked rows.
    expect(screen.queryByTestId("home-springboard-indicator")).toBeNull();
    expect(document.querySelectorAll('[aria-label^="Page "]').length).toBe(0);
    expect(
      document.querySelectorAll('[data-testid="home-springboard-indicator"]')
        .length,
    ).toBe(0);
  });

  it("swiping back from the springboard returns HOME and is NOT in edit mode (#3)", () => {
    const surface = renderComposed();
    openSpringboard();
    expect(surface.getAttribute("data-page")).toBe("springboard");

    // Enter edit mode via a long-press on a tile (the Edit button was removed).
    vi.useFakeTimers();
    const settingsTile = screen
      .getByTestId("springboard-tile-settings")
      .querySelector("button");
    if (!settingsTile) throw new Error("settings tile button missing");
    fireEvent.pointerDown(settingsTile, { clientX: 50, clientY: 50 });
    act(() => vi.advanceTimersByTime(600));
    fireEvent.pointerUp(settingsTile);
    vi.useRealTimers();
    // Edit mode is on: per-tile pin affordances appear (no Done button now).
    expect(screen.getByTestId("springboard-fav-settings")).toBeTruthy();

    // Swipe back. This is the exact gesture that used to strand the user in
    // jiggle mode. It must return home AND drop edit mode (store invariant).
    swipeBackHome();
    expect(surface.getAttribute("data-page")).toBe("home");

    // Re-enter the springboard: it must be a CLEAN launch view, not stale edit.
    openSpringboard();
    expect(surface.getAttribute("data-page")).toBe("springboard");
    expect(screen.queryByTestId("springboard-fav-settings")).toBeNull();
  });

  it("a horizontal swipe that starts ON a tile never ghost-fires edit mode (#3)", () => {
    vi.useFakeTimers();
    renderComposed();
    openSpringboard();

    // Press a tile and PAN past the slop before the long-press timer elapses.
    const tile = screen
      .getByTestId("springboard-tile-app0")
      .querySelector("button");
    if (!tile) throw new Error("tile button missing");
    fireEvent.pointerDown(tile, { clientX: 50, clientY: 50 });
    fireEvent.pointerMove(tile, { clientX: 90, clientY: 52 }); // dx 40 > slop
    act(() => vi.advanceTimersByTime(600));
    // Swipe ⇒ NOT a long-press ⇒ NOT edit mode (no pin affordances surfaced).
    expect(screen.queryByTestId("springboard-fav-app0")).toBeNull();

    // Control: a STATIONARY hold past the threshold DOES enter edit mode, so the
    // intentional long-press affordance still works.
    const tile2 = screen
      .getByTestId("springboard-tile-app1")
      .querySelector("button");
    if (!tile2) throw new Error("tile button missing");
    fireEvent.pointerDown(tile2, { clientX: 50, clientY: 50 });
    act(() => vi.advanceTimersByTime(600));
    expect(screen.getByTestId("springboard-fav-app1")).toBeTruthy();
  });

  it("does not render a Background tile because backgrounds live in Settings", () => {
    renderComposed();
    openSpringboard();

    expect(screen.queryByTestId("springboard-tile-background")).toBeNull();
    expect(screen.queryByRole("button", { name: "Background" })).toBeNull();
  });

  it("does not expose rail dot buttons after the composer-collision removal", () => {
    const surface = renderComposed();
    openSpringboard();

    expect(surface.getAttribute("data-page")).toBe("springboard");
    expect(screen.queryByLabelText("Apps page 2")).toBeNull();
    expect(screen.queryByLabelText("Home")).toBeNull();
  });

  it("springboard tiles render DISTINCT generated app-icon imagery (#5)", () => {
    renderComposed();
    openSpringboard();

    const settingsVisual = document.querySelector<HTMLElement>(
      '[data-view-visual="settings"]',
    );
    const filesVisual = document.querySelector<HTMLElement>(
      '[data-view-visual="files"]',
    );
    expect(settingsVisual).toBeTruthy();
    expect(filesVisual).toBeTruthy();
    expect(screen.getByTestId("springboard-image-settings")).toBeTruthy();
    expect(screen.getByTestId("springboard-image-files")).toBeTruthy();
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
