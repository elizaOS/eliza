/**
 * Multi-project orchestration failure isolation (pr-deterministic, keyless): the
 * companion to `orchestrator-multi-project-portfolio.scenario.ts`. Where the
 * portfolio proves the all-green path, this proves the ERROR paths are contained
 * — one task failing, being grilled, or being cancelled never corrupts a sibling
 * in the same project or a task in another project.
 *
 * Three registered projects run simultaneously (5 + 5 + 5 = 15 tasks) against the
 * REAL `OrchestratorTaskService` over a cap-enforcing deterministic ACP, and each
 * task is assigned a PLANNED outcome the scenario drives structurally:
 *
 *  - **clean** — completes with pasted test output; the evidence-grounded judge
 *    passes it → `done`.
 *  - **crash** — the sub-agent dies (`error` with a plain crash message, no
 *    respawnable failureKind); the real event bridge classifies it un-respawnable
 *    → terminal `failed`, with a `task_failed` event on THAT task only.
 *  - **grill** — completes WITHOUT proof; the judge fails it → `auto_verify_failed`
 *    → the task returns to `active` and the kept-alive worker is re-prompted; the
 *    scenario then delivers proof, and the retry lands `done`. Proves a failed
 *    verification neither promotes the task nor bleeds onto its siblings.
 *  - **cancel** — archived while still parked in the admission queue; the real
 *    `archiveTask` dequeues it, stops any session, and drives it terminal
 *    (`archived`) without ever spawning, freeing queue pressure for the rest.
 *
 * Structural proofs: every task's FINAL status equals its planned outcome (total
 * isolation), each error event lands on its own task document, event routing is
 * clean (zero foreign sessions), the worker high-water mark never exceeds the cap
 * and the queue drains to zero, and per-project list-by-status filters return
 * exactly the expected partition.
 */

import type { Action, Plugin, UUID } from "@elizaos/core";
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store.js";
import {
  applyScenarioEnv,
  foreignEventSessions,
  MultiProjectAcp,
  makeMultiProjectRuntime,
  registerScenarioProjects,
  type ScenarioProject,
  waitForTask,
  waitUntil,
} from "./_helpers/multi-project-scenario";
import { registerCalibratedJudgeFixture } from "./_helpers/orchestrator-scenario-harness";

const ISOLATION_PLUGIN_NAME =
  "orchestrator-multi-project-failure-isolation-scenario";
const ORCHESTRATOR_MULTI_PROJECT_FAILURE_ISOLATION =
  "ORCHESTRATOR_MULTI_PROJECT_FAILURE_ISOLATION";

const AGENT_ID = "aa020000-0000-4000-8000-000000000001" as UUID;
const CAP = 6;

/** Planned outcome for each task; the scenario drives the real service to land
 * exactly this terminal (or, for a recovered grill, `done`) status. */
type Outcome = "clean" | "crash" | "grill" | "cancel";

/** Map of a planned outcome to the terminal task status it must reach. `grill`
 * ends `done` because the scenario delivers proof on the retry. */
const OUTCOME_FINAL_STATUS: Record<Outcome, string> = {
  clean: "done",
  crash: "failed",
  grill: "done",
  cancel: "archived",
};

/**
 * Per-project task plans: 3 projects, 5 tasks each (15 total). Each project mixes
 * a distinct set of error paths with clean tasks so isolation is proven both
 * within a project (a crash next to clean siblings) and across projects.
 */
const PROJECT_PLAN: Array<{ name: string; outcomes: Outcome[] }> = [
  {
    name: "checkout-service",
    outcomes: ["clean", "crash", "grill", "clean", "clean"],
  },
  {
    name: "web-dashboard",
    outcomes: ["clean", "cancel", "clean", "grill", "clean"],
  },
  {
    name: "mobile-app",
    outcomes: ["clean", "clean", "crash", "clean", "cancel"],
  },
];
const TOTAL = PROJECT_PLAN.reduce((sum, p) => sum + p.outcomes.length, 0);
const CLEAN_TOTAL = countOutcome("clean");
const CRASH_TOTAL = countOutcome("crash");
const GRILL_TOTAL = countOutcome("grill");
const CANCEL_TOTAL = countOutcome("cancel");
/** Judge verdicts fire once per proofless grill (fail) + once per clean/grill
 * completion (pass). Cancelled + crashed tasks never reach the judge. */
const JUDGE_VERDICTS = CLEAN_TOTAL + GRILL_TOTAL * 2;

function countOutcome(outcome: Outcome): number {
  return PROJECT_PLAN.reduce(
    (sum, p) => sum + p.outcomes.filter((o) => o === outcome).length,
    0,
  );
}

type PerProjectResult = {
  projectId: string;
  name: string;
  statuses: Record<string, string>;
  byStatus: Record<string, number>;
};

type IsolationResult = {
  summary: string;
  cap: number;
  totalTasks: number;
  workerHighWaterMark: number;
  judgeVerdicts: number;
  /** taskId -> planned outcome, for the isolation assertion. */
  plannedOutcomes: Record<string, Outcome>;
  /** taskId -> observed terminal status. */
  finalStatuses: Record<string, string>;
  /** Tasks whose observed status did not match the planned outcome. */
  outcomeViolations: string[];
  /** A crashed task missing its `task_failed` event, or one on the wrong task. */
  crashEventViolations: string[];
  /** A grilled task missing its `auto_verify_failed` event. */
  grillEventViolations: string[];
  /** Session ids found on a task doc that belong to another task — must be []. */
  foreignRoutes: string[];
  workdirViolations: string[];
  listFilterViolations: string[];
  perProject: PerProjectResult[];
};

function isolationData(ctx: ScenarioContext): IsolationResult | null {
  const action = ctx.actionsCalled.find(
    (c) => c.actionName === ORCHESTRATOR_MULTI_PROJECT_FAILURE_ISOLATION,
  );
  const data = action?.result?.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as IsolationResult)
    : null;
}

/** A completion carrying concrete proof the evidence-grounded judge accepts. */
function proofFor(title: string, projectName: string): string {
  return `Done: ${title}. Proof: Tests 4 passed (4) in ${projectName}.`;
}

/** A proofless completion the judge must reject, driving the grill retry. */
function prooflessFor(title: string): string {
  return `I finished ${title}. Everything works, trust me.`;
}

async function runFailureIsolation(): Promise<IsolationResult> {
  const restoreGates = applyScenarioEnv({
    ELIZA_ACP_ADMISSION_QUEUE: "1",
    ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY: "1",
    ELIZA_ORCHESTRATOR_WATCHDOG: "0",
    ELIZA_ORCHESTRATOR_INDEPENDENT_VERIFY: "0",
  });
  const { projects, restoreEnv } = registerScenarioProjects(
    "eliza-orch-isolation",
    PROJECT_PLAN.map((p) => p.name),
  );
  const acp = new MultiProjectAcp(CAP);
  const judgePrompts: string[] = [];
  const runtime = makeMultiProjectRuntime(acp, {
    agentId: AGENT_ID,
    onJudge: (prompt) => judgePrompts.push(prompt),
  });
  const store = new OrchestratorTaskStore({ backend: "memory" });
  const service = new OrchestratorTaskService(runtime as never, { store });
  await service.start();

  try {
    // ── Create 15 tasks, round-robin interleaved across the three projects so
    // the store never sees one project as a contiguous block. Each task carries
    // its planned outcome for the driver + isolation assertion. ───────────────
    const taskProject = new Map<string, ScenarioProject>();
    const taskTitle = new Map<string, string>();
    const plannedOutcomes: Record<string, Outcome> = {};
    const perProjectIds = new Map<string, string[]>(
      projects.map((p) => [p.id, []]),
    );
    const maxPerProject = Math.max(
      ...PROJECT_PLAN.map((p) => p.outcomes.length),
    );
    for (let round = 0; round < maxPerProject; round++) {
      for (const [index, plan] of PROJECT_PLAN.entries()) {
        if (round >= plan.outcomes.length) continue;
        const project = projects[index];
        const outcome = plan.outcomes[round];
        const title = `${plan.name} task ${round + 1} (${outcome})`;
        const detail = await service.createTask({
          title,
          goal: `Ship improvement ${round + 1} for ${plan.name}.`,
          originalRequest: `Please ship improvement ${round + 1} for ${plan.name}.`,
          kind: "coding",
          priority: "normal",
          roomId: project.roomId,
          projectId: project.id,
          metadata: { source: "scenario-runner" },
          acceptanceCriteria: [
            `improvement ${round + 1} tests pass in ${plan.name}`,
          ],
        });
        taskProject.set(detail.id, project);
        taskTitle.set(detail.id, title);
        plannedOutcomes[detail.id] = outcome;
        perProjectIds.get(project.id)?.push(detail.id);
      }
    }

    // ── Cancel the `cancel`-outcome tasks FIRST, while every task is still open
    // and (after spawn) some will be parked. Archiving here proves cancel works
    // on a not-yet-dispatched task and never spawns a worker for it. ───────────
    for (const [taskId, outcome] of Object.entries(plannedOutcomes)) {
      if (outcome !== "cancel") continue;
      const archived = await service.archiveTask(taskId);
      if (archived?.status !== "archived") {
        throw new Error(
          `cancel: expected archived, saw ${archived?.status ?? "(null)"} for ${taskId}`,
        );
      }
    }

    // ── Spawn every non-cancelled task against the 6-worker cap. Over-cap spawns
    // park in the real admission queue; cancelled tasks are skipped entirely so
    // no worker is ever minted for them. ──────────────────────────────────────
    const spawnable = [...taskProject.keys()].filter(
      (id) => plannedOutcomes[id] !== "cancel",
    );
    for (const taskId of spawnable) {
      await service.spawnAgentForTask(taskId, {});
    }

    // ── Drive each ready session to its planned outcome, wave by wave, so a
    // terminal event frees a slot and the admission queue drains the next parked
    // task. Grilled tasks are completed proofless first (judge fails → retry),
    // then re-completed with proof on the reactivated worker. ──────────────────
    const workdirViolations: string[] = [];
    const grilledOnce = new Set<string>();
    const handled = new Set<string>();
    for (let guard = 0; guard < TOTAL * 8; guard++) {
      const ready = acp.readySessions().filter((s) => {
        const taskId = String(s.metadata?.taskId ?? "");
        const outcome = plannedOutcomes[taskId];
        // A grilled session is "ready" again after re-engage; only skip it once
        // its retry proof has been delivered (handled).
        if (handled.has(s.id) && outcome !== "grill") return false;
        if (outcome === "grill" && handled.has(s.id)) return false;
        return true;
      });
      if (ready.length === 0) {
        const depth = (await service.getAdmissionSnapshot()).queueDepth;
        if (depth === 0) break;
        await waitUntil(
          () => acp.readySessions().some((s) => !handled.has(s.id)),
          "admission drain to dispatch a parked task",
        );
        continue;
      }
      for (const session of ready) {
        const taskId = String(session.metadata?.taskId ?? "");
        const project = taskProject.get(taskId);
        const outcome = plannedOutcomes[taskId];
        if (!project) throw new Error(`session ${session.id} has no task`);
        if (session.workdir !== project.localPath) {
          workdirViolations.push(
            `${session.id}: workdir ${session.workdir} != ${project.localPath}`,
          );
        }
        // A fresh spawn advances the task to `active`; wait for it so the
        // terminal event we drive next is a legal transition.
        await waitForTask(
          store,
          taskId,
          (doc) => doc.task.status === "active",
          `task ${taskId} active after spawn`,
        );
        acp.emit(session.id, "message", {
          text: `progress ${project.name}: ${taskTitle.get(taskId)}`,
        });

        if (outcome === "crash") {
          acp.crash(session.id, "worker process died unexpectedly (SIGKILL)");
          await waitForTask(
            store,
            taskId,
            (doc) =>
              doc.task.status === "failed" &&
              doc.events.some((e) => e.eventType === "task_failed"),
            `crash task ${taskId} failed`,
          );
          handled.add(session.id);
          continue;
        }

        if (outcome === "grill" && !grilledOnce.has(session.id)) {
          // First completion carries NO proof — the judge must reject it and the
          // task must return to `active` for a corrective retry.
          acp.complete(session.id, prooflessFor(taskTitle.get(taskId) ?? ""));
          await waitForTask(
            store,
            taskId,
            (doc) =>
              doc.task.status === "active" &&
              doc.events.some((e) => e.eventType === "auto_verify_failed"),
            `grill task ${taskId} bounced back to active`,
          );
          grilledOnce.add(session.id);
          // The re-engage reactivated the kept-alive session; complete it again
          // WITH proof so the retry lands `done`.
          await waitUntil(
            () => acp.readySessions().some((s) => s.id === session.id),
            `grill task ${taskId} worker reactivated`,
          );
          acp.complete(
            session.id,
            proofFor(taskTitle.get(taskId) ?? "", project.name),
          );
          await waitForTask(
            store,
            taskId,
            (doc) =>
              doc.task.status === "done" &&
              doc.events.some((e) => e.eventType === "validation_passed"),
            `grill task ${taskId} recovered to done`,
          );
          handled.add(session.id);
          continue;
        }

        // clean
        acp.complete(
          session.id,
          proofFor(taskTitle.get(taskId) ?? "", project.name),
        );
        await waitForTask(
          store,
          taskId,
          (doc) =>
            doc.task.status === "done" &&
            doc.events.some((e) => e.eventType === "validation_passed"),
          `clean task ${taskId} validated done`,
        );
        handled.add(session.id);
      }
    }
    await waitUntil(
      async () => (await service.getAdmissionSnapshot()).queueDepth === 0,
      "admission queue drained to zero",
    );

    // ── Final structural proof across all 15 tasks. ──────────────────────────
    const finalStatuses: Record<string, string> = {};
    const outcomeViolations: string[] = [];
    const crashEventViolations: string[] = [];
    const grillEventViolations: string[] = [];
    const foreignRoutes: string[] = [];
    const listFilterViolations: string[] = [];
    const perProject: PerProjectResult[] = [];

    for (const project of projects) {
      const ids = perProjectIds.get(project.id) ?? [];
      const statuses: Record<string, string> = {};
      const byStatus: Record<string, number> = {};
      for (const taskId of ids) {
        const doc = await store.getTask(taskId);
        if (!doc) throw new Error(`task ${taskId} missing at final read`);
        const status = doc.task.status;
        statuses[taskId] = status;
        finalStatuses[taskId] = status;
        byStatus[status] = (byStatus[status] ?? 0) + 1;

        const planned = plannedOutcomes[taskId];
        const expected = OUTCOME_FINAL_STATUS[planned];
        if (status !== expected) {
          outcomeViolations.push(
            `${taskId} (${planned}): status ${status}, expected ${expected}`,
          );
        }
        // The error event must land on THIS task's own document.
        if (planned === "crash") {
          if (!doc.events.some((e) => e.eventType === "task_failed")) {
            crashEventViolations.push(`${taskId}: no task_failed event`);
          }
        }
        if (planned === "grill") {
          if (!doc.events.some((e) => e.eventType === "auto_verify_failed")) {
            grillEventViolations.push(`${taskId}: no auto_verify_failed event`);
          }
        }
        foreignRoutes.push(...foreignEventSessions(doc));
      }
      perProject.push({
        projectId: project.id,
        name: project.name,
        statuses,
        byStatus,
      });

      // ── List/filter by status: each project's done/failed/archived partition
      // returns exactly the tasks with that planned outcome, and never a sibling
      // project's tasks. ──────────────────────────────────────────────────────
      const idSet = new Set(ids);
      const outcomes =
        PROJECT_PLAN.find((p) => p.name === project.name)?.outcomes ?? [];
      for (const [status, plannedForStatus] of [
        ["done", ["clean", "grill"] as Outcome[]],
        ["failed", ["crash"] as Outcome[]],
        ["archived", ["cancel"] as Outcome[]],
      ] as const) {
        const expectedCount = outcomes.filter((o) =>
          plannedForStatus.includes(o),
        ).length;
        const listed = await service.listTasks({
          projectId: project.id,
          status,
          includeArchived: status === "archived",
        });
        const scoped = listed.filter((t) => idSet.has(t.id));
        if (scoped.length !== expectedCount) {
          listFilterViolations.push(
            `${project.name} status=${status}: listed ${scoped.length}, expected ${expectedCount}`,
          );
        }
        if (listed.some((t) => !idSet.has(t.id))) {
          listFilterViolations.push(
            `${project.name} status=${status}: leaked a foreign-project task`,
          );
        }
      }
    }

    const doneCount = Object.values(finalStatuses).filter(
      (s) => s === "done",
    ).length;
    const failedCount = Object.values(finalStatuses).filter(
      (s) => s === "failed",
    ).length;
    const archivedCount = Object.values(finalStatuses).filter(
      (s) => s === "archived",
    ).length;

    return {
      summary:
        `orchestrated 3 projects with mixed error paths (${TOTAL} tasks: ` +
        `${doneCount} done, ${failedCount} failed, ${archivedCount} cancelled): ` +
        `${CRASH_TOTAL} agent-dies crashes went terminal-failed, ${GRILL_TOTAL} proofless ` +
        `completions were grilled and recovered on retry, ${CANCEL_TOTAL} tasks cancelled ` +
        `before dispatch, and every clean sibling still reached done — one task failing ` +
        `never corrupted another, with zero foreign event routes and the ${CAP}-worker cap ` +
        `respected (high-water mark ${acp.workerHighWaterMark})`,
      cap: CAP,
      totalTasks: TOTAL,
      workerHighWaterMark: acp.workerHighWaterMark,
      judgeVerdicts: judgePrompts.length,
      plannedOutcomes,
      finalStatuses,
      outcomeViolations,
      crashEventViolations,
      grillEventViolations,
      foreignRoutes,
      workdirViolations,
      listFilterViolations,
      perProject,
    };
  } finally {
    await service.stop();
    restoreEnv();
    restoreGates();
  }
}

function isolationPlugin(): Plugin {
  const action: Action = {
    name: ORCHESTRATOR_MULTI_PROJECT_FAILURE_ISOLATION,
    description:
      "Drive three registered projects with mixed error paths (crash, verify-fail grill, cancel) interleaved with clean tasks, and prove one task failing never corrupts a sibling in the same or another project.",
    validate: async () => true,
    handler: async () => {
      const result = await runFailureIsolation();
      return {
        success: true,
        text: result.summary,
        userFacingText: result.summary,
        verifiedUserFacing: true,
        data: result,
      };
    },
  };
  return {
    name: ISOLATION_PLUGIN_NAME,
    description:
      "Deterministic multi-project orchestration failure-isolation scenario.",
    actions: [action],
  };
}

export default scenario({
  id: "orchestrator-multi-project-failure-isolation",
  lane: "pr-deterministic",
  title:
    "Orchestrator isolates failures across 3 projects: crash, grill, and cancel paths never corrupt sibling tasks",
  domain: "agent-orchestrator",
  tags: [
    "orchestrator",
    "multi-project",
    "multi-task",
    "failure-isolation",
    "error-path",
    "concurrency",
    "pr",
    "deterministic",
  ],
  isolation: "shared-runtime",
  requires: {
    plugins: [ISOLATION_PLUGIN_NAME],
  },
  seed: [
    {
      type: "custom",
      name: "register multi-project failure-isolation scenario action",
      apply: async (ctx) => {
        const runtime = ctx.runtime as {
          registerPlugin?: (plugin: Plugin) => Promise<void>;
          plugins?: Array<{ name?: string }>;
        };
        const already = runtime.plugins?.some(
          (plugin) => plugin.name === ISOLATION_PLUGIN_NAME,
        );
        if (!already) {
          await runtime.registerPlugin?.(isolationPlugin());
        }
        registerCalibratedJudgeFixture(
          ctx.runtime as Parameters<typeof registerCalibratedJudgeFixture>[0],
          ORCHESTRATOR_MULTI_PROJECT_FAILURE_ISOLATION,
          [
            "orchestrated 3 projects with mixed error paths",
            `${CRASH_TOTAL} agent-dies crashes went terminal-failed`,
            "grilled and recovered on retry",
            "never corrupted another",
          ],
        );
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "action",
      name: "drive three projects with interleaved crash, grill, and cancel paths",
      text: "Run three projects at once and prove that a crashing, grilled, or cancelled task never corrupts its siblings.",
      actionName: ORCHESTRATOR_MULTI_PROJECT_FAILURE_ISOLATION,
      responseIncludesAny: [
        "orchestrated 3 projects with mixed error paths",
        "never corrupted another",
      ],
      assertTurn: (turn) => {
        const data = turn.actionsCalled[0]?.result?.data as
          | IsolationResult
          | undefined;
        if (!data) return "failure-isolation scenario produced no data";
        if (data.outcomeViolations.length > 0) {
          return `outcome violations: ${data.outcomeViolations.join(" | ").slice(0, 400)}`;
        }
        if (data.workerHighWaterMark > CAP) {
          return `worker high-water mark ${data.workerHighWaterMark} exceeded cap ${CAP}`;
        }
        return undefined;
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: ORCHESTRATOR_MULTI_PROJECT_FAILURE_ISOLATION,
      status: "success",
    },
    {
      type: "custom",
      name: "3 projects x 15 tasks: every planned outcome held, error events landed on their own task, routing stayed clean, and cap respected",
      predicate: (ctx) => {
        const data = isolationData(ctx);
        if (!data) return "failure-isolation scenario produced no data";
        if (data.perProject.length !== 3) {
          return `expected 3 projects, saw ${data.perProject.length}`;
        }
        if (Object.keys(data.finalStatuses).length !== TOTAL) {
          return `expected ${TOTAL} task statuses, saw ${Object.keys(data.finalStatuses).length}`;
        }
        for (const [label, violations] of [
          ["outcome", data.outcomeViolations],
          ["crashEvent", data.crashEventViolations],
          ["grillEvent", data.grillEventViolations],
          ["foreignRoutes", data.foreignRoutes],
          ["workdir", data.workdirViolations],
          ["listFilter", data.listFilterViolations],
        ] as const) {
          if (violations.length > 0) {
            return `${label} violations: ${violations.join(" | ").slice(0, 400)}`;
          }
        }
        // Each error class actually happened (the scenario is not vacuously green
        // because it never drove an error).
        const finals = Object.values(data.finalStatuses);
        const done = finals.filter((s) => s === "done").length;
        const failed = finals.filter((s) => s === "failed").length;
        const archived = finals.filter((s) => s === "archived").length;
        if (failed !== CRASH_TOTAL) {
          return `expected ${CRASH_TOTAL} failed (crashed) tasks, saw ${failed}`;
        }
        if (archived !== CANCEL_TOTAL) {
          return `expected ${CANCEL_TOTAL} archived (cancelled) tasks, saw ${archived}`;
        }
        if (done !== CLEAN_TOTAL + GRILL_TOTAL) {
          return `expected ${CLEAN_TOTAL + GRILL_TOTAL} done (clean + recovered grill) tasks, saw ${done}`;
        }
        if (data.judgeVerdicts !== JUDGE_VERDICTS) {
          return `expected ${JUDGE_VERDICTS} verifier verdicts, saw ${data.judgeVerdicts}`;
        }
        if (data.workerHighWaterMark > CAP) {
          return `worker high-water mark ${data.workerHighWaterMark} exceeded cap ${CAP}`;
        }
        return undefined;
      },
    },
    {
      type: "judgeRubric",
      name: "judge verifies failure isolation across projects",
      minimumScore: 0.95,
      rubric:
        "Pass only if the trace shows three projects orchestrated simultaneously with mixed error paths — a crashed sub-agent going terminal-failed, a proofless completion grilled and recovered on retry, and a cancelled task archived before dispatch — while every clean sibling still reached done and no failure corrupted another task, with the worker cap respected and zero cross-project event routing.",
    },
  ],
});
