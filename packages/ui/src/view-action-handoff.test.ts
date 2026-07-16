/**
 * Transport-independent VIEWS action handoff tests, using real Response bodies
 * and the shared navigate-event payload rather than a WebSocket fixture.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from "vitest";
import type { ChatActionResultSummary } from "./api/client-types-chat";
import {
  dispatchViewActionHandoff,
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
