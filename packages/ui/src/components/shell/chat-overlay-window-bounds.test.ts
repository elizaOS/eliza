/**
 * Verifies desktop chat-overlay geometry and the deterministic async ordering
 * of mocked renderer-to-main bounds requests.
 */
import { describe, expect, it, vi } from "vitest";

import {
  type ChatOverlayWindowBounds,
  computeChatOverlayWindowBounds,
  createChatOverlayWindowBoundsCoordinator,
  resolveChatOverlayCompactWindowSize,
  shouldHideRestingChatOverlay,
} from "./chat-overlay-window-bounds";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

describe("computeChatOverlayWindowBounds", () => {
  it("clamps an opened overlay to a short primary-display work area", () => {
    expect(
      computeChatOverlayWindowBounds(
        { x: 659, y: 762, width: 48, height: 6 },
        { x: 0, y: 24, width: 1_366, height: 744 },
        true,
      ),
    ).toEqual({ x: 383, y: 24, width: 600, height: 744 });
  });

  it("restores the closed bar at the same in-work-area bottom edge", () => {
    expect(
      computeChatOverlayWindowBounds(
        { x: 383, y: 24, width: 600, height: 744 },
        { x: 0, y: 24, width: 1_366, height: 744 },
        false,
      ),
    ).toEqual({ x: 659, y: 762, width: 48, height: 6 });
  });
});

describe("resolveChatOverlayCompactWindowSize", () => {
  it("gives the visible composer a real first native frame", () => {
    expect(
      resolveChatOverlayCompactWindowSize("input", {
        width: 600,
        height: 820,
      }),
    ).toEqual({ width: 576, height: 64 });
  });

  it("keeps the final white-bar rest hitbox exact", () => {
    expect(
      resolveChatOverlayCompactWindowSize("resting", {
        width: 600,
        height: 820,
      }),
    ).toEqual({ width: 48, height: 6 });
  });
});

describe("shouldHideRestingChatOverlay", () => {
  it("keeps the window visible while Escape collapses sheet or composer", () => {
    expect(shouldHideRestingChatOverlay("Escape", "sheet")).toBe(false);
    expect(shouldHideRestingChatOverlay("Escape", "input")).toBe(false);
  });

  it("hides only on Escape from the already-settled resting pill", () => {
    expect(shouldHideRestingChatOverlay("Escape", "resting")).toBe(true);
    expect(shouldHideRestingChatOverlay("Enter", "resting")).toBe(false);
  });
});

describe("createChatOverlayWindowBoundsCoordinator", () => {
  it("serializes close behind an in-flight open and leaves the final frame closed", async () => {
    let current: ChatOverlayWindowBounds = {
      x: 696,
      y: 894,
      width: 48,
      height: 6,
    };
    const firstSet = deferred<void>();
    const applied: ChatOverlayWindowBounds[] = [];
    const onFailure = vi.fn();
    let setCount = 0;
    const coordinator = createChatOverlayWindowBoundsCoordinator({
      getWindowBounds: async () => current,
      getPrimaryDisplay: async () => ({
        workArea: { x: 0, y: 0, width: 1_440, height: 900 },
      }),
      setWindowBounds: async (bounds) => {
        applied.push(bounds);
        setCount += 1;
        if (setCount === 1) await firstSet.promise;
        current = bounds;
      },
      onFailure,
    });

    coordinator.schedule(true);
    await flushMicrotasks();
    expect(applied.map((bounds) => bounds.height)).toEqual([820]);

    coordinator.schedule(false);
    await flushMicrotasks();
    expect(applied).toHaveLength(1);

    firstSet.resolve();
    await coordinator.whenIdle();
    expect(applied.map((bounds) => bounds.height)).toEqual([820, 6]);
    expect(current).toEqual({ x: 696, y: 894, width: 48, height: 6 });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("cancels a stale open before it can set bounds", async () => {
    const firstBounds = deferred<ChatOverlayWindowBounds | null>();
    const firstDisplay = deferred<{
      workArea: ChatOverlayWindowBounds;
    } | null>();
    const current = { x: 696, y: 894, width: 48, height: 6 };
    const setWindowBounds = vi.fn(async () => {});
    let readCount = 0;
    const coordinator = createChatOverlayWindowBoundsCoordinator({
      getWindowBounds: async () => {
        readCount += 1;
        return readCount === 1 ? firstBounds.promise : current;
      },
      getPrimaryDisplay: async () =>
        readCount === 1
          ? firstDisplay.promise
          : { workArea: { x: 0, y: 0, width: 1_440, height: 900 } },
      setWindowBounds,
      onFailure: vi.fn(),
    });

    coordinator.schedule(true);
    await flushMicrotasks();
    coordinator.cancel();
    coordinator.schedule(false);
    firstBounds.resolve(current);
    firstDisplay.resolve({
      workArea: { x: 0, y: 0, width: 1_440, height: 900 },
    });

    await coordinator.whenIdle();
    expect(setWindowBounds).not.toHaveBeenCalled();
  });

  it("reports a rejected bounds write and keeps the queue settled", async () => {
    const failure = new Error("native setBounds rejected");
    const onFailure = vi.fn();
    const coordinator = createChatOverlayWindowBoundsCoordinator({
      getWindowBounds: async () => ({
        x: 696,
        y: 894,
        width: 48,
        height: 6,
      }),
      getPrimaryDisplay: async () => ({
        workArea: { x: 0, y: 0, width: 1_440, height: 900 },
      }),
      setWindowBounds: async () => {
        throw failure;
      },
      onFailure,
    });

    coordinator.schedule(true);
    await coordinator.whenIdle();
    expect(onFailure).toHaveBeenCalledWith(failure);
  });
});
