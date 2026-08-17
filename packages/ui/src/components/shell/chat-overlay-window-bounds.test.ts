/** Verifies detached overlay stage parsing and native material-size ordering. */
import { describe, expect, it, vi } from "vitest";

import {
  createChatOverlayWindowSizeCoordinator,
  readChatOverlayAuthSize,
  readChatOverlayStageSize,
  resolveChatOverlayMaterialSize,
} from "./chat-overlay-window-bounds";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe("readChatOverlayStageSize", () => {
  it("reads native-owned stage metrics and falls back for invalid input", () => {
    expect(
      readChatOverlayStageSize(
        "?chatOverlayStageWidth=640&chatOverlayStageHeight=900",
      ),
    ).toEqual({ width: 640, height: 900 });
    expect(readChatOverlayStageSize("?chatOverlayStageWidth=nope")).toEqual({
      width: 600,
      height: 820,
    });
    expect(
      readChatOverlayAuthSize(
        "?chatOverlayAuthWidth=256&chatOverlayAuthHeight=64",
      ),
    ).toEqual({ width: 256, height: 64 });
  });
});

describe("resolveChatOverlayMaterialSize", () => {
  it("keeps the collapsed native hit area at the canonical pill frame", () => {
    expect(
      resolveChatOverlayMaterialSize({ width: 162, height: 56 }, true),
    ).toEqual({ width: 96, height: 56 });
  });

  it("matches half-sheet pixels while retaining only the pill minimum", () => {
    expect(
      resolveChatOverlayMaterialSize({ width: 599.2, height: 432.1 }),
    ).toEqual({ width: 600, height: 433 });
    expect(resolveChatOverlayMaterialSize({ width: 15, height: 9 })).toEqual({
      width: 96,
      height: 56,
    });
  });
});

describe("createChatOverlayWindowSizeCoordinator", () => {
  it("serializes motion frames and applies only the newest queued size", async () => {
    const firstSet = deferred<void>();
    const applied: Array<{ width: number; height: number }> = [];
    let setCount = 0;
    const coordinator = createChatOverlayWindowSizeCoordinator({
      setBottomBarSize: async (size) => {
        applied.push(size);
        setCount += 1;
        if (setCount === 1) await firstSet.promise;
      },
      onFailure: vi.fn(),
    });

    coordinator.schedule({ width: 600, height: 433 });
    await flushMicrotasks();
    coordinator.schedule({ width: 420.2, height: 210.1 });
    coordinator.schedule({ width: 96, height: 56 });
    firstSet.resolve();
    await coordinator.whenIdle();

    expect(applied).toEqual([
      { width: 600, height: 433 },
      { width: 96, height: 56 },
    ]);
  });

  it("deduplicates integer-equivalent material frames", async () => {
    const setBottomBarSize = vi.fn(async () => {});
    const coordinator = createChatOverlayWindowSizeCoordinator({
      setBottomBarSize,
      onFailure: vi.fn(),
    });

    coordinator.schedule({ width: 599.2, height: 432.1 });
    await coordinator.whenIdle();
    coordinator.schedule({ width: 600, height: 433 });
    await coordinator.whenIdle();
    expect(setBottomBarSize).toHaveBeenCalledTimes(1);
  });

  it("reports a rejected native write and keeps the queue settled", async () => {
    const failure = new Error("native setBottomBarSize rejected");
    const onFailure = vi.fn();
    const coordinator = createChatOverlayWindowSizeCoordinator({
      setBottomBarSize: async () => {
        throw failure;
      },
      onFailure,
    });

    coordinator.schedule({ width: 600, height: 433 });
    await coordinator.whenIdle();
    expect(onFailure).toHaveBeenCalledWith(failure);
  });

  it("rejects invalid renderer geometry before crossing the bridge", () => {
    const setBottomBarSize = vi.fn(async () => {});
    const coordinator = createChatOverlayWindowSizeCoordinator({
      setBottomBarSize,
      onFailure: vi.fn(),
    });
    expect(() => coordinator.schedule({ width: 0, height: 56 })).toThrow(
      "material size must be positive and finite",
    );
    expect(setBottomBarSize).not.toHaveBeenCalled();
  });
});
