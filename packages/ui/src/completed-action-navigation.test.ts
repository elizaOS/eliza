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

describe("completed action navigation", () => {
  beforeEach(() => window.history.replaceState(null, "", "/chat"));
  afterEach(() => resetCompletedActionNavigationForTests());

  it("deduplicates WebSocket-first and terminal-first delivery after shell handling", () => {
    const seen: string[] = [];
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      seen.push(detail.viewId);
      markCompletedActionNavigationHandled(event, detail);
    };
    window.addEventListener(NAVIGATE_VIEW_EVENT, listener);

    const detail = {
      viewId: "calendar",
      completedActionHandoffId: "handoff-both-orders",
    };
    expect(dispatchCompletedActionNavigation(detail)).toBe(true);
    expect(dispatchCompletedActionNavigation(detail)).toBe(false);
    expect(seen).toEqual(["calendar"]);

    window.removeEventListener(NAVIGATE_VIEW_EVENT, listener);
  });

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

  it.each(["WebSocket-first", "terminal-first"])(
    "does not pull the renderer back after handled %s delivery and user navigation",
    (order) => {
      const seen: string[] = [];
      const listener = (event: Event) => {
        const detail = (event as CustomEvent).detail;
        seen.push(detail.viewId);
        markCompletedActionNavigationHandled(event, detail);
      };
      window.addEventListener(NAVIGATE_VIEW_EVENT, listener);
      const detail = {
        viewId: "calendar",
        completedActionHandoffId: `handled-${order}`,
      };

      expect(dispatchCompletedActionNavigation(detail)).toBe(true);
      window.history.pushState(null, "", "/settings");
      window.dispatchEvent(new PopStateEvent("popstate"));
      expect(dispatchCompletedActionNavigation(detail)).toBe(false);
      expect(window.location.pathname).toBe("/settings");
      expect(seen).toEqual(["calendar"]);
      window.removeEventListener(NAVIGATE_VIEW_EVENT, listener);
    },
  );

  it("lets intervening user navigation win when the early frame was unhandled", () => {
    const detail = {
      viewId: "notes",
      completedActionHandoffId: "unhandled-before-user-navigation",
    };
    expect(dispatchCompletedActionNavigation(detail)).toBe(true);

    window.history.pushState(null, "", "/settings");
    const listener = vi.fn();
    window.addEventListener(NAVIGATE_VIEW_EVENT, listener);
    expect(dispatchCompletedActionNavigation(detail)).toBe(false);
    expect(dispatchCompletedActionNavigation(detail)).toBe(false);
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
