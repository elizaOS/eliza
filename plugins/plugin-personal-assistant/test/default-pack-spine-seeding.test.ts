/**
 * Default-pack catalog → spine seed-registry integration (#10721 H1).
 *
 * The catalog (`getDefaultEnabledPacks`) seeds through
 * `@elizaos/plugin-scheduling`'s generic seed registry as PA's consumer pack.
 * These tests pin the three load-bearing properties:
 *
 *   1. Reconciliation — catalog records whose logical slot the first-run pack
 *      owns (gm / gn / check-in / morning-brief, plus health's keyless
 *      `wake-up` gm) never reach the spine registry, so the first-run keys
 *      stay the single instance of each logical item.
 *   2. Seed-once — the spine seeder materializes the catalog exactly once;
 *      a second boot seeds zero new records.
 *   3. No-double-GM — with BOTH old paths' inputs present (first-run defaults
 *      already seeded + the catalog registered), exactly one GM task exists.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  ActivitySignalBusView,
  GlobalPauseView,
  OwnerFactsView,
  SubjectStoreView,
} from "@elizaos/plugin-scheduling";
import {
  createAnchorRegistry,
  createCompletionCheckRegistry,
  createConsolidationRegistry,
  createEscalationLadderRegistry,
  createInMemoryScheduledTaskLogStore,
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  createTaskGateRegistry,
  getDefaultTaskPacks,
  registerBuiltInCompletionChecks,
  registerBuiltInGates,
  registerDefaultEscalationLadders,
  resolvePacksToSeed,
  seedRegisteredTaskPacks,
  TestNoopScheduledTaskDispatcher,
} from "@elizaos/plugin-scheduling";
import { describe, expect, it } from "vitest";
import {
  DAILY_RHYTHM_RECORD_IDS,
  MORNING_BRIEF_RECORD_IDS,
} from "../src/default-packs/index.ts";
import {
  buildDefaultPackCatalogTasks,
  FIRST_RUN_OWNED_PACK_KEYS,
  FIRST_RUN_OWNED_RECORD_KEYS,
  PA_DEFAULT_PACK_CATALOG_ID,
  registerDefaultPackCatalog,
} from "../src/default-packs/spine-registration.ts";
import { DEFAULT_PACK_IDEMPOTENCY_KEYS } from "../src/lifeops/first-run/defaults.ts";
import { FirstRunService } from "../src/lifeops/first-run/service.ts";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";

function makeRunner() {
  const ownerFacts: OwnerFactsView = { timezone: "UTC" };
  const pause: GlobalPauseView = { current: async () => ({ active: false }) };
  const activity: ActivitySignalBusView = { hasSignalSince: () => false };
  const subjectStore: SubjectStoreView = { wasUpdatedSince: () => false };

  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);

  let counter = 0;
  return createScheduledTaskRunner({
    agentId: "test-agent-catalog-seed",
    store: createInMemoryScheduledTaskStore(),
    logStore: createInMemoryScheduledTaskLogStore(),
    gates,
    completionChecks,
    ladders,
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: () => ownerFacts,
    globalPause: pause,
    activity,
    subjectStore,
    dispatcher: TestNoopScheduledTaskDispatcher,
    newTaskId: () => {
      counter += 1;
      return `catalog_${counter}`;
    },
  });
}

describe("default-pack catalog reconciliation", () => {
  it("excludes every first-run-owned logical record from the spine tasks", () => {
    const tasks = buildDefaultPackCatalogTasks();
    const keys = tasks.map((task) => task.idempotencyKey);

    for (const owned of FIRST_RUN_OWNED_RECORD_KEYS) {
      expect(keys).not.toContain(owned);
    }
    expect(keys).not.toContain(DAILY_RHYTHM_RECORD_IDS.gm);
    expect(keys).not.toContain(DAILY_RHYTHM_RECORD_IDS.gn);
    expect(keys).not.toContain(DAILY_RHYTHM_RECORD_IDS.checkin);
    expect(keys).not.toContain(MORNING_BRIEF_RECORD_IDS.brief);

    // Health's keyless wake-up gm is excluded at the pack level.
    expect(FIRST_RUN_OWNED_PACK_KEYS.has("wake-up")).toBe(true);
    for (const task of tasks) {
      expect(task.metadata?.defaultPackKey).not.toBe("wake-up");
    }
  });

  it("ships the never-before-seeded catalog records with unique keys and no inline pipelines", () => {
    const tasks = buildDefaultPackCatalogTasks();
    const keys = tasks.map((task) => task.idempotencyKey);

    // The default-enabled, capability-free catalog additions.
    expect(keys).toContain("default-pack:quiet-user-watcher:daily");
    expect(keys).toContain("default-pack:followup-starter:cadence-watcher");

    // Every record carries a key (seed-once + runner dedup both need it),
    // keys are unique, and nothing smuggles an inline pipeline the spine
    // ref type cannot carry.
    for (const task of tasks) {
      expect(typeof task.idempotencyKey).toBe("string");
      expect(task.idempotencyKey?.length).toBeGreaterThan(0);
      expect(task.pipeline).toBeUndefined();
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("capability-gated packs stay out without a connector registry", () => {
    const keys = buildDefaultPackCatalogTasks().map(
      (task) => task.idempotencyKey,
    );
    expect(keys).not.toContain("default-pack:inbox-triage-starter:daily");
    expect(
      keys.some((key) => key?.includes("inbox-triage")),
    ).toBe(false);
  });

  it("plugin init registers the catalog on the spine registry (production wiring)", () => {
    // The unit tests above call registerDefaultPackCatalog directly; this
    // pins the production caller so the catalog cannot silently regress to
    // the pre-#10721 state where getDefaultEnabledPacks had no caller.
    const pluginSource = readFileSync(
      fileURLToPath(new URL("../src/plugin.ts", import.meta.url)),
      "utf8",
    );
    expect(pluginSource).toContain("registerDefaultPackCatalog(runtime)");
    // Registration lives inside the scheduler-enabled init path, ordered
    // with the first-run boot seed that owns the gm/gn/check-in slots.
    const registerAt = pluginSource.indexOf(
      "registerDefaultPackCatalog(runtime)",
    );
    const firstRunSeedAt = pluginSource.indexOf("seedDefaultPackOnBoot");
    expect(registerAt).toBeGreaterThan(-1);
    expect(firstRunSeedAt).toBeGreaterThan(registerAt);
  });
});

describe("default-pack catalog spine seeding", () => {
  it("registers as a consumer (non-fallback) pack and seeds once through the runner", async () => {
    const runtime = createMinimalRuntimeStub();
    const runner = makeRunner();

    const pack = registerDefaultPackCatalog(runtime);
    expect(pack.id).toBe(PA_DEFAULT_PACK_CATALOG_ID);
    expect(pack.fallback).toBeUndefined();

    const registered = getDefaultTaskPacks(runtime);
    expect(registered.map((entry) => entry.id)).toContain(
      PA_DEFAULT_PACK_CATALOG_ID,
    );
    // A consumer pack registration drops any fallback pack from the seed set.
    expect(
      resolvePacksToSeed(registered).every((entry) => entry.fallback !== true),
    ).toBe(true);

    const first = await seedRegisteredTaskPacks(runtime, runner);
    expect(first.seeded.length).toBe(pack.tasks.length);
    expect(first.seeded.length).toBeGreaterThan(0);

    // Second boot: same registration, zero new records.
    registerDefaultPackCatalog(runtime);
    const second = await seedRegisteredTaskPacks(runtime, runner);
    expect(second.seeded).toHaveLength(0);
    expect(second.skipped.length).toBe(pack.tasks.length);

    const all = await runner.list();
    expect(all.length).toBe(pack.tasks.length);
  });

  it("no-double-GM: first-run defaults + catalog seeding yield exactly one GM task", async () => {
    const runtime = createMinimalRuntimeStub();
    const runner = makeRunner();

    // Old path 1: the first-run defaults pack (user answers the wake question).
    const firstRun = new FirstRunService(runtime, { runner });
    const result = await firstRun.runDefaultsPath({
      wakeTime: "7am",
      timezone: "UTC",
    });
    expect(result.status).toBe("ok");

    // Old path 2's replacement: the catalog registered on the spine registry.
    registerDefaultPackCatalog(runtime);
    await seedRegisteredTaskPacks(runtime, runner);

    const all = await runner.list();
    const gmTasks = all.filter(
      (task) =>
        task.idempotencyKey === DEFAULT_PACK_IDEMPOTENCY_KEYS.gm ||
        task.idempotencyKey === DAILY_RHYTHM_RECORD_IDS.gm ||
        task.metadata?.slot === "gm" ||
        task.metadata?.recordKey === "gm",
    );
    expect(gmTasks).toHaveLength(1);
    expect(gmTasks[0]?.idempotencyKey).toBe(DEFAULT_PACK_IDEMPOTENCY_KEYS.gm);

    const gnTasks = all.filter(
      (task) =>
        task.idempotencyKey === DEFAULT_PACK_IDEMPOTENCY_KEYS.gn ||
        task.idempotencyKey === DAILY_RHYTHM_RECORD_IDS.gn ||
        task.metadata?.slot === "gn" ||
        task.metadata?.recordKey === "gn",
    );
    expect(gnTasks).toHaveLength(1);
    expect(gnTasks[0]?.idempotencyKey).toBe(DEFAULT_PACK_IDEMPOTENCY_KEYS.gn);

    // The daily check-in + morning-brief slots are single too.
    const checkinKeys = all
      .map((task) => task.idempotencyKey)
      .filter(
        (key) =>
          key === DEFAULT_PACK_IDEMPOTENCY_KEYS.checkin ||
          key === DAILY_RHYTHM_RECORD_IDS.checkin,
      );
    expect(checkinKeys).toEqual([DEFAULT_PACK_IDEMPOTENCY_KEYS.checkin]);
    const briefKeys = all
      .map((task) => task.idempotencyKey)
      .filter(
        (key) =>
          key === DEFAULT_PACK_IDEMPOTENCY_KEYS.morningBrief ||
          key === MORNING_BRIEF_RECORD_IDS.brief,
      );
    expect(briefKeys).toEqual([DEFAULT_PACK_IDEMPOTENCY_KEYS.morningBrief]);
  });
});
