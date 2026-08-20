/**
 * Verifies virtual-time ordering, timer cancellation, interval stepping, sleep,
 * and runaway protection without using wall-clock delays.
 */
import { describe, expect, it } from "vitest";
import { VirtualClock } from "./clock.ts";

describe("VirtualClock", () => {
  it("runs timers deterministically in due-time and registration order", async () => {
    const clock = new VirtualClock("2030-01-01T00:00:00.000Z");
    const events: string[] = [];
    clock.setTimeout(() => {
      events.push("late");
    }, 20);
    clock.setTimeout(() => {
      events.push("first");
    }, 10);
    clock.setTimeout(() => {
      events.push("second");
    }, 10);
    expect(await clock.advanceBy(20)).toBe(3);
    expect(events).toEqual(["first", "second", "late"]);
    expect(clock.nowIso()).toBe("2030-01-01T00:00:00.020Z");
  });

  it("drives sleep and recurring work through explicit advancement", async () => {
    const clock = new VirtualClock("2030-01-01T00:00:00.000Z");
    let intervals = 0;
    const interval = clock.setInterval(() => {
      intervals += 1;
      if (intervals === 2) clock.clearTimeout(interval);
    }, 5);
    let slept = false;
    const sleeping = clock.sleep(7).then(() => {
      slept = true;
    });
    expect(await clock.step()).toBe(true);
    expect(intervals).toBe(1);
    await clock.advanceBy(2);
    await sleeping;
    expect(slept).toBe(true);
    await clock.advanceBy(3);
    expect(intervals).toBe(2);
    expect(clock.pendingTimerCount).toBe(0);
  });

  it("rejects backward time and invalid timers", async () => {
    const clock = new VirtualClock("2030-01-01T00:00:00.000Z");
    await expect(clock.advanceTo("2029-01-01T00:00:00.000Z")).rejects.toThrow(
      /cannot move backwards/,
    );
    expect(() => clock.setInterval(() => undefined, 0)).toThrow(/positive/);
  });
});
