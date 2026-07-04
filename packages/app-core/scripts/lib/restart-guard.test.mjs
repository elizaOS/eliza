/** Exercises restart guard behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";

import { registerRestartAndShouldAbort } from "./restart-guard.mjs";

const MAX = 5;
const WINDOW = 60_000;

describe("registerRestartAndShouldAbort", () => {
  it("allows restarts up to and including the threshold", () => {
    const ts = [];
    // 5 restarts at the same instant: count never exceeds MAX → no abort.
    for (let i = 0; i < MAX; i += 1) {
      expect(registerRestartAndShouldAbort(ts, 1_000, MAX, WINDOW)).toBe(false);
    }
    expect(ts).toHaveLength(MAX);
  });

  it("aborts on the (MAX+1)-th restart inside the window", () => {
    const ts = [];
    for (let i = 0; i < MAX; i += 1) {
      registerRestartAndShouldAbort(ts, 1_000, MAX, WINDOW);
    }
    // The 6th restart within the window trips the guard.
    expect(registerRestartAndShouldAbort(ts, 1_000, MAX, WINDOW)).toBe(true);
    expect(ts).toHaveLength(MAX + 1);
  });

  it("trims timestamps outside the window so a slow restart cadence never aborts", () => {
    const ts = [];
    // One restart every 20s — only ever ~3 fit in a 60s window, far below MAX.
    for (let i = 0; i < 20; i += 1) {
      const now = i * 20_000;
      expect(registerRestartAndShouldAbort(ts, now, MAX, WINDOW)).toBe(false);
      // Window holds at most ceil(WINDOW/20000)+1 = 4 entries.
      expect(ts.length).toBeLessThanOrEqual(4);
    }
  });

  it("counts a burst that lands inside the window after older entries age out", () => {
    const ts = [];
    // Seed 4 old restarts long ago — they should age out of the window.
    for (let i = 0; i < 4; i += 1) {
      registerRestartAndShouldAbort(ts, 1_000 + i, MAX, WINDOW);
    }
    // Jump past the window: the 4 old ones are trimmed on the next call.
    expect(registerRestartAndShouldAbort(ts, 200_000, MAX, WINDOW)).toBe(false);
    expect(ts).toEqual([200_000]);
    // A fresh burst of 6 within the new window aborts on the 6th.
    let aborted = false;
    for (let i = 0; i < 5; i += 1) {
      aborted = registerRestartAndShouldAbort(ts, 200_000 + i, MAX, WINDOW);
    }
    expect(aborted).toBe(true);
  });

  it("mutates the provided array in place (the supervisor owns one array)", () => {
    const ts = [];
    registerRestartAndShouldAbort(ts, 5_000, MAX, WINDOW);
    expect(ts).toEqual([5_000]);
  });
});
