/**
 * Unit coverage for browser-frame streaming flushes and the non-DOM fallback.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelStreamingRenderFrame,
  requestStreamingRenderFrame,
} from "./streaming-render-cadence";

describe("streaming render frame scheduling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("aligns a browser flush with requestAnimationFrame", () => {
    let frameCallback: FrameRequestCallback | undefined;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frameCallback = callback;
        return 42;
      }),
    );
    const callback = vi.fn();

    expect(requestStreamingRenderFrame(callback)).toBe(42);
    expect(callback).not.toHaveBeenCalled();

    frameCallback?.(16.7);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("uses a microtask when animation frames are unavailable", async () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    const callback = vi.fn();

    expect(requestStreamingRenderFrame(callback)).toBeNull();
    expect(callback).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("cancels a scheduled browser frame", () => {
    const cancel = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancel);

    cancelStreamingRenderFrame(42);

    expect(cancel).toHaveBeenCalledWith(42);
  });
});
