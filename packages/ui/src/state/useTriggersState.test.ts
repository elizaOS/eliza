/**
 * Verifies useTriggersState — trigger CRUD, run history, and health polling —
 * against a controlled ../api transport double: queue ordering, loud/silent
 * load semantics, upsert/prune merges, and error surfacing.
 */
// @vitest-environment jsdom

// Drives the real hook through renderHook and asserts observable state
// transitions. Only the transport boundary (../api client) is doubled, so the
// sorting, merging, flag lifecycle, and error mapping under test run for real.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TriggerHealthSnapshot,
  TriggerRunRecord,
  TriggerSummary,
} from "../api";

const getTriggers = vi.fn();
const getTriggerRuns = vi.fn();
const createTriggerFn = vi.fn();
const updateTriggerFn = vi.fn();
const deleteTriggerFn = vi.fn();
const runTriggerNowFn = vi.fn();
const getTriggerHealth = vi.fn();

vi.mock("../api", () => ({
  client: {
    getTriggers: (...args: unknown[]) => getTriggers(...args),
    getTriggerRuns: (...args: unknown[]) => getTriggerRuns(...args),
    createTrigger: (...args: unknown[]) => createTriggerFn(...args),
    updateTrigger: (...args: unknown[]) => updateTriggerFn(...args),
    deleteTrigger: (...args: unknown[]) => deleteTriggerFn(...args),
    runTriggerNow: (...args: unknown[]) => runTriggerNowFn(...args),
    getTriggerHealth: (...args: unknown[]) => getTriggerHealth(...args),
  },
}));

import { useTriggersState } from "./useTriggersState";

function triggerFixture(
  id: string,
  overrides: Partial<TriggerSummary> = {},
): TriggerSummary {
  return {
    id,
    taskId: `task-${id}`,
    displayName: `Trigger ${id}`,
    instructions: "Do the scheduled thing",
    triggerType: "interval",
    enabled: true,
    wakeMode: "inject_now",
    createdBy: "user-1",
    runCount: 0,
    ...overrides,
  };
}

function runRecordFixture(triggerId: string): TriggerRunRecord {
  return {
    triggerRunId: `${triggerId}-run-1`,
    triggerId,
    taskId: `task-${triggerId}`,
    startedAt: 1000,
    finishedAt: 1500,
    status: "success",
    latencyMs: 500,
    source: "scheduler",
  };
}

function healthSnapshot(): TriggerHealthSnapshot {
  return {
    triggersEnabled: true,
    activeTriggers: 1,
    disabledTriggers: 0,
    totalExecutions: 3,
    totalFailures: 0,
    totalSkipped: 0,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function loadTriggersOnce(
  result: { current: ReturnType<typeof useTriggersState> },
  payload: { triggers: TriggerSummary[] },
): Promise<void> {
  getTriggers.mockResolvedValueOnce(payload);
  await act(async () => {
    await result.current.loadTriggers();
  });
}

describe("useTriggersState", () => {
  beforeEach(() => {
    for (const mock of [
      getTriggers,
      getTriggerRuns,
      createTriggerFn,
      updateTriggerFn,
      deleteTriggerFn,
      runTriggerNowFn,
      getTriggerHealth,
    ]) {
      mock.mockReset();
    }
    // Defaults so fire-and-forget health refreshes and run-history loads in
    // CRUD flows never reject; individual tests override with Once variants.
    getTriggerHealth.mockResolvedValue(healthSnapshot());
    getTriggerRuns.mockResolvedValue({ runs: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("initial state", () => {
    it("starts idle with an empty queue, no history, and no errors", () => {
      const { result } = renderHook(() => useTriggersState());

      expect(result.current.state.triggers).toEqual([]);
      expect(result.current.state.triggersLoaded).toBe(false);
      expect(result.current.state.triggersLoading).toBe(false);
      expect(result.current.state.triggersSaving).toBe(false);
      expect(result.current.state.triggerRunsById).toEqual({});
      expect(result.current.state.triggerHealth).toBeNull();
      expect(result.current.state.triggerError).toBeNull();
    });
  });

  describe("loadTriggers ordering", () => {
    it("sorts ascending by nextRunAtMs and places never-scheduled triggers last", async () => {
      const { result } = renderHook(() => useTriggersState());

      await loadTriggersOnce(result, {
        triggers: [
          triggerFixture("unscheduled-a"),
          triggerFixture("late", { nextRunAtMs: 300 }),
          triggerFixture("early", { nextRunAtMs: 100 }),
          triggerFixture("unscheduled-b"),
        ],
      });

      expect(result.current.state.triggers.map((item) => item.id)).toEqual([
        "early",
        "late",
        "unscheduled-a",
        "unscheduled-b",
      ]);
      expect(result.current.state.triggerError).toBeNull();
      expect(result.current.state.triggersLoaded).toBe(true);
    });

    it("breaks ties on nextRunAtMs by displayName", async () => {
      const { result } = renderHook(() => useTriggersState());

      await loadTriggersOnce(result, {
        triggers: [
          triggerFixture("c", { displayName: "gamma", nextRunAtMs: 100 }),
          triggerFixture("a", { displayName: "alpha", nextRunAtMs: 100 }),
          triggerFixture("b", { displayName: "beta", nextRunAtMs: 100 }),
        ],
      });

      expect(
        result.current.state.triggers.map((item) => item.displayName),
      ).toEqual(["alpha", "beta", "gamma"]);
    });

    it("sorts into a copy and leaves the server-supplied array untouched", async () => {
      const serverPayload = [
        triggerFixture("unscheduled"),
        triggerFixture("later", { nextRunAtMs: 900 }),
      ];
      const { result } = renderHook(() => useTriggersState());

      await loadTriggersOnce(result, { triggers: serverPayload });

      expect(result.current.state.triggers.map((item) => item.id)).toEqual([
        "later",
        "unscheduled",
      ]);
      expect(serverPayload.map((item) => item.id)).toEqual([
        "unscheduled",
        "later",
      ]);
    });

    it("accepts an empty queue as a successful load", async () => {
      const { result } = renderHook(() => useTriggersState());

      await loadTriggersOnce(result, { triggers: [] });

      expect(result.current.state.triggers).toEqual([]);
      expect(result.current.state.triggersLoaded).toBe(true);
      expect(result.current.state.triggersLoading).toBe(false);
      expect(result.current.state.triggerError).toBeNull();
    });

    it("toggles the loading flag around a loud reload and swaps in fresh data", async () => {
      const { result } = renderHook(() => useTriggersState());
      await loadTriggersOnce(result, {
        triggers: [triggerFixture("stale", { nextRunAtMs: 100 })],
      });

      const gate = deferred<{ triggers: TriggerSummary[] }>();
      getTriggers.mockImplementationOnce(() => gate.promise);
      let flight: Promise<void>;
      act(() => {
        flight = result.current.loadTriggers();
      });
      expect(result.current.state.triggersLoading).toBe(true);

      await act(async () => {
        gate.resolve({
          triggers: [triggerFixture("fresh", { nextRunAtMs: 50 })],
        });
        await flight;
      });

      expect(result.current.state.triggersLoading).toBe(false);
      expect(result.current.state.triggers.map((item) => item.id)).toEqual([
        "fresh",
      ]);
      expect(result.current.state.triggerError).toBeNull();
    });

    it("drops stale triggers on a loud failure and falls back for non-Error rejections", async () => {
      const { result } = renderHook(() => useTriggersState());
      await loadTriggersOnce(result, {
        triggers: [triggerFixture("old", { nextRunAtMs: 100 })],
      });

      getTriggers.mockRejectedValueOnce("socket hang up");
      await act(async () => {
        await result.current.loadTriggers();
      });

      expect(result.current.state.triggers).toEqual([]);
      expect(result.current.state.triggerError).toBe("Failed to load triggers");
      expect(result.current.state.triggersLoaded).toBe(true);
      expect(result.current.state.triggersLoading).toBe(false);
    });

    it("keeps previously loaded triggers on a silent failure and surfaces the Error message", async () => {
      const { result } = renderHook(() => useTriggersState());
      await loadTriggersOnce(result, {
        triggers: [triggerFixture("kept", { nextRunAtMs: 100 })],
      });

      getTriggers.mockRejectedValueOnce(new Error("server 500"));
      await act(async () => {
        await result.current.loadTriggers({ silent: true });
      });

      expect(result.current.state.triggers.map((item) => item.id)).toEqual([
        "kept",
      ]);
      expect(result.current.state.triggerError).toBe("server 500");
      expect(result.current.state.triggersLoading).toBe(false);
    });
  });

  describe("ensureTriggersLoaded", () => {
    it("loads loudly the first time and silently once triggers are loaded", async () => {
      const { result } = renderHook(() => useTriggersState());

      // First call: nothing loaded yet, so the loud path shows loading=true.
      const firstGate = deferred<{ triggers: TriggerSummary[] }>();
      getTriggers.mockImplementationOnce(() => firstGate.promise);
      let firstFlight: Promise<void>;
      act(() => {
        firstFlight = result.current.ensureTriggersLoaded();
      });
      expect(result.current.state.triggersLoading).toBe(true);
      await act(async () => {
        firstGate.resolve({
          triggers: [triggerFixture("boot", { nextRunAtMs: 10 })],
        });
        await firstFlight;
      });
      expect(result.current.state.triggersLoaded).toBe(true);

      // Second call: already loaded, routed through the silent path.
      const secondGate = deferred<{ triggers: TriggerSummary[] }>();
      getTriggers.mockImplementationOnce(() => secondGate.promise);
      let secondFlight: Promise<void>;
      act(() => {
        secondFlight = result.current.ensureTriggersLoaded();
      });
      expect(result.current.state.triggersLoading).toBe(false);

      await act(async () => {
        secondGate.resolve({
          triggers: [triggerFixture("refreshed", { nextRunAtMs: 5 })],
        });
        await secondFlight;
      });
      expect(result.current.state.triggers.map((item) => item.id)).toEqual([
        "refreshed",
      ]);
    });
  });

  describe("loadTriggerRuns", () => {
    it("stores run history per trigger without clobbering other entries", async () => {
      const { result } = renderHook(() => useTriggersState());
      const runsForT1 = [runRecordFixture("t1")];
      const runsForT2 = [runRecordFixture("t2")];

      getTriggerRuns.mockResolvedValueOnce({ runs: runsForT1 });
      await act(async () => {
        await result.current.loadTriggerRuns("t1");
      });
      getTriggerRuns.mockResolvedValueOnce({ runs: runsForT2 });
      await act(async () => {
        await result.current.loadTriggerRuns("t2");
      });

      expect(Object.keys(result.current.state.triggerRunsById)).toEqual([
        "t1",
        "t2",
      ]);
      expect(result.current.state.triggerRunsById.t1).toEqual(runsForT1);
      expect(result.current.state.triggerRunsById.t2).toEqual(runsForT2);
      expect(result.current.state.triggerError).toBeNull();
    });

    it("surfaces Error messages verbatim", async () => {
      const { result } = renderHook(() => useTriggersState());

      getTriggerRuns.mockRejectedValueOnce(new Error("runs offline"));
      await act(async () => {
        await result.current.loadTriggerRuns("t1");
      });

      expect(result.current.state.triggerError).toBe("runs offline");
      expect(result.current.state.triggerRunsById).toEqual({});
    });

    it("falls back to a generic message for non-Error rejections", async () => {
      const { result } = renderHook(() => useTriggersState());

      getTriggerRuns.mockRejectedValueOnce(42);
      await act(async () => {
        await result.current.loadTriggerRuns("t1");
      });

      expect(result.current.state.triggerError).toBe(
        "Failed to load trigger runs",
      );
    });
  });

  describe("createTrigger", () => {
    it("inserts the created trigger in sorted position and refreshes health", async () => {
      const { result } = renderHook(() => useTriggersState());
      await loadTriggersOnce(result, {
        triggers: [triggerFixture("existing", { nextRunAtMs: 100 })],
      });
      getTriggerHealth.mockClear();

      const created = triggerFixture("sooner", {
        displayName: "Sooner",
        nextRunAtMs: 50,
      });
      createTriggerFn.mockResolvedValueOnce({ trigger: created });

      let returned: TriggerSummary | null = null;
      await act(async () => {
        returned = await result.current.createTrigger({ intervalMs: 60000 });
      });

      expect(returned).toEqual(created);
      expect(result.current.state.triggers.map((item) => item.id)).toEqual([
        "sooner",
        "existing",
      ]);
      expect(result.current.state.triggersSaving).toBe(false);
      expect(getTriggerHealth).toHaveBeenCalledTimes(1);
      expect(result.current.state.triggerError).toBeNull();
    });

    it("replaces a stale entry carrying the same id instead of duplicating it", async () => {
      const { result } = renderHook(() => useTriggersState());
      await loadTriggersOnce(result, {
        triggers: [
          triggerFixture("other", { nextRunAtMs: 100 }),
          triggerFixture("dup", { nextRunAtMs: 999 }),
        ],
      });

      const replacement = triggerFixture("dup", { nextRunAtMs: 10 });
      createTriggerFn.mockResolvedValueOnce({ trigger: replacement });

      await act(async () => {
        await result.current.createTrigger({});
      });

      const duplicates = result.current.state.triggers.filter(
        (item) => item.id === "dup",
      );
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0].nextRunAtMs).toBe(10);
      expect(result.current.state.triggers.map((item) => item.id)).toEqual([
        "dup",
        "other",
      ]);
    });

    it("returns null and records the Error message on failure", async () => {
      const { result } = renderHook(() => useTriggersState());

      createTriggerFn.mockRejectedValueOnce(new Error("quota exceeded"));
      let returned: TriggerSummary | null = null;
      await act(async () => {
        returned = await result.current.createTrigger({});
      });

      expect(returned).toBeNull();
      expect(result.current.state.triggerError).toBe("quota exceeded");
      expect(result.current.state.triggersSaving).toBe(false);
    });

    it("falls back to a generic message for non-Error rejections", async () => {
      const { result } = renderHook(() => useTriggersState());

      createTriggerFn.mockRejectedValueOnce("nope");
      let returned: TriggerSummary | null = null;
      await act(async () => {
        returned = await result.current.createTrigger({});
      });

      expect(returned).toBeNull();
      expect(result.current.state.triggerError).toBe(
        "Failed to create trigger",
      );
    });
  });

  describe("updateTrigger", () => {
    it("swaps the updated record in place and re-sorts the queue", async () => {
      const { result } = renderHook(() => useTriggersState());
      await loadTriggersOnce(result, {
        triggers: [
          triggerFixture("a", { nextRunAtMs: 100 }),
          triggerFixture("b", { nextRunAtMs: 200 }),
        ],
      });

      const updated = triggerFixture("b", {
        displayName: "B moved up",
        nextRunAtMs: 10,
      });
      updateTriggerFn.mockResolvedValueOnce({ trigger: updated });

      let returned: TriggerSummary | null = null;
      await act(async () => {
        returned = await result.current.updateTrigger("b", {
          intervalMs: 120000,
        });
      });

      expect(returned).toEqual(updated);
      expect(result.current.state.triggers.map((item) => item.id)).toEqual([
        "b",
        "a",
      ]);
      expect(result.current.state.triggersSaving).toBe(false);
      expect(result.current.state.triggerError).toBeNull();
    });

    it("returns null and records the Error message on failure", async () => {
      const { result } = renderHook(() => useTriggersState());

      updateTriggerFn.mockRejectedValueOnce(new Error("read-only"));
      let returned: TriggerSummary | null = null;
      await act(async () => {
        returned = await result.current.updateTrigger("b", {});
      });

      expect(returned).toBeNull();
      expect(result.current.state.triggerError).toBe("read-only");
      expect(result.current.state.triggersSaving).toBe(false);
    });
  });

  describe("deleteTrigger", () => {
    it("removes the trigger and prunes only its own run history", async () => {
      const { result } = renderHook(() => useTriggersState());
      await loadTriggersOnce(result, {
        triggers: [
          triggerFixture("t1", { nextRunAtMs: 100 }),
          triggerFixture("t2", { nextRunAtMs: 200 }),
        ],
      });
      getTriggerRuns.mockResolvedValueOnce({ runs: [runRecordFixture("t1")] });
      await act(async () => {
        await result.current.loadTriggerRuns("t1");
      });
      getTriggerRuns.mockResolvedValueOnce({ runs: [runRecordFixture("t2")] });
      await act(async () => {
        await result.current.loadTriggerRuns("t2");
      });
      getTriggerHealth.mockClear();

      deleteTriggerFn.mockResolvedValueOnce({ ok: true });
      let returned = false;
      await act(async () => {
        returned = await result.current.deleteTrigger("t1");
      });

      expect(returned).toBe(true);
      expect(result.current.state.triggers.map((item) => item.id)).toEqual([
        "t2",
      ]);
      expect(Object.keys(result.current.state.triggerRunsById)).toEqual(["t2"]);
      expect(getTriggerHealth).toHaveBeenCalledTimes(1);
      expect(result.current.state.triggerError).toBeNull();
      expect(result.current.state.triggersSaving).toBe(false);
    });

    it("keeps local data intact, reports the error, and returns false on failure", async () => {
      const { result } = renderHook(() => useTriggersState());
      await loadTriggersOnce(result, {
        triggers: [triggerFixture("survivor", { nextRunAtMs: 100 })],
      });

      deleteTriggerFn.mockRejectedValueOnce("denied");
      let returned = false;
      await act(async () => {
        returned = await result.current.deleteTrigger("survivor");
      });

      expect(returned).toBe(false);
      expect(result.current.state.triggers.map((item) => item.id)).toEqual([
        "survivor",
      ]);
      expect(result.current.state.triggerError).toBe(
        "Failed to delete trigger",
      );
      expect(result.current.state.triggersSaving).toBe(false);
    });
  });

  describe("runTriggerNow", () => {
    it("replaces an existing entry in place and re-sorts after a manual run", async () => {
      const { result } = renderHook(() => useTriggersState());
      await loadTriggersOnce(result, {
        triggers: [
          triggerFixture("a", { nextRunAtMs: 100 }),
          triggerFixture("b", { nextRunAtMs: 200 }),
        ],
      });
      getTriggerHealth.mockClear();

      const ranAgain = triggerFixture("b", {
        displayName: "B ran now",
        nextRunAtMs: 40,
        runCount: 1,
      });
      runTriggerNowFn.mockResolvedValueOnce({
        ok: true,
        result: { status: "success", taskDeleted: false },
        trigger: ranAgain,
      });

      let returned = false;
      await act(async () => {
        returned = await result.current.runTriggerNow("b");
      });

      expect(returned).toBe(true);
      expect(result.current.state.triggers.map((item) => item.id)).toEqual([
        "b",
        "a",
      ]);
      expect(result.current.state.triggers[0].displayName).toBe("B ran now");
      expect(getTriggerHealth).toHaveBeenCalledTimes(1);
      expect(result.current.state.triggerError).toBeNull();
      expect(result.current.state.triggersSaving).toBe(false);
    });

    it("appends a trigger unknown to the local list from the run response", async () => {
      const { result } = renderHook(() => useTriggersState());
      await loadTriggersOnce(result, {
        triggers: [triggerFixture("known", { nextRunAtMs: 100 })],
      });

      const appended = triggerFixture("brand-new", { nextRunAtMs: 20 });
      runTriggerNowFn.mockResolvedValueOnce({
        ok: true,
        result: { status: "success", taskDeleted: false },
        trigger: appended,
      });

      await act(async () => {
        await result.current.runTriggerNow("brand-new");
      });

      expect(result.current.state.triggers.map((item) => item.id)).toEqual([
        "brand-new",
        "known",
      ]);
    });

    it("refetches the whole list when the run response carries no trigger", async () => {
      const { result } = renderHook(() => useTriggersState());
      await loadTriggersOnce(result, {
        triggers: [triggerFixture("doomed", { nextRunAtMs: 100 })],
      });

      runTriggerNowFn.mockResolvedValueOnce({
        ok: true,
        result: { status: "skipped", taskDeleted: true },
      });
      getTriggers.mockResolvedValueOnce({
        triggers: [triggerFixture("remaining", { nextRunAtMs: 70 })],
      });

      let returned = false;
      await act(async () => {
        returned = await result.current.runTriggerNow("doomed");
      });

      expect(returned).toBe(true);
      expect(getTriggers).toHaveBeenCalledTimes(2);
      expect(result.current.state.triggers.map((item) => item.id)).toEqual([
        "remaining",
      ]);
    });

    it("returns false and records the Error message when the run request fails", async () => {
      const { result } = renderHook(() => useTriggersState());

      runTriggerNowFn.mockRejectedValueOnce(new Error("runner offline"));
      let returned = false;
      await act(async () => {
        returned = await result.current.runTriggerNow("t1");
      });

      expect(returned).toBe(false);
      expect(result.current.state.triggerError).toBe("runner offline");
      expect(result.current.state.triggersSaving).toBe(false);
    });
  });
});
