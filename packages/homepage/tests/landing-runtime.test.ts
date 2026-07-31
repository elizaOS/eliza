/**
 * Runtime contracts for localized flags and deferred, fixed-rate homepage work.
 */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createCountryOptions, getCountryFlagPath } from "../src/lib/countries";
import { scheduleWhenIdle } from "../src/lib/deferred-render";
import {
  AMBIENT_FRAME_INTERVAL_MS,
  startFixedRateInvalidation,
} from "../src/lib/fixed-rate-invalidation";

test("country metadata follows the active locale and uses local SVG artwork", () => {
  const spanish = createCountryOptions("es");
  const unitedStates = spanish.find((country) => country.code === "US");

  expect(unitedStates?.name).toBe("Estados Unidos");
  expect(unitedStates?.dialCode).toBe("1");
  expect(getCountryFlagPath("us")).toBe("/country-flags/US.svg");
  expect(getCountryFlagPath("USA")).toBeNull();

  for (const country of spanish) {
    expect(
      existsSync(
        new URL(`../public/country-flags/${country.code}.svg`, import.meta.url),
      ),
    ).toBeTrue();
  }
});

test("ambient invalidation uses one 30 Hz timer independent of display RAF", () => {
  let callback: (() => void) | undefined;
  let cleared = 0;
  const delays: number[] = [];
  let invalidations = 0;
  const scheduler = {
    setInterval(next: () => void, delay: number) {
      callback = next;
      delays.push(delay);
      return 42;
    },
    clearInterval(handle: number) {
      cleared = handle;
    },
  };

  const stop = startFixedRateInvalidation(() => invalidations++, scheduler);
  expect(invalidations).toBe(1);
  expect(delays).toEqual([AMBIENT_FRAME_INTERVAL_MS]);

  callback?.();
  callback?.();
  expect(invalidations).toBe(3);

  stop();
  expect(cleared).toBe(42);
});

test("deferred rendering waits for idle and cancellation prevents mounting", () => {
  let idleCallback: (() => void) | undefined;
  let cancelled = 0;
  let mounted = 0;
  const scheduler = {
    requestIdleCallback(callback: () => void) {
      idleCallback = callback;
      return 17;
    },
    cancelIdleCallback(handle: number) {
      cancelled = handle;
    },
    setTimeout() {
      throw new Error("idle callback should be preferred");
    },
    clearTimeout() {
      throw new Error("idle callback should be preferred");
    },
  };

  const cancel = scheduleWhenIdle(() => mounted++, scheduler);
  expect(mounted).toBe(0);
  cancel();
  expect(cancelled).toBe(17);

  idleCallback?.();
  expect(mounted).toBe(0);
});

test("deferred rendering has a bounded non-idle fallback", () => {
  let timeoutCallback: (() => void) | undefined;
  let delay = 0;
  const scheduler = {
    setTimeout(callback: () => void, nextDelay: number) {
      timeoutCallback = callback;
      delay = nextDelay;
      return 9;
    },
    clearTimeout() {},
  };

  scheduleWhenIdle(() => {}, scheduler, 1_500);
  expect(delay).toBe(500);
  expect(timeoutCallback).toBeFunction();
});
