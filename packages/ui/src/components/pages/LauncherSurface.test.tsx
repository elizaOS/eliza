// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewRegistryEntry } from "../../hooks/useAvailableViews";
import { useRoutableViews } from "../../hooks/useAvailableViews";
import { useViewCatalog } from "../../hooks/useViewCatalog";
import type { ViewEntry } from "../../hooks/view-catalog";
import { useEnabledViewKinds } from "../../state/useViewKinds";
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
});
