/**
 * Unit coverage for the voice self-test timing helpers. Drives the real
 * module against the live monotonic clock; the clock-less fallback branch
 * hides the global `performance` binding for a single call and restores it.
 */
import { describe, expect, it } from "vitest";

import { now, sleep } from "./timing";

function withoutPerformance<T>(run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, "performance");
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: undefined,
  });
  try {
    return run();
  } finally {
    if (original) {
      Object.defineProperty(globalThis, "performance", original);
    } else {
      Reflect.deleteProperty(globalThis, "performance");
    }
  }
}

describe("now", () => {
  it("returns a finite non-negative timestamp", () => {
    const value = now();
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  });

  it("never moves backwards between successive reads (ties allowed)", () => {
    const first = now();
    const second = now();
    const third = now();
    expect(second).toBeGreaterThanOrEqual(first);
    expect(third).toBeGreaterThanOrEqual(second);
  });

  it("reads the live monotonic clock across an awaited delay", async () => {
    const before = now();
    await sleep(10);
    expect(now() - before).toBeGreaterThanOrEqual(10);
  });

  it("falls back to 0 when no high-resolution clock is exposed", () => {
    expect(withoutPerformance(() => now())).toBe(0);
  });
});

describe("sleep", () => {
  it("resolves with undefined after at least the requested delay", async () => {
    const start = now();
    const settled = await sleep(30);
    expect(settled).toBeUndefined();
    expect(now() - start).toBeGreaterThanOrEqual(30);
  });

  it("treats a zero delay as immediately schedulable", async () => {
    const start = now();
    await sleep(0);
    expect(now() - start).toBeGreaterThanOrEqual(0);
  });

  it("does not throw on negative delays", async () => {
    await expect(sleep(-5)).resolves.toBeUndefined();
  });

  it("lets concurrent sleeps settle independently by their own deadlines", async () => {
    let longSettled = false;
    const short = sleep(20);
    const long = sleep(80).then(() => {
      longSettled = true;
    });

    await short;
    // Timer callbacks never fire before their deadline and expire in deadline
    // order, so when the 20ms sleep resumes the 80ms continuation cannot have
    // run yet — even if the event loop stalls past both deadlines.
    expect(longSettled).toBe(false);

    await long;
    expect(longSettled).toBe(true);
  });
});
