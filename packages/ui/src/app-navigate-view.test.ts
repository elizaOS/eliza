// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNavigateViewHandler,
  type DesktopBridgeRequest,
  directTabForNavigateView,
  navigateBrowserPath,
  pathForNavigateViewDetail,
} from "./app-navigate-view";
import type { ViewRegistryEntry } from "./hooks/useAvailableViews";

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
    async <T>() =>
      ({
        id: "app-1",
      }) as T,
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

describe("App navigate-view shell handler", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    window.localStorage.clear();
  });

  it("resolves paths and direct tabs for view manager navigation", () => {
    expect(pathForNavigateViewDetail({ viewPath: "/views" })).toBe("/views");
    expect(pathForNavigateViewDetail({ viewId: "remote-ledger" })).toBe(
      "/apps/remote-ledger",
    );
    expect(pathForNavigateViewDetail({})).toBeNull();
    expect(directTabForNavigateView({ viewPath: "/views" }, "/views")).toBe(
      "views",
    );
    expect(directTabForNavigateView({ viewPath: "/apps" }, "/apps")).toBe(
      "apps",
    );
    expect(
      directTabForNavigateView(
        { viewId: "views-manager", viewType: "gui" },
        "/apps/views-manager",
      ),
    ).toBe("views");
    expect(
      directTabForNavigateView(
        { viewId: "views-manager", viewType: "tui" },
        "/apps/views-manager",
      ),
    ).toBeNull();
  });

  it("sets direct app tabs without changing browser history", () => {
    const fixture = createHandlerFixture();

    fixture.handler(navigateEvent({ viewPath: "/views" }));
    fixture.handler(navigateEvent({ viewId: "views-manager" }));

    expect(fixture.setTab).toHaveBeenCalledTimes(2);
    expect(fixture.setTab).toHaveBeenNthCalledWith(1, "views");
    expect(fixture.setTab).toHaveBeenNthCalledWith(2, "views");
    expect(fixture.navigatePath).not.toHaveBeenCalled();
    expect(fixture.openDesktopTab).not.toHaveBeenCalled();
  });

  it("pins a view as a desktop tab and navigates to the view path", () => {
    const remoteLedger = view({ desktopTabEnabled: false });
    const fixture = createHandlerFixture([remoteLedger]);

    fixture.handler(
      navigateEvent({
        viewId: "remote-ledger",
        action: "pin-tab",
      }),
    );

    expect(fixture.openDesktopTab).toHaveBeenCalledWith(remoteLedger, {
      pinned: true,
    });
    expect(fixture.setActiveDesktopTabId).toHaveBeenCalledWith("remote-ledger");
    expect(fixture.navigatePath).toHaveBeenCalledWith("/apps/remote-ledger");
  });

  it("auto-opens desktop-tab-enabled views without pinning them", () => {
    const localNotes = view({
      id: "local-notes",
      label: "Local Notes",
      path: "/apps/local-notes",
      desktopTabEnabled: true,
    });
    const fixture = createHandlerFixture([localNotes]);

    fixture.handler(navigateEvent({ viewId: "local-notes" }));

    expect(fixture.openDesktopTab).toHaveBeenCalledWith(localNotes, {
      pinned: false,
    });
    expect(fixture.setActiveDesktopTabId).toHaveBeenCalledWith("local-notes");
    expect(fixture.navigatePath).toHaveBeenCalledWith("/apps/local-notes");
  });

  it("opens a managed app window through the desktop bridge", async () => {
    const remoteLedger = view({
      id: "remote-ledger",
      label: "Remote Ledger",
      path: "/views/remote-ledger",
    });
    const fixture = createHandlerFixture([remoteLedger]);

    fixture.handler(
      navigateEvent({
        viewId: "remote-ledger",
        action: "open-window",
      }),
    );

    await vi.waitFor(() =>
      expect(fixture.invokeDesktopBridgeRequest).toHaveBeenCalledWith({
        rpcMethod: "desktopOpenAppWindow",
        ipcChannel: "desktop:openAppWindow",
        params: {
          title: "Remote Ledger",
          path: "/views/remote-ledger",
          alwaysOnTop: false,
        },
      }),
    );
    expect(fixture.navigatePath).not.toHaveBeenCalled();
    expect(fixture.openDesktopTab).not.toHaveBeenCalled();
  });

  it("passes always-on-top window requests through the desktop bridge", async () => {
    const remoteLedger = view({
      id: "remote-ledger",
      label: "Remote Ledger",
      path: "/apps/remote-ledger",
    });
    const fixture = createHandlerFixture([remoteLedger]);

    fixture.handler(
      navigateEvent({
        viewId: "remote-ledger",
        action: "open-window",
        alwaysOnTop: true,
      }),
    );

    await vi.waitFor(() =>
      expect(fixture.invokeDesktopBridgeRequest).toHaveBeenCalledWith({
        rpcMethod: "desktopOpenAppWindow",
        ipcChannel: "desktop:openAppWindow",
        params: {
          title: "Remote Ledger",
          path: "/apps/remote-ledger",
          alwaysOnTop: true,
        },
      }),
    );
    expect(fixture.navigatePath).not.toHaveBeenCalled();
    expect(fixture.openDesktopTab).not.toHaveBeenCalled();
  });

  it("uses stable fallback title and path for missing open-window view entries", async () => {
    const fixture = createHandlerFixture([]);

    fixture.handler(
      navigateEvent({
        viewId: "unknown-view",
        action: "open-window",
      }),
    );

    await vi.waitFor(() =>
      expect(fixture.invokeDesktopBridgeRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          params: {
            title: "unknown-view",
            path: "/apps/unknown-view",
            alwaysOnTop: false,
          },
        }),
      ),
    );
  });

  it("falls back to in-page navigation when desktop open-window is unavailable", async () => {
    const remoteLedger = view({
      id: "remote-ledger",
      label: "Remote Ledger",
      path: "/views/remote-ledger",
    });
    const fixture = createHandlerFixture([remoteLedger]);
    const bridge = vi.fn(
      async () => null,
    ) as typeof fixture.invokeDesktopBridgeRequest;
    const handler = createNavigateViewHandler({
      availableViewsForDesktopTabs: [remoteLedger],
      invokeDesktopBridgeRequest: bridge,
      navigatePath: fixture.navigatePath,
      openDesktopTab: fixture.openDesktopTab,
      setActiveDesktopTabId: fixture.setActiveDesktopTabId,
      setTab: fixture.setTab,
    });

    handler(
      navigateEvent({
        viewId: "remote-ledger",
        action: "open-window",
      }),
    );

    await vi.waitFor(() => {
      expect(fixture.navigatePath).toHaveBeenCalledWith("/views/remote-ledger");
    });
  });

  it("records agent-navigated views in the recent views list", () => {
    const localNotes = view({
      id: "local-notes",
      label: "Local Notes",
      path: "/apps/local-notes",
    });
    const fixture = createHandlerFixture([localNotes]);

    fixture.handler(navigateEvent({ viewId: "local-notes" }));

    expect(
      JSON.parse(window.localStorage.getItem("elizaos.views.recent") ?? "[]"),
    ).toEqual(["local-notes"]);
  });

  it("navigates browser history for normal view navigation", () => {
    navigateBrowserPath("/apps/remote-ledger?mode=edit#row-7");

    expect(window.location.pathname).toBe("/apps/remote-ledger");
    expect(window.location.search).toBe("?mode=edit");
    expect(window.location.hash).toBe("#row-7");
  });
});
