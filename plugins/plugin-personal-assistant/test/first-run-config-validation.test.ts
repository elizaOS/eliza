/**
 * Validates that the produced first-run scheduled-task pack is shape-valid
 * per the W1-A `ScheduledTask` contract: required fields are present, every
 * trigger.kind is in the registered set, every priority is in the registered
 * set, every `respectsGlobalPause` is set, every task has an `idempotencyKey`
 * (so replay upserts), and that the customize finalizer's channel-validation
 * fallback path produces an in_app channel + warning.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  createChannelRegistry,
  registerDefaultChannelPack,
} from "../src/lifeops/channels/index.ts";
import type { ConnectorContribution } from "../src/lifeops/connectors/contract.ts";
import {
  createConnectorRegistry,
  registerConnectorRegistry,
} from "../src/lifeops/connectors/registry.ts";
import { installFirstRunChannelInspector } from "../src/lifeops/first-run/channel-inspector.ts";
import { buildDefaultsPack } from "../src/lifeops/first-run/defaults.ts";
import {
  parseCategories,
  parseRelationships,
  parseTimeWindow,
  parseTimezone,
  setChannelInspector,
  validateChannel,
} from "../src/lifeops/first-run/questions.ts";
import { FirstRunService } from "../src/lifeops/first-run/service.ts";
import {
  createFirstRunStateStore,
  createOwnerFactStore,
} from "../src/lifeops/first-run/state.ts";
import type {
  ScheduledTask,
  ScheduledTaskInput,
} from "../src/lifeops/wave1-types.ts";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";

afterEach(() => setChannelInspector(null));

const VALID_TRIGGER_KINDS = new Set([
  "once",
  "cron",
  "interval",
  "relative_to_anchor",
  "during_window",
  "event",
  "manual",
  "after_task",
]);
const VALID_PRIORITIES = new Set(["low", "medium", "high"]);
const VALID_KINDS = new Set([
  "reminder",
  "checkin",
  "followup",
  "approval",
  "recap",
  "watcher",
  "output",
  "custom",
]);

/**
 * A runner that mirrors the production runner's idempotency contract: if a
 * task with the same `idempotencyKey` already exists in the live store it is
 * returned as-is (no duplicate). The store is a plain Map the test can delete
 * from to model the user removing a default. This is exactly the surface the
 * seeded-defaults marker must guard: the runner alone would happily re-create a
 * deleted default; the marker is what prevents it.
 */
function makeTrackingRunner(tasks: Map<string, ScheduledTask>) {
  let counter = 0;
  return {
    async schedule(input: ScheduledTaskInput): Promise<ScheduledTask> {
      if (input.idempotencyKey) {
        const existing = [...tasks.values()].find(
          (t) => t.idempotencyKey === input.idempotencyKey,
        );
        if (existing) return existing;
      }
      counter += 1;
      const task: ScheduledTask = {
        ...input,
        taskId: `track-${counter}`,
        state: { status: "scheduled", followupCount: 0 },
      };
      tasks.set(task.taskId, task);
      return task;
    },
  };
}

function asScheduledTask(input: ScheduledTaskInput): ScheduledTaskInput {
  expect(VALID_KINDS.has(input.kind)).toBe(true);
  expect(VALID_PRIORITIES.has(input.priority)).toBe(true);
  expect(VALID_TRIGGER_KINDS.has(input.trigger.kind)).toBe(true);
  expect(typeof input.respectsGlobalPause).toBe("boolean");
  expect(typeof input.idempotencyKey).toBe("string");
  expect(typeof input.promptInstructions).toBe("string");
  expect(input.promptInstructions.length).toBeGreaterThan(0);
  expect(input.source).toBe("first_run");
  return input;
}

function makeConnectedTelegramConnector(): ConnectorContribution {
  return {
    kind: "telegram",
    capabilities: ["telegram.send"],
    modes: ["local"],
    describe: { label: "Telegram" },
    async start() {},
    async disconnect() {},
    async verify() {
      return true;
    },
    async status() {
      return {
        state: "ok",
        observedAt: "2026-07-06T00:00:00.000Z",
      };
    },
  };
}

describe("first-run config validation", () => {
  it("buildDefaultsPack emits six shape-valid ScheduledTask inputs", () => {
    const pack = buildDefaultsPack({
      morningWindow: { startLocal: "06:30", endLocal: "11:30" },
      timezone: "America/Los_Angeles",
      agentId: "agent-1",
      channel: "in_app",
    });
    expect(pack.length).toBe(6);
    pack.forEach(asScheduledTask);
    // Specific slot assertions
    const slots = new Set(
      pack.map((p) => (p.metadata?.slot ?? null) as string | null),
    );
    expect(slots).toEqual(
      new Set([
        "gm",
        "gn",
        "checkin",
        "morningBrief",
        "weeklyReview",
        "localBackup",
      ]),
    );
    const checkin = pack.find((p) => p.metadata?.slot === "checkin");
    expect(checkin?.completionCheck?.kind).toBe("user_replied_within");
    const morningBrief = pack.find((p) => p.metadata?.slot === "morningBrief");
    expect(morningBrief?.trigger.kind).toBe("relative_to_anchor");
    if (morningBrief?.trigger.kind === "relative_to_anchor") {
      expect(morningBrief.trigger.anchorKey).toBe("wake.confirmed");
    }
    // The weekly-review starter ships PAUSED: a manual trigger means it exists
    // and is owner-visible but never fires on its own.
    const weeklyReview = pack.find((p) => p.metadata?.slot === "weeklyReview");
    expect(weeklyReview?.trigger.kind).toBe("manual");
    expect(weeklyReview?.metadata?.pausedByDefault).toBe(true);
    expect(weeklyReview?.ownerVisible).toBe(true);
    const localBackup = pack.find((p) => p.metadata?.slot === "localBackup");
    expect(localBackup?.kind).toBe("output");
    expect(localBackup?.trigger.kind).toBe("cron");
    if (localBackup?.trigger.kind === "cron") {
      expect(localBackup.trigger.expression).toBe("0 */6 * * *");
      expect(localBackup.trigger.tz).toBe("America/Los_Angeles");
    }
    expect(localBackup?.metadata?.systemOperation).toBe("agent.localBackup");
    expect(localBackup?.respectsGlobalPause).toBe(false);
    expect(localBackup?.executionProfile).toBe("bg-heavy-fgs");
  });

  it("parseTimezone / parseTimeWindow accept valid input and reject garbage", () => {
    expect(parseTimezone("America/New_York")).toBe("America/New_York");
    expect(parseTimezone("")).toBe(null);
    expect(parseTimeWindow({ startLocal: "06:00", endLocal: "11:00" })).toEqual(
      { startLocal: "06:00", endLocal: "11:00" },
    );
    expect(parseTimeWindow({ startLocal: "11:00", endLocal: "06:00" })).toBe(
      null,
    );
    expect(parseTimeWindow({ startLocal: "25:00", endLocal: "30:00" })).toBe(
      null,
    );
  });

  it("parseCategories filters to the allowed set", () => {
    expect(
      parseCategories([
        "sleep tracking",
        "ALIENS",
        "follow-ups",
        " inbox triage ",
      ]),
    ).toEqual(["sleep tracking", "follow-ups", "inbox triage"]);
  });

  it("parseRelationships shapes user input and bounds at 5 entries", () => {
    const result = parseRelationships(
      Array.from({ length: 8 }, (_, i) => ({
        name: `Person ${i}`,
        cadenceDays: i + 1,
      })),
    );
    expect(result?.length).toBe(5);
  });

  it("validateChannel falls back to in_app + warning for unconnected channels", async () => {
    const runtime = createMinimalRuntimeStub();
    const result = await validateChannel("telegram", runtime);
    expect(result.fallbackToInApp).toBe(true);
    expect(result.warning).toMatch(/fall back/i);
  });

  it("validateChannel passes a connected channel through cleanly", async () => {
    setChannelInspector({
      isRegistered: () => true,
      isConnected: () => true,
    });
    const runtime = createMinimalRuntimeStub();
    const result = await validateChannel("telegram", runtime);
    expect(result.fallbackToInApp).toBe(false);
    expect(result.warning).toBeUndefined();
    setChannelInspector(null);
  });

  it("validates a connected Telegram channel through the production registry inspector", async () => {
    const runtime = createMinimalRuntimeStub();
    const connectorRegistry = createConnectorRegistry();
    connectorRegistry.register(makeConnectedTelegramConnector());
    registerConnectorRegistry(runtime, connectorRegistry);

    const channelRegistry = createChannelRegistry();
    registerDefaultChannelPack(channelRegistry, runtime);
    installFirstRunChannelInspector(runtime, channelRegistry);

    await expect(validateChannel("telegram", runtime)).resolves.toEqual({
      channel: "telegram",
      registered: true,
      connected: true,
      fallbackToInApp: false,
    });
  });

  it("keeps production channel inspectors isolated per runtime", async () => {
    const connectedRuntime = createMinimalRuntimeStub();
    const connectorRegistry = createConnectorRegistry();
    connectorRegistry.register(makeConnectedTelegramConnector());
    registerConnectorRegistry(connectedRuntime, connectorRegistry);

    const connectedChannelRegistry = createChannelRegistry();
    registerDefaultChannelPack(connectedChannelRegistry, connectedRuntime);
    installFirstRunChannelInspector(connectedRuntime, connectedChannelRegistry);

    const disconnectedRuntime = createMinimalRuntimeStub();
    const disconnectedChannelRegistry = createChannelRegistry();
    registerDefaultChannelPack(
      disconnectedChannelRegistry,
      disconnectedRuntime,
    );
    installFirstRunChannelInspector(
      disconnectedRuntime,
      disconnectedChannelRegistry,
    );

    await expect(
      validateChannel("telegram", connectedRuntime),
    ).resolves.toEqual({
      channel: "telegram",
      registered: true,
      connected: true,
      fallbackToInApp: false,
    });
    await expect(
      validateChannel("telegram", disconnectedRuntime),
    ).resolves.toMatchObject({
      channel: "telegram",
      registered: true,
      connected: false,
      fallbackToInApp: true,
    });
  });

  it("rejects an unregistered channel with the right warning", async () => {
    const runtime = createMinimalRuntimeStub();
    const result = await validateChannel("morse_code", runtime);
    expect(result.channel).toBe("in_app");
    expect(result.fallbackToInApp).toBe(true);
    expect(result.warning).toMatch(/not registered/i);
  });

  it("seedDefaultPackOnBoot seeds on an already-initialized runtime that never ran first-run", async () => {
    const runtime = createMinimalRuntimeStub();
    const tasks = new Map<string, ScheduledTask>();
    const service = new FirstRunService(runtime, {
      runner: makeTrackingRunner(tasks),
    });

    // No first-run was ever performed (the lifecycle store is `pending`),
    // yet boot seeding still materializes the full default pack.
    const result = await service.seedDefaultPackOnBoot();
    expect(result.seeded.length).toBe(6);
    expect(result.skipped.length).toBe(0);
    expect(tasks.size).toBe(6);

    const slots = new Set(
      [...tasks.values()].map((t) => t.metadata?.slot as string),
    );
    expect(slots).toEqual(
      new Set([
        "gm",
        "gn",
        "checkin",
        "morningBrief",
        "weeklyReview",
        "localBackup",
      ]),
    );

    // The weekly-review starter stays paused (manual trigger, never fires
    // on its own).
    const weekly = [...tasks.values()].find(
      (t) => t.metadata?.slot === "weeklyReview",
    );
    expect(weekly?.trigger.kind).toBe("manual");
    expect(weekly?.metadata?.pausedByDefault).toBe(true);
  });

  it("seedDefaultPackOnBoot is idempotent across two boots — no duplicates", async () => {
    const runtime = createMinimalRuntimeStub();
    const tasks = new Map<string, ScheduledTask>();

    const first = await new FirstRunService(runtime, {
      runner: makeTrackingRunner(tasks),
    }).seedDefaultPackOnBoot();
    expect(first.seeded.length).toBe(6);

    // Second boot (fresh service instance, same persistent runtime cache):
    // every key is already in the seeded marker, so nothing is re-created.
    const second = await new FirstRunService(runtime, {
      runner: makeTrackingRunner(tasks),
    }).seedDefaultPackOnBoot();
    expect(second.seeded.length).toBe(0);
    expect(second.skipped.length).toBe(6);
    expect(tasks.size).toBe(6);
  });

  it("seedDefaultPackOnBoot respects user deletion — a deleted default is not recreated", async () => {
    const runtime = createMinimalRuntimeStub();
    const tasks = new Map<string, ScheduledTask>();

    await new FirstRunService(runtime, {
      runner: makeTrackingRunner(tasks),
    }).seedDefaultPackOnBoot();
    expect(tasks.size).toBe(6);

    // User deletes the weekly-review default out from under the runner.
    const weeklyKey = "lifeops:first-run:default:weekly-review";
    const weekly = [...tasks.values()].find(
      (t) => t.idempotencyKey === weeklyKey,
    );
    if (!weekly) throw new Error("expected weekly-review default to be seeded");
    tasks.delete(weekly.taskId);
    expect(tasks.size).toBe(5);

    // Next boot must NOT resurrect it — the seeded marker still records the
    // key, so the boot seeder skips it.
    const reboot = await new FirstRunService(runtime, {
      runner: makeTrackingRunner(tasks),
    }).seedDefaultPackOnBoot();
    expect(reboot.seeded.length).toBe(0);
    expect(reboot.skipped).toContain(weeklyKey);
    expect(tasks.size).toBe(5);
    expect(
      [...tasks.values()].some((t) => t.idempotencyKey === weeklyKey),
    ).toBe(false);
  });

  it("first-run then boot does not double-seed (shared per-key marker)", async () => {
    const runtime = createMinimalRuntimeStub();
    const tasks = new Map<string, ScheduledTask>();

    // Fresh install runs first-run defaults, which seeds the pack and records
    // the marker.
    const firstRun = new FirstRunService(runtime, {
      runner: makeTrackingRunner(tasks),
    });
    await firstRun.runDefaultsPath({ wakeTime: "6:30am" });
    expect(tasks.size).toBe(6);

    // A subsequent boot seeder sees every key already seeded → no double-seed.
    const boot = await new FirstRunService(runtime, {
      runner: makeTrackingRunner(tasks),
    }).seedDefaultPackOnBoot();
    expect(boot.seeded.length).toBe(0);
    expect(boot.skipped.length).toBe(6);
    expect(tasks.size).toBe(6);
  });

  it("FirstRunService produces shape-valid tasks via the in-memory runner", async () => {
    const runtime = createMinimalRuntimeStub();
    const stateStore = createFirstRunStateStore(runtime);
    const factStore = createOwnerFactStore(runtime);
    const recorded: ScheduledTask[] = [];
    const service = new FirstRunService(runtime, {
      stateStore,
      factStore,
      runner: {
        async schedule(input) {
          asScheduledTask(input);
          const task: ScheduledTask = {
            ...input,
            taskId: `t-${recorded.length}`,
            state: { status: "scheduled", followupCount: 0 },
          };
          recorded.push(task);
          return task;
        },
      },
    });

    // First call without a wake time returns the question.
    const ask = await service.runDefaultsPath({});
    expect(ask.status).toBe("needs_more_input");
    expect(ask.awaitingQuestion).toBe("wakeTime");

    const done = await service.runDefaultsPath({ wakeTime: "6:30am" });
    expect(done.status).toBe("ok");
    expect(done.scheduledTasks.length).toBe(6);
    expect(recorded.length).toBe(6);
    expect(done.facts.morningWindow?.startLocal).toBe("06:30");
  });
});
