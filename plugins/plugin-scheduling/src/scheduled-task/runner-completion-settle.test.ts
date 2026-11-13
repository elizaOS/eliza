/**
 * Owner-reply completion settles a fired task once.
 *
 * The personal-assistant plugin starts two reply scans for every owner
 * message (`plugin.ts` MESSAGE_RECEIVED): `handleScheduledTaskInboundMessage`
 * and `completeFiredTasksOnOwnerReply`. Both call `runner.evaluateCompletion`
 * for the same fired task, so the runner must let only one of them record
 * `completed` and run `pipeline.onComplete`.
 *
 * `quint/ScheduledTaskCompletionSettle.qnt` models the two scans. Its
 * conformance script passes every generated read/commit interleaving here
 * through `ELIZA_COMPLETION_SETTLE_MODEL_CASES`.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "./completion-check-registry.js";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "./consolidation-policy.js";
import { createEscalationLadderRegistry } from "./escalation.js";
import { createTaskGateRegistry } from "./gate-registry.js";
import {
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
} from "./runner.js";
import { createInMemoryScheduledTaskLogStore } from "./state-log.js";
import type { ScheduledTask } from "./types.js";

const AGENT_ID = "completion-settle-agent";
const NOW_ISO = "2026-11-13T09:00:00.000Z";
const REPLIED_AT_ISO = "2026-11-13T09:05:00.000Z";

type ScanPhase = "completed" | "raced" | "terminal";

interface ModelCase {
  /** Scan events in order: `r<scan>` reads the row, `c<scan>` commits. */
  order: string[];
  phase: Record<"1" | "2", ScanPhase>;
  children: number;
  completedLogs: number;
}

const modelCases: ModelCase[] = process.env.ELIZA_COMPLETION_SETTLE_MODEL_CASES
  ? JSON.parse(
      readFileSync(process.env.ELIZA_COMPLETION_SETTLE_MODEL_CASES, "utf8"),
    )
  : [
      {
        order: ["r1", "r2", "c1", "c2"],
        phase: { "1": "completed", "2": "raced" },
        children: 1,
        completedLogs: 1,
      },
      {
        order: ["r1", "c1", "r2"],
        phase: { "1": "completed", "2": "terminal" },
        children: 1,
        completedLogs: 1,
      },
    ];

interface Latch {
  promise: Promise<void>;
  release: () => void;
}

function latch(): Latch {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function makeHarness() {
  const store = createInMemoryScheduledTaskStore();
  const logStore = createInMemoryScheduledTaskLogStore();
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  // `evaluateCompletion` reads the row, then the owner clock, then commits.
  // An armed park holds the next evaluation at the owner clock, between its
  // read and its commit.
  let park: { entered: Latch; release: Latch } | null = null;
  let counter = 0;
  const runner = createScheduledTaskRunner({
    agentId: AGENT_ID,
    store,
    logStore,
    gates: createTaskGateRegistry(),
    completionChecks,
    ladders: createEscalationLadderRegistry(),
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: async () => {
      const held = park;
      park = null;
      if (held) {
        held.entered.release();
        await held.release.promise;
      }
      return { timezone: "UTC" };
    },
    globalPause: { current: async () => ({ active: false }) },
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
    dispatcher: { dispatch: async () => ({ ok: true }) },
    newTaskId: () => `task_${++counter}`,
    now: () => new Date(NOW_ISO),
  });

  async function scheduleFiredCheckin(): Promise<ScheduledTask> {
    const task = await runner.schedule({
      kind: "checkin",
      promptInstructions: "Ask how the workout went.",
      trigger: { kind: "manual" },
      priority: "low",
      completionCheck: { kind: "user_replied_within" },
      pipeline: {
        // `runPipeline` drops the template's taskId and state and schedules
        // a fresh child.
        onComplete: [
          {
            taskId: "followup-template",
            kind: "followup",
            promptInstructions: "Log the workout.",
            trigger: { kind: "manual" },
            priority: "low",
            respectsGlobalPause: true,
            source: "user_chat",
            createdBy: AGENT_ID,
            ownerVisible: true,
            state: { status: "scheduled", followupCount: 0 },
          },
        ],
      },
      respectsGlobalPause: true,
      source: "user_chat",
      createdBy: AGENT_ID,
      ownerVisible: true,
    });
    await runner.fire(task.taskId);
    return task;
  }

  async function settlement(taskId: string) {
    const tasks = await store.list();
    const logs = await logStore.list({ agentId: AGENT_ID, taskId });
    return {
      status: tasks.find((task) => task.taskId === taskId)?.state.status,
      children: tasks.filter((task) => task.state.pipelineParentId === taskId)
        .length,
      completedLogs: logs.filter((entry) => entry.transition === "completed")
        .length,
    };
  }

  function armPark() {
    const held = { entered: latch(), release: latch() };
    park = held;
    return held;
  }

  function disarmPark() {
    park = null;
  }

  return { runner, scheduleFiredCheckin, settlement, armPark, disarmPark };
}

async function outcome(
  evaluation: Promise<ScheduledTask>,
): Promise<"completed" | "raced" | "unchanged"> {
  try {
    const task = await evaluation;
    return task.state.status === "completed" ? "completed" : "unchanged";
  } catch (error) {
    if (
      (error as { code?: string } | undefined)?.code ===
      "SCHEDULED_TASK_MUTATION_RACED"
    ) {
      return "raced";
    }
    throw error;
  }
}

describe("owner-reply completion settlement", () => {
  it("settles a fired task once when both reply scans evaluate it together", async () => {
    const h = makeHarness();
    const task = await h.scheduleFiredCheckin();
    const reply = { repliedAtIso: REPLIED_AT_ISO };

    const results = await Promise.all([
      outcome(h.runner.evaluateCompletion(task.taskId, reply)),
      outcome(h.runner.evaluateCompletion(task.taskId, reply)),
    ]);

    expect(results.sort()).toEqual(["completed", "raced"]);
    expect(await h.settlement(task.taskId)).toEqual({
      status: "completed",
      children: 1,
      completedLogs: 1,
    });
  });

  it("leaves a task the other reply scan already completed", async () => {
    const h = makeHarness();
    const task = await h.scheduleFiredCheckin();
    const reply = { repliedAtIso: REPLIED_AT_ISO };

    const first = await h.runner.evaluateCompletion(task.taskId, reply);
    const second = await h.runner.evaluateCompletion(task.taskId, reply);

    expect(first.state.status).toBe("completed");
    expect(second).toEqual(first);
    expect(await h.settlement(task.taskId)).toEqual({
      status: "completed",
      children: 1,
      completedLogs: 1,
    });
  });

  it("replays the completion settlement model through the runner", async () => {
    const expected: unknown[] = [];
    const actual: unknown[] = [];
    for (const modelCase of modelCases) {
      const h = makeHarness();
      const task = await h.scheduleFiredCheckin();
      const scans = new Map<
        string,
        {
          held: { entered: Latch; release: Latch };
          parked: boolean;
          result: Promise<"completed" | "raced" | "unchanged">;
        }
      >();
      const observed: Record<string, ScanPhase | "parked"> = {};

      for (const event of modelCase.order) {
        const scan = event.slice(1);
        if (event.startsWith("r")) {
          const held = h.armPark();
          const result = outcome(
            h.runner.evaluateCompletion(task.taskId, {
              repliedAtIso: REPLIED_AT_ISO,
            }),
          );
          const parked = await Promise.race([
            held.entered.promise.then(() => true),
            result.then(() => false),
          ]);
          h.disarmPark();
          scans.set(scan, { held, parked, result });
          // A scan that reads a settled row stops before the check runs.
          observed[scan] = parked
            ? "parked"
            : (await result) === "completed"
              ? "terminal"
              : "raced";
        } else {
          const pending = scans.get(scan);
          if (!pending?.parked) {
            throw new Error(
              `Model commit ${event} has no parked read in ${modelCase.order.join(" ")}`,
            );
          }
          pending.parked = false;
          pending.held.release.release();
          const result = await pending.result;
          observed[scan] = result === "unchanged" ? "raced" : result;
        }
      }
      // A scan still held at the owner clock evaluated a row the model says
      // it must leave; let it finish so the settlement shows its effect.
      for (const pending of scans.values()) {
        if (!pending.parked) continue;
        pending.held.release.release();
        await pending.result.catch(() => undefined);
      }

      const order = modelCase.order.join(" ");
      expected.push({
        order,
        phase: modelCase.phase,
        settlement: {
          status: "completed",
          children: modelCase.children,
          completedLogs: modelCase.completedLogs,
        },
      });
      actual.push({
        order,
        phase: observed,
        settlement: await h.settlement(task.taskId),
      });
    }
    expect(actual).toEqual(expected);
  });
});
