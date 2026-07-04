/**
 * Unit tests for the ActivityProfile → OwnerFacts window learner
 * (issue #12186, task B1 / plan D.2.1).
 *
 * Covers the three contracts that make the observe→learn→schedule loop safe:
 *   1. mapping — observed wake/sleep hours → flexible morning/evening windows;
 *   2. override precedence — a user-set window is never clobbered by learning;
 *   3. idempotency — a second run over an unchanged rhythm writes nothing.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  createOwnerFactStore,
  registerOwnerFactStore,
} from "../lifeops/owner/fact-store.js";
import {
  deriveWindowsFromRhythm,
  resolveWindowPatch,
} from "./window-learning.js";
import { learnRhythmWindows } from "./window-learning-writer.js";

function makeCacheRuntime(): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    async getCache<T>(key: string): Promise<T | null> {
      const value = cache.get(key);
      return value === undefined ? null : (value as T);
    },
    async setCache<T>(key: string, value: T): Promise<boolean> {
      cache.set(key, value);
      return true;
    },
    async deleteCache(key: string): Promise<boolean> {
      return cache.delete(key);
    },
  } as unknown as IAgentRuntime;
}

function makeRuntimeWithStore(): IAgentRuntime {
  const runtime = makeCacheRuntime();
  registerOwnerFactStore(runtime, createOwnerFactStore(runtime));
  return runtime;
}

describe("deriveWindowsFromRhythm (pure mapping)", () => {
  it("maps a 07:00 wake / 23:00 sleep rhythm to flexible windows", () => {
    const windows = deriveWindowsFromRhythm({
      typicalWakeHour: 7,
      typicalSleepHour: 23,
    });
    expect(windows.morningWindow).toEqual({
      startLocal: "07:00",
      endLocal: "10:00",
    });
    expect(windows.eveningWindow).toEqual({
      startLocal: "21:00",
      endLocal: "23:00",
    });
  });

  it("maps a night-owl 14:00 wake / 04:00 sleep rhythm, wrapping past midnight", () => {
    const windows = deriveWindowsFromRhythm({
      typicalWakeHour: 14,
      typicalSleepHour: 28, // analyzer normalizes after-midnight to 24+h
    });
    expect(windows.morningWindow).toEqual({
      startLocal: "14:00",
      endLocal: "17:00",
    });
    // 28 wraps to 04:00; evening lead-in is 02:00.
    expect(windows.eveningWindow).toEqual({
      startLocal: "02:00",
      endLocal: "04:00",
    });
  });

  it("omits a window when the corresponding rhythm hour is unknown", () => {
    expect(
      deriveWindowsFromRhythm({ typicalWakeHour: null, typicalSleepHour: 23 }),
    ).toEqual({
      eveningWindow: { startLocal: "21:00", endLocal: "23:00" },
    });
    expect(
      deriveWindowsFromRhythm({
        typicalWakeHour: null,
        typicalSleepHour: null,
      }),
    ).toEqual({});
  });

  it("SKIPS an inverted morning window instead of emitting one the reader cannot satisfy", () => {
    // wake 22:00 → naive band [22:00, 01:00): start(22) > end(01) after wrap.
    // The plugin-scheduling during_window resolver matches
    // `atMinutes >= start && atMinutes < end` with NO wraparound for morning,
    // so an inverted band is UNSATISFIABLE and would permanently kill the
    // trigger. The learner must decline to emit it.
    const windows = deriveWindowsFromRhythm({
      typicalWakeHour: 22,
      typicalSleepHour: null,
    });
    expect(windows.morningWindow).toBeUndefined();
  });

  it("SKIPS an inverted evening window instead of emitting one the reader cannot satisfy", () => {
    // sleep 01:00 → naive band [23:00, 01:00): start(23) > end(01) after wrap.
    const windows = deriveWindowsFromRhythm({
      typicalWakeHour: null,
      typicalSleepHour: 1,
    });
    expect(windows.eveningWindow).toBeUndefined();
  });

  it("NEVER emits a window with startLocal >= endLocal for any hour 0..23", () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const windows = deriveWindowsFromRhythm({
        typicalWakeHour: hour,
        typicalSleepHour: hour,
      });
      for (const w of [windows.morningWindow, windows.eveningWindow]) {
        if (w) {
          const [sh] = w.startLocal.split(":").map(Number);
          const [eh] = w.endLocal.split(":").map(Number);
          expect(sh).toBeLessThan(eh);
        }
      }
    }
  });
});

describe("deriveWindowsFromRhythm (adaptive span from observed distribution)", () => {
  /** Width, in whole hours, of a same-day HH:00 window (end - start). */
  function widthHours(w?: { startLocal: string; endLocal: string }): number {
    if (!w) return Number.NaN;
    const [sh] = w.startLocal.split(":").map(Number);
    const [eh] = w.endLocal.split(":").map(Number);
    return (eh as number) - (sh as number);
  }

  // A TIGHT owner: wakes ~7 every day, winds down ~22 every day.
  const tight = {
    typicalWakeHour: 7,
    typicalSleepHour: 22,
    wakeHours: [7, 7, 7, 8, 7, 7],
    sleepHours: [22, 22, 21, 22, 22, 22],
  };
  // A WIDE owner: wake scattered 6..12, wind-down scattered 20..26(=02).
  const wide = {
    typicalWakeHour: 9,
    typicalSleepHour: 23,
    wakeHours: [6, 7, 9, 10, 12],
    sleepHours: [20, 22, 23, 24, 26],
  };

  it("narrows the morning span for a tight distribution vs a wide one", () => {
    const t = deriveWindowsFromRhythm(tight);
    const w = deriveWindowsFromRhythm(wide);
    expect(widthHours(t.morningWindow)).toBeLessThan(
      widthHours(w.morningWindow),
    );
    // Tight IQR≈0 clamps to the 1h floor; explicit 07:00–08:00.
    expect(t.morningWindow).toEqual({ startLocal: "07:00", endLocal: "08:00" });
    // Wide IQR = 3 → 09:00–12:00.
    expect(w.morningWindow).toEqual({ startLocal: "09:00", endLocal: "12:00" });
  });

  it("narrows the evening span for a tight distribution vs a wide one", () => {
    const t = deriveWindowsFromRhythm(tight);
    const w = deriveWindowsFromRhythm(wide);
    expect(widthHours(t.eveningWindow)).toBeLessThan(
      widthHours(w.eveningWindow),
    );
    expect(t.eveningWindow).toEqual({ startLocal: "21:00", endLocal: "22:00" });
    expect(w.eveningWindow).toEqual({ startLocal: "21:00", endLocal: "23:00" });
  });

  it("keeps every learned span inside [1,6] and every window non-inverted", () => {
    for (const sample of [tight, wide]) {
      const windows = deriveWindowsFromRhythm(sample);
      for (const win of [windows.morningWindow, windows.eveningWindow]) {
        const width = widthHours(win);
        expect(width).toBeGreaterThanOrEqual(1);
        expect(width).toBeLessThanOrEqual(6);
        // Non-inverted: end strictly after start (positive width).
        expect(width).toBeGreaterThan(0);
      }
    }
  });

  it("a tight learned morning span is strictly narrower than the fixed 3h fallback", () => {
    const t = deriveWindowsFromRhythm(tight);
    expect(widthHours(t.morningWindow)).toBe(1);
    expect(widthHours(t.morningWindow)).toBeLessThan(3);
  });

  it("still refuses a wrapping window even with a distribution present", () => {
    // wake 23:00, span clamps to ≥1h → band [23:00, 24:00) inverts to
    // start(23) >= end(00): unsatisfiable, must be declined.
    const windows = deriveWindowsFromRhythm({
      typicalWakeHour: 23,
      typicalSleepHour: null,
      wakeHours: [22, 23, 23, 24],
    });
    expect(windows.morningWindow).toBeUndefined();
  });

  it("falls back to the fixed 3h/2h spans when there are <2 samples", () => {
    // Single-sample distribution → no spread → fixed fallback (matches the
    // legacy no-array path exactly).
    const oneSample = deriveWindowsFromRhythm({
      typicalWakeHour: 7,
      typicalSleepHour: 23,
      wakeHours: [7],
      sleepHours: [23],
    });
    expect(oneSample.morningWindow).toEqual({
      startLocal: "07:00",
      endLocal: "10:00",
    });
    expect(oneSample.eveningWindow).toEqual({
      startLocal: "21:00",
      endLocal: "23:00",
    });
    // No arrays at all → identical fixed fallback.
    const noArrays = deriveWindowsFromRhythm({
      typicalWakeHour: 7,
      typicalSleepHour: 23,
    });
    expect(noArrays).toEqual(oneSample);
  });
});

describe("resolveWindowPatch (override + idempotency policy)", () => {
  it("writes both windows when facts are empty (default → learned)", () => {
    const patch = resolveWindowPatch(
      {},
      {
        morningWindow: { startLocal: "07:00", endLocal: "10:00" },
        eveningWindow: { startLocal: "21:00", endLocal: "23:00" },
      },
    );
    expect(patch).toEqual({
      morningWindow: { startLocal: "07:00", endLocal: "10:00" },
      eveningWindow: { startLocal: "21:00", endLocal: "23:00" },
    });
  });

  it("never clobbers a user-set (first_run / profile_save) window", () => {
    const patch = resolveWindowPatch(
      {
        morningWindow: {
          value: { startLocal: "05:00", endLocal: "08:00" },
          provenance: {
            source: "first_run",
            recordedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        eveningWindow: {
          value: { startLocal: "19:00", endLocal: "21:00" },
          provenance: {
            source: "profile_save",
            recordedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
      {
        morningWindow: { startLocal: "07:00", endLocal: "10:00" },
        eveningWindow: { startLocal: "21:00", endLocal: "23:00" },
      },
    );
    expect(patch).toBeNull();
  });

  it("updates a previously-learned (agent_inferred) window", () => {
    const patch = resolveWindowPatch(
      {
        morningWindow: {
          value: { startLocal: "06:00", endLocal: "09:00" },
          provenance: {
            source: "agent_inferred",
            recordedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
      { morningWindow: { startLocal: "07:00", endLocal: "10:00" } },
    );
    expect(patch).toEqual({
      morningWindow: { startLocal: "07:00", endLocal: "10:00" },
    });
  });

  it("returns null when the learned window already equals the stored value (idempotent)", () => {
    const patch = resolveWindowPatch(
      {
        morningWindow: {
          value: { startLocal: "07:00", endLocal: "10:00" },
          provenance: {
            source: "agent_inferred",
            recordedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
      { morningWindow: { startLocal: "07:00", endLocal: "10:00" } },
    );
    expect(patch).toBeNull();
  });
});

describe("learnRhythmWindows (writer, end-to-end via OwnerFactStore)", () => {
  const NOW = new Date("2026-05-10T12:00:00.000Z");

  it("writes learned windows into an empty store with agent_inferred provenance", async () => {
    const runtime = makeRuntimeWithStore();
    const result = await learnRhythmWindows(
      runtime,
      { typicalWakeHour: 7, typicalSleepHour: 23 },
      NOW,
    );
    expect(result).toEqual({
      wrote: true,
      updated: ["morningWindow", "eveningWindow"],
    });

    const facts = await createOwnerFactStore(runtime).read();
    expect(facts.morningWindow?.value).toEqual({
      startLocal: "07:00",
      endLocal: "10:00",
    });
    expect(facts.morningWindow?.provenance.source).toBe("agent_inferred");
    expect(facts.eveningWindow?.value).toEqual({
      startLocal: "21:00",
      endLocal: "23:00",
    });
  });

  it("is idempotent — a second run over the same rhythm writes nothing", async () => {
    const runtime = makeRuntimeWithStore();
    await learnRhythmWindows(
      runtime,
      { typicalWakeHour: 7, typicalSleepHour: 23 },
      NOW,
    );
    const second = await learnRhythmWindows(
      runtime,
      { typicalWakeHour: 7, typicalSleepHour: 23 },
      NOW,
    );
    expect(second).toEqual({ wrote: false, updated: [] });
  });

  it("respects an explicit user override — does not overwrite a first_run window", async () => {
    const runtime = makeRuntimeWithStore();
    const store = createOwnerFactStore(runtime);
    registerOwnerFactStore(runtime, store);
    await store.update(
      { morningWindow: { startLocal: "05:00", endLocal: "08:00" } },
      { source: "first_run", recordedAt: NOW.toISOString() },
    );

    const result = await learnRhythmWindows(
      runtime,
      { typicalWakeHour: 7, typicalSleepHour: 23 },
      NOW,
    );
    // Evening had no user override → learned; morning is user-owned → untouched.
    expect(result.updated).toEqual(["eveningWindow"]);
    const facts = await store.read();
    expect(facts.morningWindow?.value).toEqual({
      startLocal: "05:00",
      endLocal: "08:00",
    });
    expect(facts.morningWindow?.provenance.source).toBe("first_run");
    expect(facts.eveningWindow?.value).toEqual({
      startLocal: "21:00",
      endLocal: "23:00",
    });
  });
});
