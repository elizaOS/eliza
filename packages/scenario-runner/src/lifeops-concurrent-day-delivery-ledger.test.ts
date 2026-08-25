/**
 * Pins the delivery ledger of the `deterministic-lifeops-concurrent-day`
 * scenario to the NOTIFICATION service its production dispatcher writes to.
 *
 * The scenario runtime always owns that service slot (core's
 * `NotificationService`, registered by the `eliza` plugin), so a scenario
 * cannot observe scheduled-task delivery through a capture service of its own:
 * the ledger has to be the production inbox. These tests run the scenario's
 * real seed and real delivery final check against a structural runtime whose
 * NOTIFICATION service is a readable inbox of that shape, and prove the check
 * counts one delivery per fired taskId, none for the gate-denied task, and
 * fails honestly on a missing, duplicated, or mis-rendered delivery.
 */

import type {
  ScenarioContext,
  ScenarioDefinition,
} from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import concurrentDayScenario from "../test/scenarios/deterministic-lifeops-concurrent-day.scenario.ts";

type JsonRecord = Record<string, unknown>;

const DELIVERY_CHECK_NAME =
  "every fired task delivered exactly one real notification; the gate-denied task delivered none";

interface SeededTask {
  taskId: string;
  kind: string;
  promptInstructions: string;
  priority: string;
  state: { status: string };
  metadata?: JsonRecord;
}

/** Minimal readable inbox with the same surface core's NotificationService has. */
class FakeNotificationInbox {
  readonly delivered: Array<{ body?: string; data?: JsonRecord }> = [];

  async notify(input: {
    body?: string;
    data?: JsonRecord;
  }): Promise<{ ok: true }> {
    this.delivered.push({ body: input.body, data: input.data });
    return { ok: true };
  }

  listIncludingExpired(): Array<{ body?: string; data?: JsonRecord }> {
    return [...this.delivered];
  }
}

/** Stand-in for ScheduledTaskRunnerService's per-agent runner handle. */
class FakeRunner {
  readonly tasks: SeededTask[] = [];
  private nextId = 0;

  async schedule(input: JsonRecord): Promise<SeededTask> {
    this.nextId += 1;
    const task: SeededTask = {
      taskId: `task-${String(this.nextId).padStart(2, "0")}`,
      kind: String(input.kind),
      promptInstructions: String(input.promptInstructions),
      priority: String(input.priority),
      state: { status: "scheduled" },
      metadata: input.metadata as JsonRecord | undefined,
    };
    this.tasks.push(task);
    return task;
  }

  async list(): Promise<SeededTask[]> {
    return [...this.tasks];
  }

  async apply(taskId: string, verb: string): Promise<SeededTask> {
    const task = this.tasks.find((entry) => entry.taskId === taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    if (verb === "dismiss") task.state.status = "dismissed";
    return task;
  }
}

function buildContext(inbox: FakeNotificationInbox | null): {
  ctx: ScenarioContext;
  runner: FakeRunner;
} {
  const runner = new FakeRunner();
  const runtime = {
    agentId: "agent-under-test",
    getService(serviceType: string): unknown {
      if (serviceType === "lifeops_scheduled_task_runner") {
        return { getRunner: () => runner };
      }
      if (serviceType === "notification") return inbox;
      return null;
    },
  };
  return {
    ctx: { runtime, actionsCalled: [] } as unknown as ScenarioContext,
    runner,
  };
}

function definition(): ScenarioDefinition {
  return concurrentDayScenario as ScenarioDefinition;
}

async function runSeed(ctx: ScenarioContext): Promise<string | undefined> {
  const seed = definition().seed?.[0];
  if (seed?.type !== "custom" || typeof seed.apply !== "function") {
    throw new Error("scenario seed[0] is not a custom apply seed");
  }
  return (await seed.apply(ctx)) as string | undefined;
}

function runDeliveryCheck(ctx: ScenarioContext): string | undefined {
  const check = definition().finalChecks?.find(
    (candidate) => candidate.name === DELIVERY_CHECK_NAME,
  );
  if (check?.type !== "custom") {
    throw new Error(`final check "${DELIVERY_CHECK_NAME}" is missing`);
  }
  return check.predicate(ctx) as string | undefined;
}

/** Deliver into the inbox exactly what the production dispatcher delivers. */
async function deliverFiredTasks(
  inbox: FakeNotificationInbox,
  runner: FakeRunner,
  options: { skipIndexes?: number[]; duplicateIndexes?: number[] } = {},
): Promise<void> {
  const skip = new Set(options.skipIndexes ?? []);
  const duplicate = new Set(options.duplicateIndexes ?? []);
  for (const [index, task] of runner.tasks.entries()) {
    if (skip.has(index)) continue;
    const copies = duplicate.has(index) ? 2 : 1;
    for (let copy = 0; copy < copies; copy += 1) {
      await inbox.notify({
        body: `Heads up: ${task.promptInstructions}`,
        data: { taskId: task.taskId, channelKey: "in_app" },
      });
    }
  }
}

/** The gate-denied task is the only seeded plan that must deliver nothing. */
function gateDeniedIndex(runner: FakeRunner): number {
  const index = runner.tasks.findIndex((task) =>
    task.promptInstructions.startsWith("Water the garden"),
  );
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

describe("deterministic-lifeops-concurrent-day delivery ledger", () => {
  it("reads the registered NOTIFICATION service inbox, not a scenario-owned sink", async () => {
    const inbox = new FakeNotificationInbox();
    const { ctx, runner } = buildContext(inbox);

    expect(await runSeed(ctx)).toBeUndefined();
    expect(runner.tasks).toHaveLength(26);

    await deliverFiredTasks(inbox, runner, {
      skipIndexes: [gateDeniedIndex(runner)],
    });

    expect(runDeliveryCheck(ctx)).toBeUndefined();
  });

  it("fails when a fired task delivered nothing", async () => {
    const inbox = new FakeNotificationInbox();
    const { ctx, runner } = buildContext(inbox);
    expect(await runSeed(ctx)).toBeUndefined();

    await deliverFiredTasks(inbox, runner, {
      skipIndexes: [gateDeniedIndex(runner), 0],
    });

    expect(runDeliveryCheck(ctx)).toContain(
      "approval-wire: expected 1 delivered notification(s), saw 0",
    );
  });

  it("fails when the gate-denied task reached the surface", async () => {
    const inbox = new FakeNotificationInbox();
    const { ctx, runner } = buildContext(inbox);
    expect(await runSeed(ctx)).toBeUndefined();

    await deliverFiredTasks(inbox, runner);

    expect(runDeliveryCheck(ctx)).toContain(
      "sunday-only: expected 0 delivered notification(s), saw 1",
    );
  });

  it("fails when one task delivered twice", async () => {
    const inbox = new FakeNotificationInbox();
    const { ctx, runner } = buildContext(inbox);
    expect(await runSeed(ctx)).toBeUndefined();

    await deliverFiredTasks(inbox, runner, {
      skipIndexes: [gateDeniedIndex(runner)],
      duplicateIndexes: [2],
    });

    expect(runDeliveryCheck(ctx)).toContain(
      "medication: expected 1 delivered notification(s), saw 2",
    );
  });

  it("fails when the delivered body is not the rendered owner-facing copy", async () => {
    const inbox = new FakeNotificationInbox();
    const { ctx, runner } = buildContext(inbox);
    expect(await runSeed(ctx)).toBeUndefined();

    const denied = gateDeniedIndex(runner);
    for (const [index, task] of runner.tasks.entries()) {
      if (index === denied) continue;
      await inbox.notify({
        body:
          index === 1
            ? task.promptInstructions
            : `Heads up: ${task.promptInstructions}`,
        data: { taskId: task.taskId },
      });
    }

    expect(runDeliveryCheck(ctx)).toContain(
      "midday-checkin: expected delivered body",
    );
  });

  it("refuses to seed when no readable notification inbox is registered", async () => {
    const { ctx } = buildContext(null);
    expect(await runSeed(ctx)).toContain(
      "no readable NOTIFICATION service is registered",
    );
  });
});
