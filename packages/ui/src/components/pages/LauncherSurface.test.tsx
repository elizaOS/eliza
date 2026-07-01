// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewRegistryEntry } from "../../hooks/useAvailableViews";
import { useRoutableViews } from "../../hooks/useAvailableViews";
import { useViewCatalog } from "../../hooks/useViewCatalog";
import type { ViewEntry } from "../../hooks/view-catalog";
import {
  enterLauncherEdit,
  goLauncher,
  resetShellSurfaceForTests,
} from "../../state/shell-surface-store";
import { useEnabledViewKinds } from "../../state/useViewKinds";
import { readRecentViewIds } from "../../view-recents";
import { LauncherSurface } from "./LauncherSurface";

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

function availableApp(id: string, label: string): ViewEntry {
  return {
    key: `app:${id}`,
    id,
    label,
    icon: "LayoutGrid",
    hasHero: false,
    modality: "gui",
    state: "available",
    kind: "app",
    appName: id,
    pluginName: id,
    viewKind: "release",
  } as ViewEntry;
}

const DEFAULT_VIEWS = [
  view("chat", "Chat", "/chat"),
  view("views", "Views", "/views"),
  view("phone", "Phone", "/phone", { visibleInManager: false }),
  view("settings", "Settings", "/settings", { visibleInManager: false }),
  view("notes", "Notes", "/notes"),
  view("views-manager", "View Manager", "/views"),
];

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  resetShellSurfaceForTests();
  useEnabledViewKindsMock.mockReturnValue({
    developer: true,
    preview: true,
  });
  useRoutableViewsMock.mockReturnValue({
    views: DEFAULT_VIEWS,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  useViewCatalogMock.mockReturnValue({
    entries: [availableApp("weather", "Weather")],
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
});

describe("LauncherSurface", () => {
  it("shows Settings as a favorite and hides Home/Launcher self-links", () => {
    render(<LauncherSurface />);

    expect(screen.getByTestId("launcher-tile-settings")).toBeTruthy();
    expect(screen.getByTestId("launcher-tile-phone")).toBeTruthy();
    expect(screen.getByTestId("launcher-tile-notes")).toBeTruthy();
    expect(screen.queryByTestId("launcher-tile-chat")).toBeNull();
    expect(screen.queryByTestId("launcher-tile-views")).toBeNull();
    expect(screen.queryByTestId("launcher-tile-views-manager")).toBeNull();
  });

  it("navigates loaded views through the browser route", () => {
    render(<LauncherSurface />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(window.location.pathname).toBe("/settings");
  });

  it("uses the catalog get action for available apps", () => {
    const get = vi.fn(async (_entry: ViewEntry) => {});
    useViewCatalogMock.mockReturnValue({
      entries: [availableApp("weather", "Weather")],
      loading: false,
      error: null,
      refresh: vi.fn(),
      get,
    });

    render(<LauncherSurface />);
    fireEvent.click(screen.getByRole("button", { name: "Weather" }));

    expect(get).toHaveBeenCalledTimes(1);
    const launched = get.mock.calls.at(0)?.at(0);
    expect(launched?.id).toBe("weather");
  });

  it("orders stable first-party views ahead of developer QA views and catalog apps", () => {
    useRoutableViewsMock.mockReturnValue({
      views: [
        view("notes", "Notes", "/notes", { order: 920 }),
        view("phone", "Phone", "/phone", { visibleInManager: false }),
        view("settings", "Settings", "/settings", {
          visibleInManager: false,
        }),
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    render(<LauncherSurface />);

    const page = screen.getByTestId("launcher-page-0");
    const ids = Array.from(
      page.querySelectorAll<HTMLElement>('[data-testid^="launcher-tile-"]'),
    ).map((node) =>
      node.getAttribute("data-testid")?.replace("launcher-tile-", ""),
    );

    expect(ids).toEqual(["phone", "settings", "notes", "weather"]);
  });

  it("records the launched view id into recents (nav payload)", () => {
    render(<LauncherSurface />);

    expect(readRecentViewIds()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(window.location.pathname).toBe("/settings");
    expect(readRecentViewIds()).toEqual(["settings"]);
  });

  it("is idempotent under rapid double-click of a loaded tile", () => {
    const get = vi.fn(async (_entry: ViewEntry) => {});
    useViewCatalogMock.mockReturnValue({
      entries: [availableApp("weather", "Weather")],
      loading: false,
      error: null,
      refresh: vi.fn(),
      get,
    });
    render(<LauncherSurface />);

    const tile = screen.getByRole("button", { name: "Notes" });
    fireEvent.click(tile);
    fireEvent.click(tile);

    // A loaded view routes through history, never the catalog loader, and the
    // recents list dedupes so a double-tap leaves a single entry.
    expect(window.location.pathname).toBe("/notes");
    expect(readRecentViewIds()).toEqual(["notes"]);
    expect(get).not.toHaveBeenCalled();
  });

  it("requests the catalog for an unloaded app without navigating", () => {
    const get = vi.fn(async (_entry: ViewEntry) => {});
    useViewCatalogMock.mockReturnValue({
      entries: [availableApp("weather", "Weather")],
      loading: false,
      error: null,
      refresh: vi.fn(),
      get,
    });
    render(<LauncherSurface />);

    const tile = screen.getByRole("button", { name: "Weather" });
    fireEvent.click(tile);
    fireEvent.click(tile);

    // Loading is best-effort per tap; navigation must NOT happen for an app
    // that has not finished loading, and no recent is recorded.
    expect(get).toHaveBeenCalledTimes(2);
    expect(window.location.pathname).toBe("/");
    expect(readRecentViewIds()).toEqual([]);
  });

  it("renders an empty launcher when every view is hidden", () => {
    useRoutableViewsMock.mockReturnValue({
      views: [view("chat", "Chat", "/chat"), view("views", "Views", "/views")],
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
    const { container } = render(<LauncherSurface />);

    expect(screen.getByTestId("launcher")).toBeTruthy();
    expect(
      container.querySelectorAll('[data-testid^="launcher-tile-"]').length,
    ).toBe(0);
  });

  it("shows the loading skeleton with no tiles while views load", () => {
    useRoutableViewsMock.mockReturnValue({
      views: [],
      loading: true,
      error: null,
      refresh: vi.fn(),
    });
    useViewCatalogMock.mockReturnValue({
      entries: [],
      loading: true,
      error: null,
      refresh: vi.fn(),
      get: vi.fn(async () => {}),
    });
    const { container } = render(<LauncherSurface />);

    // Skeleton path renders instead of any real page/tile.
    expect(screen.getByTestId("launcher-page-window")).toBeTruthy();
    expect(screen.queryByTestId("launcher-page-0")).toBeNull();
    expect(
      container.querySelectorAll('[data-testid^="launcher-tile-"]').length,
    ).toBe(0);
  });

  it("suppresses tile launch while the shell store is in edit mode", () => {
    goLauncher();
    enterLauncherEdit();
    render(<LauncherSurface />);

    // In edit/jiggle mode a tile tap must not navigate — the pin affordance is
    // shown instead so the user can favorite rather than open.
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(window.location.pathname).toBe("/");
    expect(readRecentViewIds()).toEqual([]);
    expect(screen.getByTestId("launcher-fav-settings")).toBeTruthy();
  });

  it("hides preview-kind views when the preview toggle is off", () => {
    useEnabledViewKindsMock.mockReturnValue({
      developer: true,
      preview: false,
    });
    useRoutableViewsMock.mockReturnValue({
      views: [
        view("notes", "Notes", "/notes"),
        view("labs", "Labs", "/labs", { viewKind: "preview" }),
      ],
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
    render(<LauncherSurface />);

    expect(screen.getByTestId("launcher-tile-notes")).toBeTruthy();
    expect(screen.queryByTestId("launcher-tile-labs")).toBeNull();
  });
});
