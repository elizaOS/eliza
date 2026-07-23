// @vitest-environment jsdom
//
// Renders the real AppsPageView with mocked view/state hooks to cover the
// /apps/<slug> claim resolution (#17033): the grid for claimed slugs, a loading
// registry, or no slug; the designed not-found state (with stale-bookmark
// recovery) once the registry settles with no claimant; and the structured
// once-per-slug warning that makes the dead route observable.
import { logger } from "@elizaos/logger";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewRegistryEntry } from "../../hooks/useAvailableViews";
import { useRoutableViews } from "../../hooks/useAvailableViews";
import { AppsPageView } from "./AppsPageView";

const appStateValue = vi.hoisted(() => ({
  activeGameRunId: "",
  appRuns: [] as Array<{ runId: string; appName: string }>,
  appsSubTab: "browse",
  setState: vi.fn(),
}));

vi.mock("../../hooks/useAvailableViews", () => ({
  useRoutableViews: vi.fn(),
}));

vi.mock("../../state", () => ({
  useAppSelectorShallow: <T,>(selector: (s: typeof appStateValue) => T): T =>
    selector(appStateValue),
}));

vi.mock("./LauncherSurface", () => ({
  LauncherSurface: () => <div data-testid="launcher-surface" />,
}));

vi.mock("../apps/FullscreenView", () => ({
  FullscreenView: () => <div data-testid="fullscreen-view" />,
}));

const useRoutableViewsMock = vi.mocked(useRoutableViews);

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

function setViews(views: ViewRegistryEntry[], loading = false) {
  useRoutableViewsMock.mockReturnValue({
    views,
    loading,
    error: null,
    refresh: vi.fn(),
  });
}

beforeEach(() => {
  appStateValue.activeGameRunId = "";
  appStateValue.appRuns = [];
  appStateValue.appsSubTab = "browse";
  window.history.replaceState(null, "", "/apps");
  setViews([
    view("settings", "Settings", "/settings"),
    view("files", "Files", "/apps/files"),
  ]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("AppsPageView slug resolution", () => {
  it("renders the not-found state and warns once when nothing claims the slug", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { unmount } = render(<AppsPageView appSlug="ghost" />);
    expect(screen.getByTestId("app-route-not-found")).toBeTruthy();
    expect(screen.queryByTestId("launcher-surface")).toBeNull();
    expect(screen.queryByTestId("app-route-not-found-open-view")).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      { slug: "ghost" },
      expect.stringContaining("[AppsPageView]"),
    );

    // Once per slug per session: a remount does not re-warn.
    unmount();
    render(<AppsPageView appSlug="ghost" />);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the grid while the registry is still loading", () => {
    setViews([], true);
    render(<AppsPageView appSlug="cold-deep-link" />);
    expect(screen.getByTestId("launcher-surface")).toBeTruthy();
    expect(screen.queryByTestId("app-route-not-found")).toBeNull();
  });

  it("keeps the grid when a routable view claims /apps/<slug>", () => {
    render(<AppsPageView appSlug="files" />);
    expect(screen.getByTestId("launcher-surface")).toBeTruthy();
    expect(screen.queryByTestId("app-route-not-found")).toBeNull();
  });

  it("keeps the grid when an app run claims the slug", () => {
    appStateValue.appRuns = [{ runId: "run-1", appName: "@elizaos/app-doom" }];
    render(<AppsPageView appSlug="doom" />);
    expect(screen.getByTestId("launcher-surface")).toBeTruthy();
    expect(screen.queryByTestId("app-route-not-found")).toBeNull();
  });

  it("keeps the grid when no slug is routed", () => {
    render(<AppsPageView />);
    expect(screen.getByTestId("launcher-surface")).toBeTruthy();
    expect(screen.queryByTestId("app-route-not-found")).toBeNull();
  });

  it("offers the canonical path when the slug matches a view id mounted elsewhere", () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    render(<AppsPageView appSlug="settings" />);
    expect(screen.getByTestId("app-route-not-found")).toBeTruthy();
    const open = screen.getByTestId("app-route-not-found-open-view");
    expect(open.textContent).toContain("Open Settings");
  });
});
