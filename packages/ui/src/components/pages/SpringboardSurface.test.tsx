// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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
  view("logs", "Logs", "/apps/logs", { viewKind: "developer" }),
  view("settings", "Settings", "/settings", { visibleInManager: false }),
  view("notes", "Notes", "/notes"),
  view("views-manager", "View Manager", "/views"),
];

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  useEnabledViewKindsMock.mockReturnValue({
    developer: true,
    preview: false,
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
  it("shows curated tiles and hides self-links plus preview-gated entries", () => {
    render(<SpringboardSurface />);

    expect(screen.getByTestId("springboard-tile-settings")).toBeTruthy();
    expect(screen.queryByTestId("springboard-tile-chat")).toBeNull();
    expect(screen.queryByTestId("springboard-tile-views")).toBeNull();
    expect(screen.queryByTestId("springboard-tile-views-manager")).toBeNull();
    expect(screen.queryByTestId("springboard-tile-notes")).toBeNull();
    expect(screen.queryByTestId("springboard-tile-weather")).toBeNull();
  });

  it("navigates loaded views through the browser route", () => {
    render(<SpringboardSurface />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(window.location.pathname).toBe("/settings");
  });

  it("uses the catalog get action for available apps", () => {
    const get = vi.fn(async (_entry: ViewEntry) => {});
    useViewCatalogMock.mockReturnValue({
      entries: [availableApp("feed", "Feed")],
      loading: false,
      error: null,
      refresh: vi.fn(),
      get,
    });

    render(<SpringboardSurface />);
    fireEvent.click(screen.getByRole("button", { name: "Feed" }));

    expect(get).toHaveBeenCalledTimes(1);
    const launched = get.mock.calls.at(0)?.at(0);
    expect(launched?.id).toBe("feed");
  });

  it("keeps system apps on page 1 and developer apps on page 2", () => {
    render(<SpringboardSurface />);

    const pageOne = screen.getByTestId("springboard-page-0");
    const pageTwo = screen.getByTestId("springboard-page-1");

    expect(
      within(pageOne).getByTestId("springboard-tile-settings"),
    ).toBeTruthy();
    expect(within(pageOne).queryByTestId("springboard-tile-logs")).toBeNull();
    expect(within(pageTwo).getByTestId("springboard-tile-logs")).toBeTruthy();
  });
});
