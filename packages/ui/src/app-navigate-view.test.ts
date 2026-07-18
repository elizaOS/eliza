// @vitest-environment jsdom

/**
 * Unit coverage for the navigate-view helpers: payload consume, path
 * derivation, direct-tab resolution, and the handler that opens registered
 * views or desktop tabs. Pure functions + injected bridge, no runtime.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createNavigateViewEvent } from "@elizaos/shared/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setNavigateViewPayloadForTests,
  type ActiveViewLayout,
  closeVisibleViewLayoutPane,
  consumeNavigateViewPayload,
  createNavigateViewHandler,
  type DesktopBridgeRequest,
  directTabForNavigateView,
  navigateBrowserPath,
  pathForNavigateViewDetail,
  readViewLayoutFromHistory,
  writeViewLayoutToHistory,
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

function createHandlerFixture(
  views: ViewRegistryEntry[] = [view()],
  viewLayout: ActiveViewLayout | null = null,
  activeForegroundViewId?: string | null,
) {
  const invokeDesktopBridgeRequest = vi.fn(
    async <T>() =>
      ({
        id: "app-1",
      }) as T,
  ) as DesktopBridgeRequest;
  const closeDesktopTab = vi.fn();
  const navigatePath = vi.fn();
  const openDesktopTab = vi.fn();
  const setActiveDesktopTabId = vi.fn();
  const setTab = vi.fn();
  const setViewLayout = vi.fn();
  const handler = createNavigateViewHandler({
    activeForegroundViewId,
    availableViewsForDesktopTabs: views,
    closeDesktopTab,
    desktopTabs: views.map((entry) => ({ viewId: entry.id })),
    invokeDesktopBridgeRequest,
    navigatePath,
    openDesktopTab,
    setActiveDesktopTabId,
    setTab,
    setViewLayout,
    viewLayout,
  });
  return {
    handler,
    closeDesktopTab,
    invokeDesktopBridgeRequest,
    navigatePath,
    openDesktopTab,
    setActiveDesktopTabId,
    setTab,
    setViewLayout,
  };
}

function navigateEvent(detail: Record<string, unknown>): CustomEvent {
  return createNavigateViewEvent(detail);
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
    // `/apps` is the My Apps view now (the launcher grid is `/views`), so it has
    // no direct-tab fast path — it resolves through the normal path→tab lookup.
    expect(directTabForNavigateView({ viewPath: "/apps" }, "/apps")).toBeNull();
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
    ).toBe("views");
  });

  it("sets direct app tabs without changing browser history", () => {
    const fixture = createHandlerFixture();
    writeViewLayoutToHistory({
      mode: "split",
      viewIds: ["remote-ledger", "calendar"],
    });

    fixture.handler(navigateEvent({ viewPath: "/views" }));
    fixture.handler(navigateEvent({ viewId: "views-manager" }));

    expect(fixture.setTab).toHaveBeenCalledTimes(2);
    expect(fixture.setTab).toHaveBeenNthCalledWith(1, "views");
    expect(fixture.setTab).toHaveBeenNthCalledWith(2, "views");
    expect(fixture.navigatePath).not.toHaveBeenCalled();
    expect(fixture.openDesktopTab).not.toHaveBeenCalled();
    expect(readViewLayoutFromHistory()).toBeNull();
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
    expect(fixture.setTab).toHaveBeenCalledWith("apps");
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
    expect(fixture.setTab).toHaveBeenCalledWith("apps");
    expect(fixture.navigatePath).toHaveBeenCalledWith("/apps/local-notes");
  });

  it("activates the route tab before navigating app paths", () => {
    const fixture = createHandlerFixture();

    fixture.handler(
      navigateEvent({ viewId: "plugins", viewPath: "/apps/plugins" }),
    );

    expect(fixture.setTab).toHaveBeenCalledWith("plugins");
    expect(fixture.navigatePath).toHaveBeenCalledWith("/apps/plugins");
  });

  it("closes a targeted desktop view tab and falls back to chat", () => {
    const remoteLedger = view();
    const fixture = createHandlerFixture([remoteLedger]);

    fixture.handler(
      navigateEvent({
        viewId: "remote-ledger",
        action: "close",
      }),
    );

    expect(fixture.closeDesktopTab).toHaveBeenCalledWith("remote-ledger");
    expect(fixture.setActiveDesktopTabId).toHaveBeenCalledWith(null);
    expect(fixture.setTab).toHaveBeenCalledWith("chat");
    expect(fixture.setViewLayout).toHaveBeenCalledWith(null);
    expect(fixture.navigatePath).not.toHaveBeenCalled();
    expect(fixture.openDesktopTab).not.toHaveBeenCalled();
  });

  it("closes all desktop view tabs and falls back to chat", () => {
    const remoteLedger = view();
    const localNotes = view({
      id: "local-notes",
      label: "Local Notes",
      path: "/apps/local-notes",
    });
    const fixture = createHandlerFixture([remoteLedger, localNotes]);
    writeViewLayoutToHistory({
      mode: "split",
      viewIds: ["remote-ledger", "local-notes"],
    });

    fixture.handler(
      navigateEvent({
        viewId: "__all__",
        action: "close-all",
      }),
    );

    expect(fixture.closeDesktopTab).toHaveBeenCalledWith("remote-ledger");
    expect(fixture.closeDesktopTab).toHaveBeenCalledWith("local-notes");
    expect(fixture.setActiveDesktopTabId).toHaveBeenCalledWith(null);
    expect(fixture.setTab).toHaveBeenCalledWith("chat");
    expect(fixture.setViewLayout).toHaveBeenCalledWith(null);
    expect(fixture.navigatePath).not.toHaveBeenCalled();
    expect(readViewLayoutFromHistory()).toBeNull();
  });

  it("closes a background tab without disturbing the visible layout", () => {
    const notes = view({ id: "notes", label: "Notes", path: "/notes" });
    const calendar = view({
      id: "calendar",
      label: "Calendar",
      path: "/calendar",
    });
    const background = view({
      id: "remote-ledger",
      label: "Remote Ledger",
      path: "/apps/remote-ledger",
    });
    const layout: ActiveViewLayout = {
      mode: "split",
      viewIds: ["notes", "calendar"],
      focusedViewId: "notes",
      layout: "horizontal",
    };
    writeViewLayoutToHistory(layout);
    const fixture = createHandlerFixture(
      [notes, calendar, background],
      layout,
      "notes",
    );

    fixture.handler(
      navigateEvent({ viewId: "remote-ledger", action: "close" }),
    );

    expect(fixture.closeDesktopTab).toHaveBeenCalledWith("remote-ledger");
    expect(fixture.setViewLayout).not.toHaveBeenCalled();
    expect(fixture.setActiveDesktopTabId).not.toHaveBeenCalled();
    expect(fixture.setTab).not.toHaveBeenCalled();
    expect(fixture.navigatePath).not.toHaveBeenCalled();
    expect(readViewLayoutFromHistory()).toEqual(layout);
  });

  it("closes a background tab without replacing a single foreground view", () => {
    const notes = view({ id: "notes", label: "Notes", path: "/notes" });
    const background = view({
      id: "remote-ledger",
      label: "Remote Ledger",
      path: "/apps/remote-ledger",
    });
    const fixture = createHandlerFixture([notes, background], null, "notes");

    fixture.handler(
      navigateEvent({ viewId: "remote-ledger", action: "close" }),
    );

    expect(fixture.closeDesktopTab).toHaveBeenCalledWith("remote-ledger");
    expect(fixture.setViewLayout).not.toHaveBeenCalled();
    expect(fixture.setActiveDesktopTabId).not.toHaveBeenCalled();
    expect(fixture.setTab).not.toHaveBeenCalled();
    expect(fixture.navigatePath).not.toHaveBeenCalled();
  });

  it("preserves focus when the shared layout close transition removes a non-focused pane", () => {
    const notes = view({ id: "notes", label: "Notes", path: "/notes" });
    const calendar = view({
      id: "calendar",
      label: "Calendar",
      path: "/calendar",
    });
    const tasks = view({ id: "tasks", label: "Tasks", path: "/tasks" });
    const views = [notes, calendar, tasks];
    const layout: ActiveViewLayout = {
      mode: "tile",
      viewIds: ["notes", "calendar", "tasks"],
      focusedViewId: "calendar",
      layout: "grid",
    };
    writeViewLayoutToHistory(layout);
    const fixture = createHandlerFixture(views, layout);

    const handled = closeVisibleViewLayoutPane({
      availableViewsForDesktopTabs: views,
      closeDesktopTab: fixture.closeDesktopTab,
      navigatePath: fixture.navigatePath,
      setActiveDesktopTabId: fixture.setActiveDesktopTabId,
      setTab: fixture.setTab,
      setViewLayout: fixture.setViewLayout,
      viewId: "notes",
      viewLayout: layout,
    });

    expect(handled).toBe(true);
    expect(fixture.closeDesktopTab).toHaveBeenCalledWith("notes");
    expect(fixture.setViewLayout).toHaveBeenCalledWith({
      mode: "tile",
      viewIds: ["calendar", "tasks"],
      focusedViewId: "calendar",
      layout: "grid",
    });
    expect(fixture.setActiveDesktopTabId).toHaveBeenCalledWith("calendar");
    expect(fixture.setTab).toHaveBeenCalledWith("views");
    expect(fixture.navigatePath).toHaveBeenCalledWith("/views");
    expect(readViewLayoutFromHistory()).toEqual({
      mode: "tile",
      viewIds: ["calendar", "tasks"],
      focusedViewId: "calendar",
      layout: "grid",
    });
  });

  it("promotes the survivor when the shared layout close transition removes the focused pane", () => {
    const notes = view({ id: "notes", label: "Notes", path: "/notes" });
    const calendar = view({
      id: "calendar",
      label: "Calendar",
      path: "/calendar",
    });
    const views = [notes, calendar];
    const layout: ActiveViewLayout = {
      mode: "split",
      viewIds: ["notes", "calendar"],
      focusedViewId: "calendar",
      layout: "horizontal",
    };
    writeViewLayoutToHistory(layout);
    const fixture = createHandlerFixture(views, layout);

    const handled = closeVisibleViewLayoutPane({
      availableViewsForDesktopTabs: views,
      closeDesktopTab: fixture.closeDesktopTab,
      navigatePath: fixture.navigatePath,
      setActiveDesktopTabId: fixture.setActiveDesktopTabId,
      setTab: fixture.setTab,
      setViewLayout: fixture.setViewLayout,
      viewId: "calendar",
      viewLayout: layout,
    });

    expect(handled).toBe(true);
    expect(fixture.closeDesktopTab).toHaveBeenCalledWith("calendar");
    expect(fixture.setViewLayout).toHaveBeenCalledWith(null);
    expect(fixture.setActiveDesktopTabId).toHaveBeenCalledWith("notes");
    expect(fixture.navigatePath).toHaveBeenCalledWith("/notes");
    expect(readViewLayoutFromHistory()).toBeNull();
  });

  it("closes one split pane and routes to the surviving view", () => {
    const notes = view({ id: "notes", label: "Notes", path: "/notes" });
    const calendar = view({
      id: "calendar",
      label: "Calendar",
      path: "/calendar",
    });
    const layout: ActiveViewLayout = {
      mode: "split",
      viewIds: ["notes", "calendar"],
      focusedViewId: "calendar",
      layout: "horizontal",
    };
    writeViewLayoutToHistory(layout);
    const fixture = createHandlerFixture([notes, calendar], layout);

    fixture.handler(navigateEvent({ viewId: "calendar", action: "close" }));

    expect(fixture.closeDesktopTab).toHaveBeenCalledWith("calendar");
    expect(fixture.setViewLayout).toHaveBeenCalledWith(null);
    expect(fixture.setActiveDesktopTabId).toHaveBeenCalledWith("notes");
    expect(fixture.navigatePath).toHaveBeenCalledWith("/notes");
    expect(readViewLayoutFromHistory()).toBeNull();
  });

  it("removes one tiled pane while retaining the other panes and focus", () => {
    const notes = view({ id: "notes", label: "Notes", path: "/notes" });
    const calendar = view({
      id: "calendar",
      label: "Calendar",
      path: "/calendar",
    });
    const tasks = view({ id: "tasks", label: "Tasks", path: "/tasks" });
    const layout: ActiveViewLayout = {
      mode: "tile",
      viewIds: ["notes", "calendar", "tasks"],
      focusedViewId: "calendar",
      layout: "grid",
    };
    const fixture = createHandlerFixture([notes, calendar, tasks], layout);

    fixture.handler(navigateEvent({ viewId: "notes", action: "close" }));

    expect(fixture.setViewLayout).toHaveBeenCalledWith({
      mode: "tile",
      viewIds: ["calendar", "tasks"],
      focusedViewId: "calendar",
      layout: "grid",
    });
    expect(fixture.setActiveDesktopTabId).toHaveBeenCalledWith("calendar");
    expect(fixture.navigatePath).toHaveBeenCalledWith("/views");
    expect(readViewLayoutFromHistory()).toEqual({
      mode: "tile",
      viewIds: ["calendar", "tasks"],
      focusedViewId: "calendar",
      layout: "grid",
    });
  });

  it("opens layout event participants as desktop tabs and activates layout state", () => {
    const notes = view({
      id: "notes",
      label: "Notes",
      path: "/notes",
      desktopTabEnabled: true,
    });
    const calendar = view({
      id: "calendar",
      label: "Calendar",
      path: "/calendar",
      desktopTabEnabled: true,
    });
    const fixture = createHandlerFixture([notes, calendar]);

    fixture.handler(
      navigateEvent({
        viewId: "notes",
        action: "split-view",
        views: ["notes", "calendar"],
        layout: "horizontal",
        placement: "right",
      }),
    );

    expect(fixture.openDesktopTab).toHaveBeenCalledWith(notes, {
      pinned: false,
    });
    expect(fixture.openDesktopTab).toHaveBeenCalledWith(calendar, {
      pinned: false,
    });
    expect(fixture.setActiveDesktopTabId).toHaveBeenCalledWith("notes");
    expect(fixture.setViewLayout).toHaveBeenCalledWith({
      mode: "split",
      viewIds: ["notes", "calendar"],
      focusedViewId: "notes",
      layout: "horizontal",
      placement: "right",
    });
    expect(fixture.setTab).toHaveBeenCalledWith("views");
    expect(fixture.navigatePath).toHaveBeenCalledWith("/views");
    expect(readViewLayoutFromHistory()).toEqual({
      mode: "split",
      viewIds: ["notes", "calendar"],
      focusedViewId: "notes",
      layout: "horizontal",
      placement: "right",
    });
  });

  it("restores a validated layout from this tab's history entry", () => {
    writeViewLayoutToHistory({
      mode: "tile",
      viewIds: ["notes", "calendar"],
      layout: "grid",
    });

    expect(readViewLayoutFromHistory()).toEqual({
      mode: "tile",
      viewIds: ["notes", "calendar"],
      focusedViewId: "notes",
      layout: "grid",
    });

    window.history.replaceState(
      { __elizaViewLayout: { mode: "grid", viewIds: ["notes"] } },
      "",
      "/views",
    );
    expect(readViewLayoutFromHistory()).toBeNull();

    window.history.replaceState(
      { __elizaViewLayout: { mode: "split", viewIds: ["notes", 42] } },
      "",
      "/views",
    );
    expect(readViewLayoutFromHistory()).toBeNull();
  });

  it("activates the first resolved layout participant when the first requested view is unavailable", () => {
    const calendar = view({
      id: "calendar",
      label: "Calendar",
      path: "/calendar",
      desktopTabEnabled: true,
    });
    const fixture = createHandlerFixture([calendar]);

    fixture.handler(
      navigateEvent({
        action: "split-view",
        views: ["missing-notes", "calendar"],
        layout: "horizontal",
      }),
    );

    expect(fixture.openDesktopTab).toHaveBeenCalledWith(calendar, {
      pinned: false,
    });
    expect(fixture.setActiveDesktopTabId).toHaveBeenCalledWith("calendar");
    expect(fixture.setViewLayout).toHaveBeenCalledWith({
      mode: "split",
      viewIds: ["calendar"],
      focusedViewId: "calendar",
      layout: "horizontal",
      placement: undefined,
    });
    expect(fixture.setTab).toHaveBeenCalledWith("views");
    expect(fixture.navigatePath).toHaveBeenCalledWith("/views");
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
      expect(fixture.setTab).toHaveBeenCalledWith("views");
      expect(fixture.navigatePath).toHaveBeenCalledWith("/views/remote-ledger");
    });
  });

  it("stores generic one-shot payloads for target views", () => {
    const fixture = createHandlerFixture();

    fixture.handler(
      navigateEvent({
        viewId: "remote-ledger",
        payload: { rowId: "row-7" },
      }),
    );

    expect(
      consumeNavigateViewPayload<{ rowId: string }>("remote-ledger"),
    ).toEqual({ rowId: "row-7" });
    expect(consumeNavigateViewPayload("remote-ledger")).toBeNull();
  });

  it("delivers a plugin-shaped deep-link payload to any target view id", () => {
    // A plugin's own navigate helper dispatches with the view id it targets and
    // a payload shape the view claims — the core stays generic, no view is
    // special-cased. Mirrors the Contacts→Phone/Messages handoff (#12674).
    const fixture = createHandlerFixture([
      view({ id: "phone", label: "Phone", path: "/phone" }),
    ]);

    fixture.handler(
      navigateEvent({
        viewId: "phone",
        viewPath: "/phone",
        payload: { number: "+15550100" },
      }),
    );

    expect(consumeNavigateViewPayload<{ number: string }>("phone")).toEqual({
      number: "+15550100",
    });
    // Single-shot: a later plain navigation to the same view does not re-seed.
    expect(consumeNavigateViewPayload("phone")).toBeNull();
  });

  it("returns null before a payload is seeded (no stale one-shot state)", () => {
    expect(consumeNavigateViewPayload("messages")).toBeNull();
    __setNavigateViewPayloadForTests("messages", { recipient: "+15550100" });
    expect(
      consumeNavigateViewPayload<{ recipient: string }>("messages"),
    ).toEqual({ recipient: "+15550100" });
    expect(consumeNavigateViewPayload("messages")).toBeNull();
  });

  // Regression guard for #12674: the core navigate module must not name the
  // Phone/Messages view ids or hold plugin-specific module-global one-shot
  // state. The generic `payload` channel + per-plugin navigate helpers replace
  // it. This asserts the removed special case cannot silently return.
  it("holds no hardcoded Phone/Messages special case or one-shot globals", () => {
    // Vitest runs with cwd at the package root (packages/ui); the guarded
    // module is a fixed source path from there.
    const source = readFileSync(
      resolve(process.cwd(), "src/app-navigate-view.ts"),
      "utf8",
    );
    for (const banned of [
      "pendingPhoneNumber",
      "pendingMessageRecipient",
      "consumePendingPhoneNumber",
      "consumePendingMessageRecipient",
      "navigateToPhoneWithNumber",
      "navigateToMessagesWithNumber",
      "normalizePhoneNumber",
    ]) {
      expect(source).not.toContain(banned);
    }
    // No view id is literally special-cased by the payload channel.
    expect(source).not.toContain('"phone"');
    expect(source).not.toContain('"messages"');
  });

  it("navigates browser history for normal view navigation", () => {
    navigateBrowserPath("/apps/remote-ledger?mode=edit#row-7");

    expect(window.location.pathname).toBe("/apps/remote-ledger");
    expect(window.location.search).toBe("?mode=edit");
    expect(window.location.hash).toBe("#row-7");
  });
});
