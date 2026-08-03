/**
 * Unit coverage for browser-frame streaming flushes and the non-DOM fallback.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelStreamingRenderFrame,
  requestStreamingRenderFrame,
  STREAMING_RENDER_INTERVAL_MS,
  streamingRenderDelayMs,
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

describe("streaming render cadence", () => {
  it("does not delay the first transcript snapshot", () => {
    expect(streamingRenderDelayMs(null, 100)).toBe(0);
  });

  it("returns the remainder of the cadence window", () => {
    expect(streamingRenderDelayMs(100, 110)).toBe(
      STREAMING_RENDER_INTERVAL_MS - 10,
    );
  });

  it("allows a snapshot once the cadence window has elapsed", () => {
    expect(
      streamingRenderDelayMs(100, 100 + STREAMING_RENDER_INTERVAL_MS),
    ).toBe(0);
  });

  it("waits a full interval if the monotonic clock moves backward", () => {
    expect(streamingRenderDelayMs(100, 90)).toBe(STREAMING_RENDER_INTERVAL_MS);
  });
});
