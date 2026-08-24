/**
 * Verifies the view-author hooks (`useViewLifecycle`, `usePauseAware`,
 * `usePausableInterval`) against the REAL ViewLifecycleController through a
 * live `ViewLifecycleSlot`: transitions are driven by controller commands
 * (`setActive`, `markPaused`, `markResumed`, `markCrashed`,
 * `markRecovering`), never by mocked subscriptions, and timer bookkeeping is
 * asserted through the real resource-counter registry. jsdom environment;
 * fake timers only for the interval cases.
 */
// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetResourceCountersForTests,
  snapshotResourceCounters,
} from "../perf/resource-counters";
import {
  usePausableInterval,
  usePauseAware,
  useViewLifecycle,
} from "./useViewLifecycle";
import {
  __resetViewLifecycleForTests,
  viewLifecycleController as ctrl,
  registerViewPolicy,
} from "./view-lifecycle";
import { ViewLifecycleSlot } from "./view-lifecycle-context";

const VIEW_ID = "lifecycle-probe-view";
const OTHER_VIEW_ID = "lifecycle-other-view";

function slotWrapper(
  viewId: string = VIEW_ID,
): ({ children }: { children: ReactNode }) => React.JSX.Element {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <ViewLifecycleSlot viewId={viewId} hidden={false}>
        {children}
      </ViewLifecycleSlot>
    );
  };
}

beforeEach(() => {
  __resetViewLifecycleForTests();
  __resetResourceCountersForTests();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  __resetViewLifecycleForTests();
  __resetResourceCountersForTests();
});

describe("useViewLifecycle", () => {
  it("falls back to the active state and fires no handlers outside a slot", () => {
    const handlers = {
      onMount: vi.fn(),
      onShow: vi.fn(),
      onHide: vi.fn(),
      onPause: vi.fn(),
      onResume: vi.fn(),
      onEvict: vi.fn(),
      onRestore: vi.fn(),
    };
    const { result } = renderHook(() => useViewLifecycle(handlers));

    expect(result.current).toEqual({
      phase: "active",
      isActive: true,
      isPaused: false,
      isHidden: false,
    });
    for (const handler of Object.values(handlers)) {
      expect(handler).not.toHaveBeenCalled();
    }

    const pauseAware = renderHook(() => usePauseAware());
    expect(pauseAware.result.current).toEqual({ paused: false, active: true });
  });

  it("fires onMount once inside a slot and seeds state from the controller's current phase", () => {
    registerViewPolicy(VIEW_ID, { keepAlive: true, pausable: true });
    ctrl.setActive(VIEW_ID);
    // Hide behind another active view: the retained view is now paused.
    ctrl.setActive(OTHER_VIEW_ID);
    expect(ctrl.getPhase(VIEW_ID)).toBe("paused");

    const onMount = vi.fn();
    const { result } = renderHook(() => useViewLifecycle({ onMount }), {
      wrapper: slotWrapper(),
    });

    expect(onMount).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({
      phase: "paused",
      isActive: false,
      isPaused: true,
      isHidden: true,
    });
  });

  it("dispatches onShow and reports active when the view becomes visible", () => {
    const events: string[] = [];
    const { result } = renderHook(
      () =>
        useViewLifecycle({
          onShow: () => events.push("show"),
          onHide: () => events.push("hide"),
          onPause: (reason) => events.push(`pause:${reason}`),
          onResume: () => events.push("resume"),
          onEvict: (reason) => events.push(`evict:${reason}`),
          onRestore: () => events.push("restore"),
        }),
      { wrapper: slotWrapper() },
    );

    act(() => {
      ctrl.setActive(VIEW_ID);
    });

    expect(events).toEqual(["show"]);
    expect(result.current).toEqual({
      phase: "active",
      isActive: true,
      isPaused: false,
      isHidden: false,
    });
  });

  it("pauses a retained view on hide (onHide before onPause) and resumes to inactive", () => {
    registerViewPolicy(VIEW_ID, { keepAlive: true, pausable: true });
    const events: string[] = [];
    const { result } = renderHook(
      () =>
        useViewLifecycle({
          onShow: () => events.push("show"),
          onHide: () => events.push("hide"),
          onPause: (reason) => events.push(`pause:${reason}`),
          onResume: () => events.push("resume"),
        }),
      { wrapper: slotWrapper() },
    );

    act(() => {
      ctrl.setActive(VIEW_ID);
    });
    act(() => {
      ctrl.setActive(OTHER_VIEW_ID);
    });

    // Hide of a pausable keep-alive view stops resources (hide) AND pauses.
    expect(events).toEqual(["show", "hide", "pause:hide"]);
    expect(result.current).toEqual({
      phase: "paused",
      isActive: false,
      isPaused: true,
      isHidden: true,
    });

    // Resuming while hidden restores to inactive, routed to onResume.
    act(() => {
      ctrl.markResumed(VIEW_ID);
    });
    expect(events).toEqual(["show", "hide", "pause:hide", "resume"]);
    expect(result.current).toEqual({
      phase: "inactive",
      isActive: false,
      isPaused: false,
      isHidden: true,
    });
  });

  it("defaults the pause reason to app-pause and routes resume to onResume, not onShow", () => {
    const events: string[] = [];
    const { result } = renderHook(
      () =>
        useViewLifecycle({
          onShow: () => events.push("show"),
          onHide: () => events.push("hide"),
          onPause: (reason) => events.push(`pause:${reason}`),
          onResume: () => events.push("resume"),
        }),
      { wrapper: slotWrapper() },
    );

    act(() => {
      ctrl.setActive(VIEW_ID);
    });
    act(() => {
      ctrl.markPaused(VIEW_ID);
    });
    act(() => {
      ctrl.markResumed(VIEW_ID);
    });

    // Entering "paused" always stops resources first: onHide then onPause,
    // with markPaused's default reason.
    expect(events).toEqual(["show", "hide", "pause:app-pause", "resume"]);
    expect(result.current).toEqual({
      phase: "active",
      isActive: true,
      isPaused: false,
      isHidden: false,
    });
  });

  it("reports crashed phases without a handler and dispatches onRestore while recovering", () => {
    const events: string[] = [];
    const { result } = renderHook(
      () =>
        useViewLifecycle({
          onShow: () => events.push("show"),
          onHide: () => events.push("hide"),
          onPause: (reason) => events.push(`pause:${reason}`),
          onResume: () => events.push("resume"),
          onEvict: (reason) => events.push(`evict:${reason}`),
          onRestore: () => events.push("restore"),
        }),
      { wrapper: slotWrapper() },
    );

    act(() => {
      ctrl.setActive(VIEW_ID);
    });
    act(() => {
      ctrl.markCrashed(VIEW_ID);
    });

    // Crashing has no dedicated handler branch: state updates, handlers don't.
    expect(events).toEqual(["show"]);
    expect(result.current).toEqual({
      phase: "crashed",
      isActive: false,
      isPaused: false,
      isHidden: false,
    });

    act(() => {
      ctrl.markRecovering(VIEW_ID);
    });

    expect(events).toEqual(["show", "restore", "resume"]);
    expect(result.current).toEqual({
      phase: "active",
      isActive: true,
      isPaused: false,
      isHidden: false,
    });
  });

  it("delivers onEvict when a default-policy view is hidden by another view", () => {
    const events: string[] = [];
    const { result } = renderHook(
      () =>
        useViewLifecycle({
          onEvict: (reason) => events.push(`evict:${reason}`),
        }),
      { wrapper: slotWrapper() },
    );

    act(() => {
      ctrl.setActive(VIEW_ID);
    });
    act(() => {
      ctrl.setActive(OTHER_VIEW_ID);
    });

    // Default policy unmounts on hide: the hook observes the eviction.
    expect(events).toEqual([`evict:inactive`]);
    expect(result.current).toEqual({
      phase: "evicted",
      isActive: false,
      isPaused: false,
      isHidden: false,
    });
    expect(ctrl.getPhase(VIEW_ID)).toBeNull();
  });

  it("routes transitions to the latest handlers across rerenders without remounting", () => {
    const firstHandlers = { onMount: vi.fn(), onShow: vi.fn() };
    const secondHandlers = { onMount: vi.fn(), onShow: vi.fn() };
    const { rerender } = renderHook(
      ({
        handlers,
      }: {
        handlers: { onMount: () => void; onShow: () => void };
      }) => useViewLifecycle(handlers),
      { wrapper: slotWrapper(), initialProps: { handlers: firstHandlers } },
    );

    rerender({ handlers: secondHandlers });
    act(() => {
      ctrl.setActive(VIEW_ID);
    });

    expect(firstHandlers.onMount).toHaveBeenCalledTimes(1);
    expect(secondHandlers.onMount).not.toHaveBeenCalled();
    expect(firstHandlers.onShow).not.toHaveBeenCalled();
    expect(secondHandlers.onShow).toHaveBeenCalledTimes(1);
  });

  it("stops delivering transitions after unmount", () => {
    const onShow = vi.fn();
    const { unmount } = renderHook(() => useViewLifecycle({ onShow }), {
      wrapper: slotWrapper(),
    });

    unmount();
    act(() => {
      ctrl.setActive(VIEW_ID);
    });
    expect(onShow).not.toHaveBeenCalled();
  });
});

describe("usePauseAware", () => {
  it("mirrors pause and resume into the paused/active booleans", () => {
    const { result } = renderHook(() => usePauseAware(), {
      wrapper: slotWrapper(),
    });

    act(() => {
      ctrl.setActive(VIEW_ID);
    });
    expect(result.current).toEqual({ paused: false, active: true });

    act(() => {
      ctrl.markPaused(VIEW_ID);
    });
    expect(result.current).toEqual({ paused: true, active: false });

    act(() => {
      ctrl.markResumed(VIEW_ID);
    });
    expect(result.current).toEqual({ paused: false, active: true });
  });
});

describe("usePausableInterval", () => {
  it("runs while active and registers exactly one pending timer for the scoped view", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    renderHook(() => usePausableInterval(callback, 10), {
      wrapper: slotWrapper(),
    });

    act(() => {
      vi.advanceTimersByTime(35);
    });

    expect(callback).toHaveBeenCalledTimes(3);
    expect(snapshotResourceCounters(VIEW_ID).pendingTimers).toBe(1);
  });

  it("tracks the timer under the unscoped id outside a slot", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    renderHook(() => usePausableInterval(callback, 10));

    act(() => {
      vi.advanceTimersByTime(20);
    });

    expect(callback).toHaveBeenCalledTimes(2);
    expect(snapshotResourceCounters("unscoped").pendingTimers).toBe(1);
  });

  it("stops and untracks the timer while paused and restarts it on resume", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    renderHook(() => usePausableInterval(callback, 10), {
      wrapper: slotWrapper(),
    });

    act(() => {
      ctrl.setActive(VIEW_ID);
    });
    act(() => {
      vi.advanceTimersByTime(10);
    });
    const beforePause = callback.mock.calls.length;
    expect(beforePause).toBeGreaterThanOrEqual(1);
    expect(snapshotResourceCounters(VIEW_ID).pendingTimers).toBe(1);

    act(() => {
      ctrl.markPaused(VIEW_ID);
    });
    expect(snapshotResourceCounters(VIEW_ID).pendingTimers).toBe(0);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(callback).toHaveBeenCalledTimes(beforePause);

    act(() => {
      ctrl.markResumed(VIEW_ID);
    });
    expect(snapshotResourceCounters(VIEW_ID).pendingTimers).toBe(1);
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(callback.mock.calls.length).toBeGreaterThan(beforePause);
  });

  it("clears the interval and releases the timer on unmount", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const { unmount } = renderHook(() => usePausableInterval(callback, 10), {
      wrapper: slotWrapper(),
    });
    expect(snapshotResourceCounters(VIEW_ID).pendingTimers).toBe(1);

    unmount();

    expect(snapshotResourceCounters(VIEW_ID).pendingTimers).toBe(0);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it("never starts for non-positive delays and tracks no timer", () => {
    vi.useFakeTimers();
    const zeroDelay = vi.fn();
    const zero = renderHook(() => usePausableInterval(zeroDelay, 0), {
      wrapper: slotWrapper(),
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(zeroDelay).not.toHaveBeenCalled();
    expect(snapshotResourceCounters(VIEW_ID).pendingTimers).toBe(0);
    zero.unmount();

    const negativeDelay = vi.fn();
    renderHook(() => usePausableInterval(negativeDelay, -5), {
      wrapper: slotWrapper(),
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(negativeDelay).not.toHaveBeenCalled();
    expect(snapshotResourceCounters(VIEW_ID).pendingTimers).toBe(0);
  });
});
