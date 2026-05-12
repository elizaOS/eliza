/**
 * Consolidation-policy unit tests.
 *
 * Covers the AnchorConsolidationPolicy `merge` mode (multiple tasks
 * fire on the same anchor → one combined batch) and `sequential` /
 * `parallel` shapes.
 */

import { describe, expect, it } from "vitest";

import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "./consolidation-policy.js";
import type { ScheduledTask, ScheduledTaskPriority } from "./types.js";

const baseTask = (overrides: Partial<ScheduledTask> = {}): ScheduledTask => ({
  taskId: "t1",
  kind: "reminder",
  promptInstructions: "x",
  trigger: { kind: "manual" },
  priority: "medium",
  respectsGlobalPause: true,
  state: { status: "scheduled", followupCount: 0 },
  source: "default_pack",
  createdBy: "tests",
  ownerVisible: true,
  ...overrides,
});

describe("ConsolidationRegistry", () => {
  it("returns no policy and one-per-batch when nothing is registered", () => {
    const reg = createConsolidationRegistry();
    const tasks = [
      baseTask({ taskId: "a" }),
      baseTask({ taskId: "b" }),
      baseTask({ taskId: "c" }),
    ];
    const out = reg.consolidate("wake.confirmed", tasks);
    expect(out.policy).toBeNull();
    expect(out.batches).toHaveLength(3);
  });

  it("merge mode collapses concurrent fires into a single batch", () => {
    const reg = createConsolidationRegistry();
    reg.register({
      anchorKey: "wake.confirmed",
      mode: "merge",
      sortBy: "priority_desc",
    });
    const tasks: ScheduledTask[] = (
      ["low", "high", "medium"] as ScheduledTaskPriority[]
    ).map((priority, _i) => baseTask({ taskId: `t-${priority}`, priority }));
    void tasks; // silence unused if any
    const taskList: ScheduledTask[] = ["low", "high", "medium"].map((p, i) =>
      baseTask({
        taskId: `t-${p}-${i}`,
        priority: p as ScheduledTaskPriority,
      }),
    );
    const out = reg.consolidate("wake.confirmed", taskList);
    expect(out.policy?.mode).toBe("merge");
    expect(out.batches).toHaveLength(1);
    expect(out.batches[0]).toHaveLength(3);
    // priority_desc sort: high → medium → low
    expect(out.batches[0]?.map((t) => t.priority)).toEqual([
      "high",
      "medium",
      "low",
    ]);
  });

  it("merge mode honours maxBatchSize", () => {
    const reg = createConsolidationRegistry();
    reg.register({
      anchorKey: "wake.confirmed",
      mode: "merge",
      maxBatchSize: 2,
    });
    const out = reg.consolidate("wake.confirmed", [
      baseTask({ taskId: "a" }),
      baseTask({ taskId: "b" }),
      baseTask({ taskId: "c" }),
    ]);
    expect(out.batches).toHaveLength(2);
    expect(out.batches[0]).toHaveLength(2);
    expect(out.batches[1]).toHaveLength(1);
  });

  it("sequential / parallel modes produce one task per batch", () => {
    const reg = createConsolidationRegistry();
    reg.register({
      anchorKey: "bedtime.target",
      mode: "sequential",
      staggerMinutes: 5,
    });
    const out = reg.consolidate("bedtime.target", [
      baseTask({ taskId: "a" }),
      baseTask({ taskId: "b" }),
    ]);
    expect(out.batches).toHaveLength(2);
    expect(out.batches[0]).toHaveLength(1);
  });
});

describe("AnchorRegistry", () => {
  it("rejects duplicate registrations without `override`", () => {
    const reg = createAnchorRegistry();
    reg.register({
      anchorKey: "wake.confirmed",
      describe: { label: "test", provider: "tests" },
      resolve: () => ({ atIso: "2026-05-09T07:00:00.000Z" }),
    });
    expect(() =>
      reg.register({
        anchorKey: "wake.confirmed",
        describe: { label: "another", provider: "tests" },
        resolve: () => null,
      }),
    ).toThrow(/duplicate/);
  });

  it("allows override when explicitly opted in (real anchor replaces stub)", () => {
    const reg = createAnchorRegistry();
    reg.register({
      anchorKey: "wake.confirmed",
      describe: { label: "stub", provider: "tests" },
      resolve: () => ({ atIso: "2026-05-09T07:00:00.000Z" }),
    });
    reg.register(
      {
        anchorKey: "wake.confirmed",
        describe: { label: "real", provider: "plugin-health" },
        resolve: () => ({ atIso: "2026-05-09T07:30:00.000Z" }),
      },
      { override: true },
    );
    const got = reg.get("wake.confirmed");
    expect(got?.describe.label).toBe("real");
  });
});
