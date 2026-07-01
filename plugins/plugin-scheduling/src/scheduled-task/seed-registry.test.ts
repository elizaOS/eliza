/**
 * Unit tests for the generic default-task seed registry + the built-in fallback
 * pack behaviour.
 *
 * Covers:
 *  - the fallback pack seeds when NO consumer (non-fallback) pack is registered
 *    (a stock mobile boot) → "Good morning" (running) + "Weekly review" (paused)
 *  - the fallback pack does NOT seed when a consumer pack IS registered
 *    (desktop/cloud with @elizaos/plugin-personal-assistant) → no double-seed
 *  - `resolvePacksToSeed` drops fallback packs whenever any consumer pack exists
 *  - seed-once: a key seeded on a prior boot is skipped (deleted defaults are
 *    not resurrected)
 *  - the fallback pack contents (running cron gm + paused manual weekly-review)
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "./completion-check-registry.js";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "./consolidation-policy.js";
import {
  buildFallbackDefaultPack,
  FALLBACK_DEFAULT_PACK_IDEMPOTENCY_KEYS,
} from "./default-pack.js";
import {
  createEscalationLadderRegistry,
  registerDefaultEscalationLadders,
} from "./escalation.js";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "./gate-registry.js";
import {
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  type ScheduledTaskRunnerHandle,
  TestNoopScheduledTaskDispatcher,
} from "./runner.js";
import {
  type DefaultTaskPack,
  registerDefaultTaskPack,
  resolvePacksToSeed,
  seedRegisteredTaskPacks,
} from "./seed-registry.js";
import { createInMemoryScheduledTaskLogStore } from "./state-log.js";
import type { GlobalPauseView, ScheduledTaskInput } from "./types.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function makeRuntime(): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: "test-agent",
    async getCache<T>(key: string): Promise<T | undefined> {
      return cache.get(key) as T | undefined;
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

function makeRunner(): ScheduledTaskRunnerHandle {
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);
  let counter = 0;
  return createScheduledTaskRunner({
    agentId: "test-agent",
    store: createInMemoryScheduledTaskStore(),
    logStore: createInMemoryScheduledTaskLogStore(),
    gates,
    completionChecks,
    ladders,
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: () => ({}),
    globalPause: {
      current: async () => ({ active: false }),
    } as GlobalPauseView,
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
    dispatcher: TestNoopScheduledTaskDispatcher,
    newTaskId: () => {
      counter += 1;
      return `task_${counter}`;
    },
    now: () => new Date("2026-05-09T12:00:00.000Z"),
  });
}

const consumerPack = (
  overrides?: Partial<DefaultTaskPack>,
): DefaultTaskPack => {
  const task: ScheduledTaskInput = {
    kind: "reminder",
    promptInstructions: "consumer reminder",
    trigger: { kind: "cron", expression: "0 9 * * *", tz: "UTC" },
    priority: "medium",
    respectsGlobalPause: true,
    source: "first_run",
    createdBy: "test-agent",
    ownerVisible: true,
    idempotencyKey: "consumer:gm",
  };
  return { id: "consumer-pack", tasks: [task], ...overrides };
};

// ---------------------------------------------------------------------------
// resolvePacksToSeed — the consumer-vs-fallback gate
// ---------------------------------------------------------------------------

describe("resolvePacksToSeed", () => {
  it("returns fallback packs when only fallback packs are registered", () => {
    const fallback = buildFallbackDefaultPack({ agentId: "a" });
    expect(resolvePacksToSeed([fallback])).toEqual([fallback]);
  });

  it("drops fallback packs when any consumer (non-fallback) pack exists", () => {
    const fallback = buildFallbackDefaultPack({ agentId: "a" });
    const consumer = consumerPack();
    const resolved = resolvePacksToSeed([fallback, consumer]);
    expect(resolved).toEqual([consumer]);
  });

  it("returns consumer packs unchanged when no fallback is present", () => {
    const consumer = consumerPack();
    expect(resolvePacksToSeed([consumer])).toEqual([consumer]);
  });
});

// ---------------------------------------------------------------------------
// seedRegisteredTaskPacks — the boot seeder
// ---------------------------------------------------------------------------

describe("seedRegisteredTaskPacks with the built-in fallback pack", () => {
  it("seeds the fallback pack when no consumer pack is registered (mobile boot)", async () => {
    const runtime = makeRuntime();
    const runner = makeRunner();
    registerDefaultTaskPack(
      runtime,
      buildFallbackDefaultPack({ agentId: runtime.agentId }),
    );

    const { seeded } = await seedRegisteredTaskPacks(runtime, runner);
    expect(seeded).toHaveLength(2);

    const tasks = await runner.list({});
    const gm = tasks.find(
      (t) =>
        t.idempotencyKey === FALLBACK_DEFAULT_PACK_IDEMPOTENCY_KEYS.goodMorning,
    );
    const weekly = tasks.find(
      (t) =>
        t.idempotencyKey ===
        FALLBACK_DEFAULT_PACK_IDEMPOTENCY_KEYS.weeklyReview,
    );

    // Good morning ships RUNNING (daily cron) and owner-visible.
    expect(gm).toBeDefined();
    expect(gm?.trigger.kind).toBe("cron");
    expect(gm?.ownerVisible).toBe(true);
    expect(gm?.metadata?.recordKey).toBe("gm");

    // Weekly review ships PAUSED (manual trigger = never fires on its own).
    expect(weekly).toBeDefined();
    expect(weekly?.trigger.kind).toBe("manual");
    expect(weekly?.ownerVisible).toBe(true);
    expect(weekly?.metadata?.recordKey).toBe("weekly-review");
    expect(weekly?.metadata?.pausedByDefault).toBe(true);
  });

  it("does NOT seed the fallback pack when a consumer pack is registered (no double-seed)", async () => {
    const runtime = makeRuntime();
    const runner = makeRunner();
    // Both packs registered (e.g. spine fallback + a consumer host's pack).
    registerDefaultTaskPack(
      runtime,
      buildFallbackDefaultPack({ agentId: runtime.agentId }),
    );
    registerDefaultTaskPack(runtime, consumerPack());

    const { seeded } = await seedRegisteredTaskPacks(runtime, runner);

    // Only the consumer task seeds; neither fallback key is present.
    expect(seeded).toHaveLength(1);
    const tasks = await runner.list({});
    const keys = tasks.map((t) => t.idempotencyKey);
    expect(keys).toContain("consumer:gm");
    expect(keys).not.toContain(
      FALLBACK_DEFAULT_PACK_IDEMPOTENCY_KEYS.goodMorning,
    );
    expect(keys).not.toContain(
      FALLBACK_DEFAULT_PACK_IDEMPOTENCY_KEYS.weeklyReview,
    );
  });

  it("seeds the fallback pack once, then skips already-seeded keys on the next boot", async () => {
    const runtime = makeRuntime();

    // First boot: fresh runner, fallback seeds both tasks + records markers.
    const firstRunner = makeRunner();
    registerDefaultTaskPack(
      runtime,
      buildFallbackDefaultPack({ agentId: runtime.agentId }),
    );
    const first = await seedRegisteredTaskPacks(runtime, firstRunner);
    expect(first.seeded).toHaveLength(2);
    expect(first.skipped).toHaveLength(0);

    // Second boot: a new (empty) runner — but the same runtime cache holds the
    // seed-once markers, so nothing is re-created (a deleted default stays
    // deleted).
    const secondRunner = makeRunner();
    const second = await seedRegisteredTaskPacks(runtime, secondRunner);
    expect(second.seeded).toHaveLength(0);
    expect(second.skipped).toEqual(
      expect.arrayContaining([
        FALLBACK_DEFAULT_PACK_IDEMPOTENCY_KEYS.goodMorning,
        FALLBACK_DEFAULT_PACK_IDEMPOTENCY_KEYS.weeklyReview,
      ]),
    );
    expect(await secondRunner.list({})).toHaveLength(0);
  });
});
