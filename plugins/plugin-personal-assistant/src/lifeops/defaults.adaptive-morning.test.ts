/**
 * Pins the adaptive morning window against inversion for late wakers: a wake
 * source at or past the 14:00 end cap must yield a shortened-but-real morning
 * window, never one that normalizeWindowPolicy would silently discard (which
 * materialized zero occurrences for morning-routine definitions, #21938).
 * Deterministic — computeAdaptiveWindowPolicy is a pure function.
 */
import { describe, expect, it } from "vitest";

import { computeAdaptiveWindowPolicy, normalizeWindowPolicy } from "./defaults";

function morningWindow(policy: ReturnType<typeof computeAdaptiveWindowPolicy>) {
  const window = policy.windows.find((w) => w.name === "morning");
  if (!window) throw new Error("expected a morning window");
  return window;
}

describe("computeAdaptiveWindowPolicy morning inversion guard", () => {
  it("keeps a real morning window for a 15:00 waker instead of inverting it", () => {
    const policy = computeAdaptiveWindowPolicy({
      typicalWakeHour: 15,
      typicalFirstActiveHour: null,
      typicalLastActiveHour: null,
      typicalSleepHour: null,
    });
    const morning = morningWindow(policy);
    expect(morning.endMinute).toBeGreaterThan(morning.startMinute);
    expect(morning.endMinute - morning.startMinute).toBeGreaterThanOrEqual(60);
  });

  it("keeps a real morning window at the exact 14:30 zero-width boundary", () => {
    const policy = computeAdaptiveWindowPolicy({
      typicalWakeHour: 14.5,
      typicalFirstActiveHour: null,
      typicalLastActiveHour: null,
      typicalSleepHour: null,
    });
    const morning = morningWindow(policy);
    expect(morning.endMinute).toBeGreaterThan(morning.startMinute);
  });

  it("survives normalizeWindowPolicy for every wake hour from 4:00 to 27:00", () => {
    for (let wake = 4; wake <= 27; wake += 0.5) {
      const policy = computeAdaptiveWindowPolicy({
        typicalWakeHour: wake,
        typicalFirstActiveHour: null,
        typicalLastActiveHour: null,
        typicalSleepHour: null,
      });
      const normalized = normalizeWindowPolicy(policy);
      const morning = normalized?.windows.find((w) => w.name === "morning");
      expect(morning, `wake=${wake} must keep a morning window`).toBeDefined();
    }
  });

  it("leaves ordinary wake hours unchanged", () => {
    const policy = computeAdaptiveWindowPolicy({
      typicalWakeHour: 7,
      typicalFirstActiveHour: null,
      typicalLastActiveHour: null,
      typicalSleepHour: null,
    });
    const morning = morningWindow(policy);
    expect(morning.startMinute).toBe(Math.round((7 - 0.5) * 60));
    expect(morning.endMinute).toBe(Math.round((7 - 0.5) * 60) + 5 * 60);
  });
});
