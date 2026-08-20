/**
 * Exercises renderer-observed navigation deduplication with real cancelable DOM
 * events, including both transport arrival orders and an unhandled early frame.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchCompletedActionNavigation,
  markCompletedActionNavigationHandled,
  resetCompletedActionNavigationForTests,
} from "./completed-action-navigation";
import { NAVIGATE_VIEW_EVENT } from "./events";
import { dispatchViewActionHandoffDirect } from "./view-action-handoff";

function terminalDelivery(
  completedActionHandoffId: string,
  viewId = "calendar",
): boolean {
  return dispatchViewActionHandoffDirect([
    {
      actionName: "VIEWS",
      success: true,
      values: {
        mode: "show",
        viewId,
        completedActionHandoffId,
      },
    },
  ]);
}

function websocketDelivery(
  completedActionHandoffId: string,
  viewId = "calendar",
): boolean {
  return dispatchCompletedActionNavigation({
    viewId,
    completedActionHandoffId,
  });
}

describe("completed action navigation", () => {
  beforeEach(() => window.history.replaceState(null, "", "/chat"));
  afterEach(() => resetCompletedActionNavigationForTests());

  it.each([
    ["WebSocket-first", websocketDelivery, terminalDelivery],
    ["terminal-first", terminalDelivery, websocketDelivery],
  ] as const)(
    "deduplicates real %s delivery after shell handling",
    (_order, firstDelivery, secondDelivery) => {
      const seen: string[] = [];
      const listener = (event: Event) => {
        const detail = (event as CustomEvent).detail;
        seen.push(detail.viewId);
        markCompletedActionNavigationHandled(event, detail);
      };
      window.addEventListener(NAVIGATE_VIEW_EVENT, listener);

      expect(firstDelivery("handoff-both-orders")).toBe(true);
      expect(secondDelivery("handoff-both-orders")).toBe(false);
      expect(seen).toEqual(["calendar"]);

      window.removeEventListener(NAVIGATE_VIEW_EVENT, listener);
    },
  );

  it("retries at terminal delivery when the early frame had no mounted handler", () => {
    const detail = {
      viewId: "notes",
      completedActionHandoffId: "handoff-unhandled-early",
    };
    expect(dispatchCompletedActionNavigation(detail)).toBe(true);

    const listener = vi.fn((event: Event) => {
      markCompletedActionNavigationHandled(
        event,
        (event as CustomEvent).detail,
      );
    });
    window.addEventListener(NAVIGATE_VIEW_EVENT, listener);
    expect(dispatchCompletedActionNavigation(detail)).toBe(true);
    expect(dispatchCompletedActionNavigation(detail)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(NAVIGATE_VIEW_EVENT, listener);
  });

  it.each([
    ["WebSocket-first", websocketDelivery, terminalDelivery],
    ["terminal-first", terminalDelivery, websocketDelivery],
  ] as const)(
    "does not pull the renderer back after handled %s delivery and user navigation",
    (order, firstDelivery, secondDelivery) => {
      const seen: string[] = [];
      const listener = (event: Event) => {
        const detail = (event as CustomEvent).detail;
        seen.push(detail.viewId);
        markCompletedActionNavigationHandled(event, detail);
      };
      window.addEventListener(NAVIGATE_VIEW_EVENT, listener);
      const handoffId = `handled-${order}`;
      expect(firstDelivery(handoffId)).toBe(true);
      window.history.pushState(null, "", "/settings");
      window.dispatchEvent(new PopStateEvent("popstate"));
      expect(secondDelivery(handoffId)).toBe(false);
      expect(window.location.pathname).toBe("/settings");
      expect(seen).toEqual(["calendar"]);
      window.removeEventListener(NAVIGATE_VIEW_EVENT, listener);
    },
  );

  it("lets intervening user navigation win when the early frame was unhandled", () => {
    expect(websocketDelivery("unhandled-before-user-navigation", "notes")).toBe(
      true,
    );

    window.history.pushState(null, "", "/settings");
    const listener = vi.fn();
    window.addEventListener(NAVIGATE_VIEW_EVENT, listener);
    expect(terminalDelivery("unhandled-before-user-navigation", "notes")).toBe(
      false,
    );
    expect(websocketDelivery("unhandled-before-user-navigation", "notes")).toBe(
      false,
    );
    expect(window.location.pathname).toBe("/settings");
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(NAVIGATE_VIEW_EVENT, listener);
  });

  it("uses the navigation epoch when user navigation keeps the same path", () => {
    const detail = {
      viewId: "notes",
      completedActionHandoffId: "unhandled-before-same-path-navigation",
    };
    expect(dispatchCompletedActionNavigation(detail)).toBe(true);

    window.dispatchEvent(new PopStateEvent("popstate"));
    const listener = vi.fn();
    window.addEventListener(NAVIGATE_VIEW_EVENT, listener);
    expect(dispatchCompletedActionNavigation(detail)).toBe(false);
    expect(window.location.pathname).toBe("/chat");
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(NAVIGATE_VIEW_EVENT, listener);
  });

  it("does not deduplicate unrelated navigation without a handoff id", () => {
    const listener = (event: Event) => {
      markCompletedActionNavigationHandled(
        event,
        (event as CustomEvent).detail,
      );
    };
    window.addEventListener(NAVIGATE_VIEW_EVENT, listener);
    expect(dispatchCompletedActionNavigation({ viewId: "wallet" })).toBe(true);
    expect(dispatchCompletedActionNavigation({ viewId: "wallet" })).toBe(true);
    window.removeEventListener(NAVIGATE_VIEW_EVENT, listener);
  });

  it("bounds handled history and permits an evicted id to run again", () => {
    const listener = (event: Event) => {
      markCompletedActionNavigationHandled(
        event,
        (event as CustomEvent).detail,
      );
    };
    window.addEventListener(NAVIGATE_VIEW_EVENT, listener);
    for (let index = 0; index <= 256; index++) {
      expect(
        dispatchCompletedActionNavigation({
          viewId: "calendar",
          completedActionHandoffId: `bounded-${index}`,
        }),
      ).toBe(true);
    }
    expect(
      dispatchCompletedActionNavigation({
        viewId: "calendar",
        completedActionHandoffId: "bounded-0",
      }),
    ).toBe(true);
    window.removeEventListener(NAVIGATE_VIEW_EVENT, listener);
  });
});
