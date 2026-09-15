/**
 * Transport-independent VIEWS action handoff tests, using real Response bodies
 * and the shared navigate-event payload rather than a WebSocket fixture.
 *
 * @vitest-environment jsdom
 */

import { NAVIGATE_VIEW_EVENT } from "@elizaos/shared/events";
import { describe, expect, it, vi } from "vitest";
import type { ChatActionResultSummary } from "./api/client-types-chat";
import { createNavigateViewHandler } from "./app-navigate-view";
import {
  dispatchViewActionHandoff,
  dispatchViewActionHandoffDirect,
  findViewActionHandoff,
  recoverMissedCurrentView,
} from "./view-action-handoff";

const showCalendar: ChatActionResultSummary = {
  actionName: "VIEWS",
  success: true,
  values: { mode: "show", viewId: "calendar" },
};

function currentViewResponse(patch: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      currentView: {
        viewId: "calendar",
        viewPath: "/calendar",
        viewLabel: "Calendar",
        viewType: "gui",
        source: "agent",
        updatedAt: "2026-07-13T01:00:00.000Z",
        ...patch,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("view action handoff", () => {
  it("selects the latest successful show/open result only", () => {
    expect(
      findViewActionHandoff([
        showCalendar,
        {
          actionName: "VIEWS",
          success: false,
          values: { mode: "show", viewId: "wallet" },
        },
        {
          actionName: "WORKFLOW",
          success: true,
          values: { viewId: "ignored" },
        },
      ]),
    ).toEqual({ viewId: "calendar" });
  });

  it("preserves a confirmed originating-renderer delivery marker", () => {
    expect(
      findViewActionHandoff([
        {
          ...showCalendar,
          values: {
            ...showCalendar.values,
            completedActionDelivered: true,
            completedActionHandoffId: "handoff-calendar",
          },
        },
      ]),
    ).toEqual({
      viewId: "calendar",
      completedActionDelivered: true,
      completedActionHandoffId: "handoff-calendar",
    });
  });

  it("accepts only a successful APP launch handoff addressed to Browser", () => {
    expect(
      findViewActionHandoff([
        {
          actionName: "APP",
          success: true,
          values: {
            mode: "launch",
            viewId: "browser",
            viewPath: "/browser?browse=%2Fapi%2Fapps%2Flocal%2Fdemo%2F",
            completedActionHandoffId: "handoff-app",
          },
        },
      ]),
    ).toEqual({
      viewId: "browser",
      viewPath: "/browser?browse=%2Fapi%2Fapps%2Flocal%2Fdemo%2F",
      completedActionHandoffId: "handoff-app",
    });

    expect(
      findViewActionHandoff([
        {
          actionName: "APP",
          success: true,
          values: { mode: "launch", viewId: "wallet", viewPath: "/wallet" },
        },
      ]),
    ).toBeNull();
  });

  it("opens the Browser surface from a successful in-app browser command", () => {
    expect(
      findViewActionHandoff([
        {
          actionName: "BROWSER_NAVIGATE",
          success: true,
          values: {
            mode: "web",
            subaction: "navigate",
            targetId: "workspace",
            viewId: "browser",
            viewPath: "/browser",
            url: "https://example.com/path",
          },
        },
      ]),
    ).toEqual({
      viewId: "browser",
      viewPath: "/browser?browse=https%3A%2F%2Fexample.com%2Fpath",
    });

    expect(
      findViewActionHandoff([
        {
          actionName: "BROWSER",
          success: true,
          values: {
            mode: "desktop",
            subaction: "navigate",
            targetId: "bridge",
            viewId: "browser",
            viewPath: "/browser",
          },
        },
      ]),
    ).toBeNull();
  });

  it("delivers workspace navigation after a later page read without losing the destination", () => {
    const actionResults: ChatActionResultSummary[] = [
      {
        actionName: "BROWSER_NAVIGATE",
        success: true,
        text: "Opened example.com.",
        values: {
          success: true,
          mode: "web",
          targetId: "workspace",
          subaction: "navigate",
          viewId: "browser",
          viewPath: "/browser",
          tabId: "btab_1",
          url: "https://example.com/",
        },
      },
      {
        actionName: "BROWSER",
        success: true,
        text: "Browser get result (web):\nExample Domain",
        values: {
          success: true,
          mode: "web",
          targetId: "workspace",
          subaction: "get",
        },
      },
    ];
    const priorPath = window.location.href;
    const navigate = createNavigateViewHandler({
      availableViewsForDesktopTabs: [],
      invokeDesktopBridgeRequest: async () => null,
      openDesktopTab: vi.fn(),
      setActiveDesktopTabId: vi.fn(),
      setTab: vi.fn(),
    });
    window.history.replaceState(null, "", "/notes");
    window.addEventListener(NAVIGATE_VIEW_EVENT, navigate);
    try {
      expect(dispatchViewActionHandoffDirect(actionResults)).toBe(true);
      expect(window.location.pathname).toBe("/browser");
      expect(new URLSearchParams(window.location.search).get("browse")).toBe(
        "https://example.com/",
      );
    } finally {
      window.removeEventListener(NAVIGATE_VIEW_EVENT, navigate);
      window.history.replaceState(null, "", priorPath);
    }
  });

  it("ignores inherited handoff fields and delivery confirmations", () => {
    const inheritedMarker = Object.assign(
      Object.create({ completedActionDelivered: true }),
      { mode: "show", viewId: "calendar" },
    ) as Record<string, unknown>;
    expect(
      findViewActionHandoff([{ ...showCalendar, values: inheritedMarker }]),
    ).toEqual({ viewId: "calendar" });

    const inheritedHandoff = Object.create({
      mode: "show",
      viewId: "calendar",
    }) as Record<string, unknown>;
    expect(
      findViewActionHandoff([{ ...showCalendar, values: inheritedHandoff }]),
    ).toBeNull();

    const inheritedResult = Object.create(
      showCalendar,
    ) as ChatActionResultSummary;
    expect(findViewActionHandoff([inheritedResult])).toBeNull();
  });

  it("dispatches the canonical current view when WebSockets are unavailable", async () => {
    const dispatch = vi.fn();

    await expect(
      dispatchViewActionHandoff([showCalendar], {
        fetchCurrentView: async () => currentViewResponse(),
        currentPath: () => "/chat",
        dispatch,
      }),
    ).resolves.toBe(true);

    expect(dispatch).toHaveBeenCalledWith({
      viewId: "calendar",
      viewPath: "/calendar",
      viewLabel: "Calendar",
      viewType: "gui",
      source: "agent",
    });
  });

  it("dispatches the shared-runtime Knowledge destination without a server round-trip", () => {
    const dispatch = vi.fn();
    const sharedKnowledge: ChatActionResultSummary = {
      actionName: "VIEWS",
      success: true,
      values: { mode: "show", viewId: "documents", source: "agent" },
    };

    expect(dispatchViewActionHandoffDirect([sharedKnowledge], dispatch)).toBe(
      true,
    );
    expect(dispatch).toHaveBeenCalledWith({
      viewId: "documents",
      source: "agent",
    });
  });

  it("dispatches a shared host destination at its canonical path", () => {
    const dispatch = vi.fn();
    const sharedCloudApps: ChatActionResultSummary = {
      actionName: "VIEWS",
      success: true,
      values: {
        mode: "show",
        viewId: "cloud-apps",
        viewPath: "/cloud-apps",
        source: "agent",
      },
    };

    expect(dispatchViewActionHandoffDirect([sharedCloudApps], dispatch)).toBe(
      true,
    );
    expect(dispatch).toHaveBeenCalledWith({
      viewId: "cloud-apps",
      viewPath: "/cloud-apps",
      source: "agent",
    });
  });

  it("carries renderer handoff identity through direct terminal dispatch", () => {
    const dispatch = vi.fn();
    expect(
      dispatchViewActionHandoffDirect(
        [
          {
            ...showCalendar,
            values: {
              ...showCalendar.values,
              completedActionHandoffId: "handoff-calendar",
            },
          },
        ],
        dispatch,
      ),
    ).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({
      viewId: "calendar",
      source: "agent",
      completedActionHandoffId: "handoff-calendar",
    });
  });

  it("does not duplicate history when the WebSocket already switched the route", async () => {
    const dispatch = vi.fn();

    await expect(
      dispatchViewActionHandoff([showCalendar], {
        fetchCurrentView: async () => currentViewResponse(),
        currentPath: () => "/calendar",
        dispatch,
      }),
    ).resolves.toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("fails loudly when the action result and canonical current view disagree", async () => {
    await expect(
      dispatchViewActionHandoff([showCalendar], {
        fetchCurrentView: async () => currentViewResponse({ viewId: "wallet" }),
        currentPath: () => "/chat",
        dispatch: vi.fn(),
      }),
    ).rejects.toThrow(/selected "calendar" but current view is "wallet"/);
  });

  it("recovers a fresh missed agent switch without replaying edge commands", async () => {
    const dispatch = vi.fn();

    await expect(
      recoverMissedCurrentView({
        fetchCurrentView: async () =>
          currentViewResponse({
            source: "agent",
            action: "open-window",
            placement: "right",
            alwaysOnTop: true,
          }),
        currentPath: () => "/chat",
        dispatch,
      }),
    ).resolves.toBe(false);

    expect(dispatch).not.toHaveBeenCalled();

    await expect(
      recoverMissedCurrentView({
        fetchCurrentView: async () =>
          new Response(
            JSON.stringify({
              currentView: {
                viewId: "calendar",
                viewPath: "/calendar",
                viewLabel: "Calendar",
                viewType: "gui",
                source: "agent",
                action: "open-window",
                placement: "right",
                alwaysOnTop: true,
              },
              justSwitched: true,
            }),
            { status: 200 },
          ),
        currentPath: () => "/chat",
        dispatch,
      }),
    ).resolves.toBe(true);
    expect(dispatch).toHaveBeenLastCalledWith({
      viewId: "calendar",
      viewPath: "/calendar",
      viewLabel: "Calendar",
      viewType: "gui",
    });
  });

  it("does not override user navigation that changes during recovery", async () => {
    let path = "/chat";
    const dispatch = vi.fn();

    await expect(
      recoverMissedCurrentView({
        fetchCurrentView: async () => {
          path = "/settings";
          return new Response(
            JSON.stringify({
              currentView: {
                viewId: "calendar",
                viewPath: "/calendar",
                viewLabel: "Calendar",
                viewType: "gui",
                source: "agent",
              },
              justSwitched: true,
            }),
            { status: 200 },
          );
        },
        currentPath: () => path,
        dispatch,
      }),
    ).resolves.toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
