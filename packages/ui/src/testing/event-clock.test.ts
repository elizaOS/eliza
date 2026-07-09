// @vitest-environment jsdom
/**
 * Contract test for the vitest.setup.ts event-clock bridge: under jsdom,
 * `event.timeStamp` must ride the `performance.now()` clock (as it does in
 * real browsers, where both are DOMHighResTimeStamps against timeOrigin)
 * so gesture suites can slow a drag down by mocking `performance.now`.
 * Without the bridge, jsdom stamps events with epoch wall-clock milliseconds,
 * and velocity code that trusts `event.timeStamp` (use-pull-gesture's
 * eventTime) misreads every mock-clocked deliberate drag as a flick.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("jsdom event timeStamp ↔ performance.now bridge", () => {
  it("stamps a dispatched event from the mocked performance.now clock", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(1234);
    let seen = -1;
    const el = document.createElement("div");
    el.addEventListener("pointerdown", (event) => {
      seen = event.timeStamp;
    });
    el.dispatchEvent(new Event("pointerdown"));
    expect(seen).toBe(1234);
  });

  it("memoizes the first-read stamp so one event keeps one timestamp", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(100);
    const event = new Event("pointermove");
    expect(event.timeStamp).toBe(100);
    now.mockReturnValue(900); // clock advances; the event must not drift
    expect(event.timeStamp).toBe(100);
  });

  it("maps a clock mocked to exactly 0 to a truthy near-zero stamp", () => {
    // react-dom's synthetic events substitute `Date.now()` for a FALSY native
    // timeStamp (`event.timeStamp || Date.now()`) — epoch time would poison
    // the bridged clock, so 0 must surface as the smallest positive double.
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    const event = new Event("pointerdown");
    expect(event.timeStamp).toBe(Number.MIN_VALUE);
    expect(event.timeStamp).toBeGreaterThan(0);
    // Arithmetically identical to zero for velocity math: (t1 - t0) is exact.
    expect(800 - event.timeStamp).toBe(800);
  });
});
