// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNavigateViewHandler,
  type DesktopBridgeRequest,
} from "./app-navigate-view";
import type { ViewRegistryEntry } from "./hooks/useAvailableViews";

// Branch coverage for createNavigateViewHandler() that app-navigate-view.test.ts
// does not exercise: the early-return guards, viewId-less navigation (no recents
// record), and viewId navigation that resolves a registry entry which is neither
// pin-tab nor desktopTabEnabled (must navigate without opening a desktop tab).

function view(patch: Partial<ViewRegistryEntry> = {}): ViewRegistryEntry {
  return {
    id: "remote-ledger",
    label: "Remote Ledger",
    available: true,
    pluginName: "plugin-ledger",
    path: "/apps/remote-ledger",
    viewType: "gui",
    ...patch,
  };
}

function createHandlerFixture(views: ViewRegistryEntry[] = [view()]) {
  const invokeDesktopBridgeRequest = vi.fn(
    async <T>() => ({ id: "app-1" }) as T,
  ) as DesktopBridgeRequest;
  const navigatePath = vi.fn();
  const openDesktopTab = vi.fn();
  const setActiveDesktopTabId = vi.fn();
  const setTab = vi.fn();
  const handler = createNavigateViewHandler({
    availableViewsForDesktopTabs: views,
    invokeDesktopBridgeRequest,
    navigatePath,
    openDesktopTab,
    setActiveDesktopTabId,
    setTab,
  });
  return {
    handler,
    invokeDesktopBridgeRequest,
    navigatePath,
    openDesktopTab,
    setActiveDesktopTabId,
    setTab,
  };
}

function navigateEvent(detail: Record<string, unknown>): CustomEvent {
  return new CustomEvent("eliza:navigate:view", { detail });
}

function recents(): string[] {
  return JSON.parse(
    window.localStorage.getItem("elizaos.views.recent") ?? "[]",
  );
}

describe("createNavigateViewHandler guard + fallthrough branches", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    window.localStorage.clear();
  });

  it("ignores events that carry no detail", () => {
    const fixture = createHandlerFixture();

    fixture.handler(new CustomEvent("eliza:navigate:view"));

    expect(fixture.setTab).not.toHaveBeenCalled();
    expect(fixture.navigatePath).not.toHaveBeenCalled();
    expect(fixture.openDesktopTab).not.toHaveBeenCalled();
    expect(fixture.invokeDesktopBridgeRequest).not.toHaveBeenCalled();
    expect(recents()).toEqual([]);
  });

  it("ignores a detail with neither viewPath nor viewId (no path, no recents)", () => {
    const fixture = createHandlerFixture();

    fixture.handler(navigateEvent({ action: "pin-tab" }));

    expect(fixture.navigatePath).not.toHaveBeenCalled();
    expect(fixture.openDesktopTab).not.toHaveBeenCalled();
    expect(recents()).toEqual([]);
  });

  it("navigates a viewPath-only detail without recording a recent view", () => {
    const fixture = createHandlerFixture();

    fixture.handler(navigateEvent({ viewPath: "/apps/remote-ledger" }));

    expect(fixture.navigatePath).toHaveBeenCalledWith("/apps/remote-ledger");
    expect(fixture.openDesktopTab).not.toHaveBeenCalled();
    expect(fixture.setActiveDesktopTabId).not.toHaveBeenCalled();
    // recordRecentViewId only fires when detail.viewId is present.
    expect(recents()).toEqual([]);
  });

  it("navigates a resolved view that is neither pinned nor tab-enabled without opening a tab", () => {
    const remoteLedger = view({ desktopTabEnabled: false });
    const fixture = createHandlerFixture([remoteLedger]);

    fixture.handler(navigateEvent({ viewId: "remote-ledger" }));

    expect(fixture.openDesktopTab).not.toHaveBeenCalled();
    expect(fixture.setActiveDesktopTabId).not.toHaveBeenCalled();
    expect(fixture.navigatePath).toHaveBeenCalledWith("/apps/remote-ledger");
    // viewId present, so it is recorded.
    expect(recents()).toEqual(["remote-ledger"]);
  });

  it("navigates a viewId with no registry entry without opening a tab or crashing", () => {
    const fixture = createHandlerFixture([]);

    fixture.handler(navigateEvent({ viewId: "ghost-view" }));

    expect(fixture.openDesktopTab).not.toHaveBeenCalled();
    expect(fixture.navigatePath).toHaveBeenCalledWith("/apps/ghost-view");
    expect(recents()).toEqual(["ghost-view"]);
  });

  it("falls through to plain navigation when open-window is requested without a viewId", () => {
    const fixture = createHandlerFixture();

    fixture.handler(
      navigateEvent({ viewPath: "/apps/remote-ledger", action: "open-window" }),
    );

    // The open-window branch requires a viewId; without one it must not call
    // the desktop bridge and instead navigate the resolved path in-page.
    expect(fixture.invokeDesktopBridgeRequest).not.toHaveBeenCalled();
    expect(fixture.navigatePath).toHaveBeenCalledWith("/apps/remote-ledger");
  });
});
