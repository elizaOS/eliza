/**
 * Unit coverage for the chat stream paint cadence, including first-paint,
 * in-window delay, elapsed-window, and monotonic-clock edge behavior.
 */

import { describe, expect, it } from "vitest";
import {
  STREAMING_RENDER_INTERVAL_MS,
  streamingRenderDelayMs,
} from "./streaming-render-cadence";

describe("streamingRenderDelayMs", () => {
  it("paints the first snapshot immediately", () => {
    expect(streamingRenderDelayMs(null, 100)).toBe(0);
  });

  it("returns the remaining cadence delay", () => {
    expect(streamingRenderDelayMs(100, 110)).toBe(
      STREAMING_RENDER_INTERVAL_MS - 10,
    );
  });

  it("paints immediately once the cadence window elapsed", () => {
    expect(
      streamingRenderDelayMs(100, 100 + STREAMING_RENDER_INTERVAL_MS),
    ).toBe(0);
  });

  it("waits a full interval if the monotonic clock moves backward", () => {
    expect(streamingRenderDelayMs(100, 90)).toBe(STREAMING_RENDER_INTERVAL_MS);
  });
});
