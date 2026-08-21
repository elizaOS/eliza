/**
 * Verifies desktop chat-overlay geometry and the deterministic async ordering
 * of mocked renderer-to-main bounds requests.
 */
import { describe, expect, it, vi } from "vitest";

import {
  type ChatOverlayWindowBounds,
  computeChatOverlayWindowBounds,
  createChatOverlayWindowBoundsCoordinator,
  createChatOverlayWindowSizeCoordinator,
  resolveChatOverlayCompactWindowSize,
  resolveChatOverlayMaterialSize,
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
        { x: 651, y: 744, width: 64, height: 24 },
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
    ).toEqual({ x: 651, y: 744, width: 64, height: 24 });
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

  it("keeps the final visible resting capsule hitbox exact", () => {
    expect(
      resolveChatOverlayCompactWindowSize("resting", {
        width: 600,
        height: 820,
      }),
    ).toEqual({ width: 64, height: 24 });
  });
});

describe("resolveChatOverlayMaterialSize", () => {
  it("keeps the visible panel bounds until the pill collapse reaches rest", () => {
    expect(
      resolveChatOverlayMaterialSize({ width: 312, height: 48 }, true, 0.4),
    ).toEqual({ width: 312, height: 48 });
    expect(
      resolveChatOverlayMaterialSize({ width: 312, height: 48 }, true, 0),
    ).toEqual({ width: 64, height: 24 });
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
      x: 688,
      y: 876,
      width: 64,
      height: 24,
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
    expect(applied.map((bounds) => bounds.height)).toEqual([820, 24]);
    expect(current).toEqual({ x: 688, y: 876, width: 64, height: 24 });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("cancels a stale open before it can set bounds", async () => {
    const firstBounds = deferred<ChatOverlayWindowBounds | null>();
    const firstDisplay = deferred<{
      workArea: ChatOverlayWindowBounds;
    } | null>();
    const current = { x: 688, y: 876, width: 64, height: 24 };
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
        x: 688,
        y: 876,
        width: 64,
        height: 24,
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

describe("createChatOverlayWindowSizeCoordinator", () => {
  it("restores the latest detent after an older native resize completes", async () => {
    const restingWrite = deferred<void>();
    const applied: Array<{ width: number; height: number }> = [];
    const onFailure = vi.fn();
    const coordinator = createChatOverlayWindowSizeCoordinator({
      setBottomBarSize: async (size) => {
        applied.push(size);
        if (size.height === 24) await restingWrite.promise;
      },
      onFailure,
    });

    coordinator.schedule({ width: 576, height: 64 });
    await coordinator.whenIdle();

    coordinator.schedule({ width: 64, height: 24 });
    await flushMicrotasks();
    expect(applied).toEqual([
      { width: 576, height: 64 },
      { width: 64, height: 24 },
    ]);

    // The final renderer request intentionally matches the size that was last
    // settled before the in-flight resting write. It must still invalidate the
    // older revision and restore the composer after that write completes.
    coordinator.schedule({ width: 576, height: 64 });
    restingWrite.resolve();
    await coordinator.whenIdle();

    expect(applied).toEqual([
      { width: 576, height: 64 },
      { width: 64, height: 24 },
      { width: 576, height: 64 },
    ]);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("cancels a queued stale resize when the latest size is already applied", async () => {
    const firstWrite = deferred<void>();
    const applied: Array<{ width: number; height: number }> = [];
    const coordinator = createChatOverlayWindowSizeCoordinator({
      setBottomBarSize: async (size) => {
        applied.push(size);
        if (applied.length === 1) await firstWrite.promise;
      },
      onFailure: vi.fn(),
    });

    coordinator.schedule({ width: 576, height: 64 });
    await flushMicrotasks();
    coordinator.schedule({ width: 64, height: 24 });
    coordinator.schedule({ width: 576, height: 64 });
    firstWrite.resolve();
    await coordinator.whenIdle();

    expect(applied).toEqual([{ width: 576, height: 64 }]);
  });
});
