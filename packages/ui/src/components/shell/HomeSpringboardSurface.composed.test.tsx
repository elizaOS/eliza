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
const ALL_VIEWS = [...DOCK_VIEWS, ...PAGE_VIEWS];

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
  fireEvent.pointerDown(el, { isPrimary: true, clientX: 260, clientY: 300 });
  fireEvent.pointerMove(el, {
    isPrimary: true,
    clientX: 260 + dx,
    clientY: 300 + dy,
  });
  fireEvent.pointerUp(el, {
    isPrimary: true,
    clientX: 260 + dx,
    clientY: 300 + dy,
  });
}

const openSpringboard = () => flick("home-springboard-home-page", -140);
const swipeBackHome = () => flick("home-springboard-springboard-page", 140);

describe("Home ↔ Springboard composed surface", () => {
  it("renders NO page indicator — the dots were removed (collided with chat)", () => {
    const surface = renderComposed();
    openSpringboard();
    expect(surface.getAttribute("data-page")).toBe("springboard");

    // The rail indicator is gone entirely — navigation is swipe-only now.
    expect(
      document.querySelectorAll('[data-testid="home-springboard-indicator"]')
        .length,
    ).toBe(0);
    // ...and the inner Springboard's own dot strip stays suppressed too.
    expect(document.querySelectorAll('[aria-label^="Page "]').length).toBe(0);
    expect(screen.queryByLabelText("Apps page 1")).toBeNull();
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

  it("dock tiles render DISTINCT per-view visuals, with distinct glyph fallback (#5)", () => {
    renderComposed();
    openSpringboard();

    const settingsImage = screen.getByTestId(
      "springboard-image-settings",
    ) as HTMLImageElement;
    const filesImage = screen.getByTestId(
      "springboard-image-files",
    ) as HTMLImageElement;
    expect(settingsImage.getAttribute("src")).toMatch(/^data:image\/svg\+xml,/);
    expect(filesImage.getAttribute("src")).toMatch(/^data:image\/svg\+xml,/);
    expect(settingsImage.getAttribute("src")).not.toBe(
      filesImage.getAttribute("src"),
    );

    fireEvent.error(settingsImage);
    fireEvent.error(filesImage);

    const settingsGlyph = document
      .querySelector('[data-view-visual="settings"] svg')
      ?.getAttribute("class");
    const filesGlyph = document
      .querySelector('[data-view-visual="files"] svg')
      ?.getAttribute("class");
    expect(settingsGlyph).toContain("lucide-settings");
    expect(filesGlyph).toContain("lucide-folder-closed");
    expect(settingsGlyph).not.toBe(filesGlyph);
  });
});
