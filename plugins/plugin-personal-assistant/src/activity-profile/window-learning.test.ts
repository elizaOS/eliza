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
