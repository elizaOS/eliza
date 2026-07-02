/**
 * Keyless integration tests for the goals check-in engine — the mission
 * loop end-to-end on a REAL runtime (PGLite DB, real plugin registration,
 * real scheduling spine, zero API keys):
 *
 *  1. goal created (with cadence) → a check-in ScheduledTask exists on the
 *     spine runner,
 *  2. the task is due at the owner's local hour and fires through the
 *     production runner host (tick mechanics: due-check + fire),
 *  3. the owner's response records progress: task completed, goal
 *     `reviewState` + bounded `metadata.checkinLog` updated, audit row
 *     written,
 *  4. the OWNER_GOALS `checkin` subaction drives the same path from natural
 *     language via the mock-LLM extraction pass,
 *  5. deleting the goal dismisses its live check-in tasks.
 */

import { type HandlerCallback, type Memory, ModelType } from "@elizaos/core";
import {
  getScheduledTaskRunner,
  isScheduledTaskDue,
  OWNER_LOCAL_TZ,
  type ScheduledTask,
  schedulingPlugin,
} from "@elizaos/plugin-scheduling";
import { type MockLlmRuntime, withMockLlmRuntime } from "@elizaos/test-harness";
import { afterEach, describe, expect, it } from "vitest";
import { ownerGoalsAction } from "../actions/goals.ts";
import { executeRawSql } from "../db/sql.ts";
import { createOwnerGoalsService } from "../goals-runtime.ts";
import { goalsPlugin } from "../plugin.ts";
import {
  GOAL_CHECKIN_CREATED_BY,
  type GoalCheckinLogEntry,
  getGoalsCheckinService,
} from "./checkin.ts";

const OWNER_TZ = "America/Denver";

/**
 * Peer-owned PA tables the goals back-end touches, provisioned minimally in
 * this PA-free harness (same approach as goals.harness.test.ts): the audit
 * table (goal writes append there) and `life_task_definitions` (deleteGoal
 * clears its `goal_id` references).
 */
async function provisionPeerTables(harness: MockLlmRuntime): Promise<void> {
  await executeRawSql(
    harness.runtime,
    "CREATE SCHEMA IF NOT EXISTS app_lifeops",
  );
  await executeRawSql(
    harness.runtime,
    `CREATE TABLE IF NOT EXISTS app_lifeops.life_audit_events (
       id text PRIMARY KEY,
       agent_id text NOT NULL,
       event_type text NOT NULL,
       owner_type text NOT NULL,
       owner_id text NOT NULL,
       reason text,
       inputs_json text,
       decision_json text,
       actor text NOT NULL,
       created_at text NOT NULL
     )`,
  );
  await executeRawSql(
    harness.runtime,
    `CREATE TABLE IF NOT EXISTS app_lifeops.life_task_definitions (
       id text PRIMARY KEY,
       agent_id text NOT NULL,
       goal_id text
     )`,
  );
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

function track(harness: MockLlmRuntime): MockLlmRuntime {
  cleanups.push(harness.cleanup);
  return harness;
}

async function makeHarness(
  fixtures: Parameters<typeof withMockLlmRuntime>[0]["fixtures"] = [],
): Promise<MockLlmRuntime> {
  const harness = track(
    await withMockLlmRuntime({
      plugins: [schedulingPlugin, goalsPlugin],
      fixtures,
    }),
  );
  await provisionPeerTables(harness);
  return harness;
}

async function listGoalCheckinTasks(
  harness: MockLlmRuntime,
  goalId: string,
): Promise<ScheduledTask[]> {
  const runner = getScheduledTaskRunner(harness.runtime, {
    agentId: harness.runtime.agentId,
  });
  const tasks = await runner.list({ kind: "checkin" });
  return tasks.filter(
    (task) =>
      task.createdBy === GOAL_CHECKIN_CREATED_BY &&
      task.metadata?.goalId === goalId,
  );
}

function denverHourOf(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: OWNER_TZ,
    hour: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

describe("goals check-ins on the scheduling spine (keyless harness)", () => {
  it("creates a check-in task on goal create, fires it at the owner's local hour, and records the response into goal progress", async () => {
    const harness = await makeHarness();
    const goals = createOwnerGoalsService(harness.runtime);

    // 1. goal created → check-in task exists.
    const record = await goals.createGoal({
      title: "Run a marathon",
      description: "Train four times a week",
      cadence: { kind: "daily", windows: ["morning"] },
    });
    const goalId = record.goal.id;
    const [task] = await listGoalCheckinTasks(harness, goalId);
    expect(task).toBeDefined();
    expect(task.trigger).toEqual({
      kind: "cron",
      expression: "0 9 * * *",
      tz: OWNER_LOCAL_TZ,
    });
    expect(task.state.status).toBe("scheduled");

    // 2. tick mechanics: due at the owner's local 09:00, fired through the
    //    production runner host.
    const createdAtIso = task.metadata?.createdAtIso;
    expect(typeof createdAtIso).toBe("string");
    const probeNow = new Date(
      Date.parse(createdAtIso as string) + 48 * 60 * 60 * 1000,
    );
    const decision = await isScheduledTaskDue(task, {
      now: probeNow,
      ownerFacts: { timezone: OWNER_TZ },
    });
    expect(decision.due).toBe(true);
    const occurrenceAtIso = decision.occurrenceAtIso as string;
    expect(denverHourOf(occurrenceAtIso)).toBe("09");

    const firingRunner = getScheduledTaskRunner(harness.runtime, {
      agentId: harness.runtime.agentId,
      now: () => new Date(occurrenceAtIso),
    });
    const fired = await firingRunner.fire(task.taskId);
    expect(fired.state.status).toBe("fired");

    // 3. owner's response → task completed + goal progress recorded.
    const checkin = getGoalsCheckinService(harness.runtime);
    if (!checkin) throw new Error("GoalsCheckinService is not registered");
    const { goal: updated, completedTaskId } =
      await checkin.recordCheckinResponse({
        goalId,
        note: "long run done, knees fine",
        progress: "on_track",
      });
    expect(completedTaskId).toBe(task.taskId);
    expect(updated.reviewState).toBe("on_track");
    const log = updated.metadata.checkinLog as GoalCheckinLogEntry[];
    expect(log).toHaveLength(1);
    expect(log[0].taskId).toBe(task.taskId);
    expect(log[0].note).toBe("long run done, knees fine");
    expect(log[0].progress).toBe("on_track");

    const [completedTask] = await listGoalCheckinTasks(harness, goalId);
    expect(completedTask.state.status).toBe("completed");

    const auditRows = await executeRawSql(
      harness.runtime,
      `SELECT reason FROM app_lifeops.life_audit_events
        WHERE owner_id = '${goalId}'
          AND reason = 'goal check-in response recorded'`,
    );
    expect(auditRows).toHaveLength(1);
  });

  it("records a check-in response from natural language via the OWNER_GOALS checkin subaction", async () => {
    const harness = await makeHarness([]);
    const goals = createOwnerGoalsService(harness.runtime);
    const record = await goals.createGoal({
      title: "Learn Spanish",
      cadence: { kind: "weekly", weekdays: [1], windows: ["evening"] },
    });

    harness.fixtures.register({
      name: "goal-checkin-extraction",
      match: { modelType: ModelType.TEXT_LARGE },
      response: JSON.stringify({
        action: "checkin",
        params: {
          id: record.goal.id,
          note: "did three lessons",
          progress: "on_track",
        },
        missing: [],
        confidence: 0.95,
      }),
      times: 1,
    });

    const message = {
      content: {
        text: "Checking in on my Spanish goal: did three lessons, going well.",
      },
    } as Memory;
    let reply = "";
    const callback: HandlerCallback = async (content) => {
      if (typeof content.text === "string") reply += content.text;
      return [];
    };
    const result = (await ownerGoalsAction.handler(
      harness.runtime,
      message,
      undefined,
      undefined,
      callback,
    )) as { success: boolean };

    expect(result.success, reply).toBe(true);
    expect(reply).toContain('Logged check-in for "Learn Spanish"');
    expect(reply).toContain("on track");
    const refreshed = await goals.getGoal(record.goal.id);
    expect(refreshed.goal.reviewState).toBe("on_track");
    expect(() => harness.assertFixturesConsumed()).not.toThrow();
  });

  it("dismisses the goal's live check-in tasks when the goal is deleted", async () => {
    const harness = await makeHarness();
    const goals = createOwnerGoalsService(harness.runtime);
    const record = await goals.createGoal({
      title: "Read twelve books",
      cadence: { kind: "daily", windows: ["night"] },
    });

    const [before] = await listGoalCheckinTasks(harness, record.goal.id);
    expect(before.state.status).toBe("scheduled");

    await goals.deleteGoal(record.goal.id);

    const [after] = await listGoalCheckinTasks(harness, record.goal.id);
    expect(after.state.status).toBe("dismissed");
  });
});
