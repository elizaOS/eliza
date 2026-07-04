/**
 * Unit coverage for the Android screen-capture poller: mocks the Capacitor
 * plugin and asserts the pull loop's request/frame round-trip and backoff.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Make isNativeMobile() true and the capture plugin present so the poller runs.
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "android" },
}));
vi.mock("../bridge/native-plugins", () => ({
  getScreenCapturePlugin: () => ({}),
}));

import {
  __resetScreenCaptureBridgeForTests,
  computePollDelayMs,
  initScreenCaptureBridge,
} from "./screen-capture-bridge";

describe("computePollDelayMs — vision-poll backoff curve", () => {
  it("stays at the fast 1500ms interval below the failure threshold", () => {
    for (const failures of [0, 1, 2, 3, 4]) {
      expect(computePollDelayMs(failures)).toBe(1500);
    }
  });

  it("backs off exponentially once the streak crosses the threshold", () => {
    expect(computePollDelayMs(5)).toBe(3000); // 1500 * 2^1
    expect(computePollDelayMs(6)).toBe(6000); // 1500 * 2^2
    expect(computePollDelayMs(7)).toBe(12000);
    expect(computePollDelayMs(8)).toBe(24000);
  });

  it("caps the backoff at 60s", () => {
    expect(computePollDelayMs(100)).toBe(60000);
    expect(computePollDelayMs(10_000)).toBe(60000);
  });
});

describe("screen-capture bridge poller — a 404 route is not hammered forever", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    __resetScreenCaptureBridgeForTests();
  });
  afterEach(() => {
    __resetScreenCaptureBridgeForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("backs off under sustained 404s instead of polling every 1500ms", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    initScreenCaptureBridge();

    // Over a 120s horizon, a fixed 1500ms poller would fire ~80 times. With the
    // backoff the streak stretches the interval toward the 60s cap, so it fires
    // an order of magnitude less.
    await vi.advanceTimersByTimeAsync(120_000);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.length).toBeLessThan(20);
  });

  it("does not schedule further polls after reset (no leaked timer)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    initScreenCaptureBridge();
    await vi.advanceTimersByTimeAsync(5000);
    __resetScreenCaptureBridgeForTests();
    const callsAtReset = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock.mock.calls.length).toBe(callsAtReset);
  });
});
