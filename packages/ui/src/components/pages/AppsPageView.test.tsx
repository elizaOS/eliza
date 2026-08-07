/** Verifies AppsPageView slug resolution through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Renders the real AppsPageView with mocked view/state hooks to cover the
 * /apps/<slug> claim resolution (#17033): the grid for claimed slugs, a
 * loading or errored registry, or no slug; the idle-registration grace window
 * before a settled-unclaimed slug is asserted dead; the designed not-found
 * state (with stale-bookmark recovery, never offered into an unavailable
 * entry); and the structured once-per-slug warning that makes the dead route
 * observable. Fake timers drive the grace window deterministically.
 */
import { logger } from "@elizaos/logger";
import { act, cleanup, render, screen } from "@testing-library/react";
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

// Mirrors UNCLAIMED_SLUG_GRACE_MS in AppsPageView — the idle-registration
// grace window a settled-unclaimed slug must survive before not-found renders.
const GRACE_MS = 1500;

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

function setViews(
  views: ViewRegistryEntry[],
  {
    loading = false,
    error = null,
  }: { loading?: boolean; error?: Error | null } = {},
) {
  useRoutableViewsMock.mockReturnValue({
    views,
    loading,
    error,
    refresh: vi.fn(),
  });
}

function elapseGrace() {
  act(() => {
    vi.advanceTimersByTime(GRACE_MS);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
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
  vi.useRealTimers();
});

describe("AppsPageView slug resolution", () => {
  it("renders the not-found state and warns once when nothing claims the slug", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { unmount } = render(<AppsPageView appSlug="ghost" />);
    // The grid holds through the grace window; only a slug that stays
    // unclaimed for the whole window is asserted dead.
    expect(screen.getByTestId("launcher-surface")).toBeTruthy();
    expect(warnSpy).not.toHaveBeenCalled();
    elapseGrace();
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
    elapseGrace();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the grid while the registry is still loading", () => {
    setViews([], { loading: true });
    render(<AppsPageView appSlug="cold-deep-link" />);
    elapseGrace();
    expect(screen.getByTestId("launcher-surface")).toBeTruthy();
    expect(screen.queryByTestId("app-route-not-found")).toBeNull();
  });

  it("keeps the grid and never warns when the registry load failed", () => {
    // Asserting "nothing mounted here" requires knowing what IS mounted: a
    // transport/5xx registry failure must not read as not-found for slugs
    // that ARE served, nor burn their once-per-slug warning.
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    setViews([], { error: new Error("registry fetch failed") });
    render(<AppsPageView appSlug="errored-registry" />);
    elapseGrace();
    expect(screen.getByTestId("launcher-surface")).toBeTruthy();
    expect(screen.queryByTestId("app-route-not-found")).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("holds the grid during the grace window and keeps it when a claim lands", () => {
    // Idle-deferred registerAppShellPage registrations can land after the
    // views fetch settles; a claim arriving mid-grace cancels the verdict.
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { rerender } = render(<AppsPageView appSlug="late-claim" />);
    expect(screen.getByTestId("launcher-surface")).toBeTruthy();

    setViews([view("late-claim", "Late Claim", "/apps/late-claim")]);
    rerender(<AppsPageView appSlug="late-claim" />);
    elapseGrace();
    expect(screen.getByTestId("launcher-surface")).toBeTruthy();
    expect(screen.queryByTestId("app-route-not-found")).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("treats an unavailable registry entry as not claiming the slug", () => {
    // available:false keeps path/bundleUrl in the registry while the bundle is
    // unloadable (e.g. missing on disk) — the broken install must surface as
    // not-found, not mask behind the healthy grid, and the recovery CTA must
    // never point into the dead entry.
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    setViews([
      view("broken", "Broken App", "/apps/broken", { available: false }),
    ]);
    render(<AppsPageView appSlug="broken" />);
    elapseGrace();
    expect(screen.getByTestId("app-route-not-found")).toBeTruthy();
    expect(screen.queryByTestId("app-route-not-found-open-view")).toBeNull();
  });

  it("keeps the grid when a routable view claims /apps/<slug>", () => {
    render(<AppsPageView appSlug="files" />);
    elapseGrace();
    expect(screen.getByTestId("launcher-surface")).toBeTruthy();
    expect(screen.queryByTestId("app-route-not-found")).toBeNull();
  });

  it("keeps the grid when an app run claims the slug", () => {
    appStateValue.appRuns = [{ runId: "run-1", appName: "@elizaos/app-doom" }];
    render(<AppsPageView appSlug="doom" />);
    elapseGrace();
    expect(screen.getByTestId("launcher-surface")).toBeTruthy();
    expect(screen.queryByTestId("app-route-not-found")).toBeNull();
  });

  it("keeps the grid when no slug is routed", () => {
    render(<AppsPageView />);
    elapseGrace();
    expect(screen.getByTestId("launcher-surface")).toBeTruthy();
    expect(screen.queryByTestId("app-route-not-found")).toBeNull();
  });

  it("offers the canonical path when the slug matches a view id mounted elsewhere", () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    render(<AppsPageView appSlug="settings" />);
    elapseGrace();
    expect(screen.getByTestId("app-route-not-found")).toBeTruthy();
    const open = screen.getByTestId("app-route-not-found-open-view");
    expect(open.textContent).toContain("Open Settings");
  });
});
