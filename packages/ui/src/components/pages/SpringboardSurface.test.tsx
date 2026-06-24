// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewRegistryEntry } from "../../hooks/useAvailableViews";
import { useRoutableViews } from "../../hooks/useAvailableViews";
import { useViewCatalog } from "../../hooks/useViewCatalog";
import type { ViewEntry } from "../../hooks/view-catalog";
import { useEnabledViewKinds } from "../../state/useViewKinds";
import { SpringboardSurface } from "./SpringboardSurface";

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

describe("SpringboardSurface", () => {
  it("shows Settings as a favorite and hides Home/Springboard self-links", () => {
    render(<SpringboardSurface />);

    expect(screen.getByTestId("springboard-tile-settings")).toBeTruthy();
    expect(screen.getByTestId("springboard-tile-notes")).toBeTruthy();
    expect(screen.queryByTestId("springboard-tile-chat")).toBeNull();
    expect(screen.queryByTestId("springboard-tile-views")).toBeNull();
    expect(screen.queryByTestId("springboard-tile-views-manager")).toBeNull();
  });

  it("navigates loaded views through the browser route", () => {
    render(<SpringboardSurface />);

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

    render(<SpringboardSurface />);
    fireEvent.click(screen.getByRole("button", { name: "Weather" }));

    expect(get).toHaveBeenCalledTimes(1);
    const launched = get.mock.calls.at(0)?.at(0);
    expect(launched?.id).toBe("weather");
  });
});
