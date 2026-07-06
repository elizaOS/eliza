/**
 * Multi-project orchestration portfolio (pr-deterministic, keyless): the task
 * orchestrator manages THREE registered projects simultaneously — 6 + 5 + 7 =
 * 18 tasks — through the full create → spawn → progress → verify → complete
 * lifecycle against the REAL `OrchestratorTaskService` (event bridge, legal
 * transition table, admission queue, auto goal-verify) over a cap-enforcing
 * deterministic ACP. Proves, structurally:
 *
 *  - project binding: every task carries its registered `projectId` and the
 *    project-derived memory `worldId`, and every spawned session lands LOCKED
 *    in its project's `localPath` (the #13776 per-session repo-drift fix);
 *  - list/filter by project: `listTasks({ projectId })` returns exactly that
 *    project's tasks, before and after the run;
 *  - concurrency respected: 18 spawns against an 8-worker cap park 10 in the
 *    admission queue, the worker high-water mark never exceeds the cap, and the
 *    queue drains to zero with exactly one session per task (no drops/doubles);
 *  - event routing: progress/completion events interleaved across all three
 *    projects land only on their own task documents — zero foreign sessions;
 *  - verification: every completion passes through validating → the
 *    evidence-grounded judge (which only passes pasted test output) → done.
 *
 * Error paths (crash, verify-fail grill, cancel) live in the companion
 * `orchestrator-multi-project-failure-isolation.scenario.ts`.
 */

import type { Action, Plugin } from "@elizaos/core";
import { projectWorldId, type UUID } from "@elizaos/core";
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

const PORTFOLIO_PLUGIN_NAME = "orchestrator-multi-project-portfolio-scenario";
const ORCHESTRATOR_MULTI_PROJECT_PORTFOLIO =
  "ORCHESTRATOR_MULTI_PROJECT_PORTFOLIO";

const AGENT_ID = "aa010000-0000-4000-8000-000000000001" as UUID;
const CAP = 8;
/** Per-project task counts: 3 projects, 5–15 tasks each, 18 total. */
const PROJECT_PLAN: Array<{ name: string; tasks: number }> = [
  { name: "checkout-service", tasks: 6 },
  { name: "web-dashboard", tasks: 5 },
  { name: "mobile-app", tasks: 7 },
];
const TOTAL = PROJECT_PLAN.reduce((sum, p) => sum + p.tasks, 0);

type PerProjectResult = {
  projectId: string;
  name: string;
  taskIds: string[];
  statuses: Record<string, string>;
  doneCount: number;
};

type PortfolioResult = {
  summary: string;
  cap: number;
  totalTasks: number;
  activeAtCap: number;
  queuedAtCap: number;
  workerHighWaterMark: number;
  judgeVerdicts: number;
  sessionsPerTask: Record<string, number>;
  /** Session ids found on a task doc that belong to another task — must be []. */
  foreignRoutes: string[];
  /** Sub-agent progress messages that carry another project's marker — []. */
  crossProjectMessages: string[];
  /** Sessions whose spawn workdir did not match the bound project localPath. */
  workdirViolations: string[];
  worldBindingViolations: string[];
  listFilterViolations: string[];
  perProject: PerProjectResult[];
};

function portfolioData(ctx: ScenarioContext): PortfolioResult | null {
  const action = ctx.actionsCalled.find(
    (c) => c.actionName === ORCHESTRATOR_MULTI_PROJECT_PORTFOLIO,
  );
  const data = action?.result?.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as PortfolioResult)
    : null;
}

async function runPortfolio(): Promise<PortfolioResult> {
  const restoreGates = applyScenarioEnv({
    ELIZA_ACP_ADMISSION_QUEUE: "1",
    ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY: "1",
    ELIZA_ORCHESTRATOR_WATCHDOG: "0",
    ELIZA_ORCHESTRATOR_INDEPENDENT_VERIFY: "0",
  });
  const { projects, restoreEnv } = registerScenarioProjects(
    "eliza-orch-portfolio",
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
    // ── Create 18 tasks, round-robin interleaved across the three projects, so
    // the store never sees one project's tasks as a contiguous block. ─────────
    const taskProject = new Map<string, ScenarioProject>();
    const taskTitle = new Map<string, string>();
    const perProjectIds = new Map<string, string[]>(
      projects.map((p) => [p.id, []]),
    );
    const maxPerProject = Math.max(...PROJECT_PLAN.map((p) => p.tasks));
    for (let round = 0; round < maxPerProject; round++) {
      for (const [index, plan] of PROJECT_PLAN.entries()) {
        if (round >= plan.tasks) continue;
        const project = projects[index];
        const title = `${plan.name} task ${round + 1}`;
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
        perProjectIds.get(project.id)?.push(detail.id);
      }
    }

    // ── Binding proof: projectId + project-derived memory world per record. ──
    const worldBindingViolations: string[] = [];
    for (const [taskId, project] of taskProject) {
      const doc = await store.getTask(taskId);
      const expectedWorld = projectWorldId(AGENT_ID, project.id);
      if (doc?.task.projectId !== project.id) {
        worldBindingViolations.push(
          `${taskId}: projectId=${doc?.task.projectId ?? "(none)"} expected ${project.id}`,
        );
      } else if (doc.task.worldId !== expectedWorld) {
        worldBindingViolations.push(
          `${taskId}: worldId=${doc.task.worldId ?? "(none)"} expected ${expectedWorld}`,
        );
      }
    }

    // ── List/filter proof BEFORE the run: exact per-project sets. ────────────
    const listFilterViolations: string[] = [];
    for (const project of projects) {
      const listed = await service.listTasks({ projectId: project.id });
      const expected = new Set(perProjectIds.get(project.id));
      if (
        listed.length !== expected.size ||
        listed.some((t) => !expected.has(t.id))
      ) {
        listFilterViolations.push(
          `pre-run ${project.name}: listed ${listed.length} (${listed
            .map((t) => t.id)
            .join(",")}), expected ${expected.size}`,
        );
      }
    }
    const allListed = await service.listTasks({});
    if (allListed.length !== TOTAL) {
      listFilterViolations.push(
        `pre-run unfiltered: listed ${allListed.length}, expected ${TOTAL}`,
      );
    }

    // ── Spawn all 18 against the 8-worker cap (interleaved order). Over-cap
    // spawns park in the real admission queue. ────────────────────────────────
    const interleavedIds = [...taskProject.keys()];
    for (const taskId of interleavedIds) {
      await service.spawnAgentForTask(taskId, {});
    }
    const snapshot = await service.getAdmissionSnapshot();
    const activeAtCap = acp.readySessions().length;
    const queuedAtCap = snapshot.queueDepth;
    if (activeAtCap !== CAP || queuedAtCap !== TOTAL - CAP) {
      throw new Error(
        `expected ${CAP} active + ${TOTAL - CAP} queued at cap, saw ${activeAtCap}/${queuedAtCap}`,
      );
    }

    // ── Waves: interleave progress events across every live project's session,
    // then complete them with pasted test output; each completion frees a slot
    // and the admission queue drains the next parked task. ───────────────────
    const workdirViolations: string[] = [];
    const validatedSessions = new Set<string>();
    for (let guard = 0; guard < TOTAL * 4; guard++) {
      const ready = acp
        .readySessions()
        .filter((s) => !validatedSessions.has(s.id));
      if (ready.length === 0) {
        const depth = (await service.getAdmissionSnapshot()).queueDepth;
        if (depth === 0) break;
        await waitUntil(
          () => acp.readySessions().some((s) => !validatedSessions.has(s.id)),
          "admission drain to dispatch a parked task",
        );
        continue;
      }
      // Interleaved progress first — every ready session (spanning all three
      // projects) reports activity before any of them completes.
      for (const session of ready) {
        const taskId = String(session.metadata?.taskId ?? "");
        const project = taskProject.get(taskId);
        if (!project) throw new Error(`session ${session.id} has no task`);
        if (session.workdir !== project.localPath) {
          workdirViolations.push(
            `${session.id}: workdir ${session.workdir} != ${project.localPath}`,
          );
        }
        validatedSessions.add(session.id);
        await waitForTask(
          store,
          taskId,
          (doc) => doc.task.status === "active",
          `task ${taskId} active after spawn`,
        );
        acp.emit(session.id, "tool_running", {
          toolCall: { title: `bun test ${project.name}` },
        });
        acp.emit(session.id, "message", {
          text: `progress ${project.name}: ${taskTitle.get(taskId)}`,
        });
      }
      // Then complete the wave with concrete proof the judge demands.
      for (const session of ready) {
        const taskId = String(session.metadata?.taskId ?? "");
        const project = taskProject.get(taskId);
        acp.complete(
          session.id,
          `Done: ${taskTitle.get(taskId)}. Proof: Tests 3 passed (3) in ${project?.name}.`,
        );
        await waitForTask(
          store,
          taskId,
          (doc) =>
            doc.task.status === "done" &&
            doc.events.some((e) => e.eventType === "validation_passed"),
          `task ${taskId} validated done`,
        );
      }
    }
    await waitUntil(
      async () => (await service.getAdmissionSnapshot()).queueDepth === 0,
      "admission queue drained to zero",
    );

    // ── Final structural proof across all 18 tasks. ──────────────────────────
    const sessionsPerTask: Record<string, number> = {};
    const foreignRoutes: string[] = [];
    const crossProjectMessages: string[] = [];
    const perProject: PerProjectResult[] = [];
    for (const project of projects) {
      const ids = perProjectIds.get(project.id) ?? [];
      const statuses: Record<string, string> = {};
      for (const taskId of ids) {
        const doc = await store.getTask(taskId);
        if (!doc) throw new Error(`task ${taskId} missing at final read`);
        statuses[taskId] = doc.task.status;
        sessionsPerTask[taskId] = doc.sessions.length;
        foreignRoutes.push(...foreignEventSessions(doc));
        for (const message of doc.messages) {
          if (
            message.senderKind === "sub_agent" &&
            message.content.startsWith("progress ") &&
            !message.content.startsWith(`progress ${project.name}`)
          ) {
            crossProjectMessages.push(`${taskId}: ${message.content}`);
          }
        }
      }
      const listed = await service.listTasks({ projectId: project.id });
      const doneCount = listed.filter((t) => t.status === "done").length;
      if (listed.length !== ids.length || doneCount !== ids.length) {
        listFilterViolations.push(
          `post-run ${project.name}: ${doneCount}/${listed.length} done, expected ${ids.length}/${ids.length}`,
        );
      }
      perProject.push({
        projectId: project.id,
        name: project.name,
        taskIds: ids,
        statuses,
        doneCount,
      });
    }
    const doneTotal = perProject.reduce((sum, p) => sum + p.doneCount, 0);
    const drops = Object.entries(sessionsPerTask).filter(([, n]) => n !== 1);
    if (drops.length > 0) {
      throw new Error(
        `expected exactly one session per task, saw ${JSON.stringify(sessionsPerTask)}`,
      );
    }

    return {
      summary:
        `orchestrated 3 projects simultaneously (checkout-service 6, web-dashboard 5, mobile-app 7): ` +
        `${doneTotal}/${TOTAL} tasks done end-to-end (create → spawn → progress → verify → complete), ` +
        `${activeAtCap} active + ${queuedAtCap} queued at the ${CAP}-worker cap with high-water mark ${acp.workerHighWaterMark}, ` +
        `${judgePrompts.length} evidence-grounded verifier verdicts, per-project list filters exact, ` +
        `zero foreign event routes and zero cross-project message bleed`,
      cap: CAP,
      totalTasks: TOTAL,
      activeAtCap,
      queuedAtCap,
      workerHighWaterMark: acp.workerHighWaterMark,
      judgeVerdicts: judgePrompts.length,
      sessionsPerTask,
      foreignRoutes,
      crossProjectMessages,
      workdirViolations,
      worldBindingViolations,
      listFilterViolations,
      perProject,
    };
  } finally {
    await service.stop();
    restoreEnv();
    restoreGates();
  }
}

function portfolioPlugin(): Plugin {
  const action: Action = {
    name: ORCHESTRATOR_MULTI_PROJECT_PORTFOLIO,
    description:
      "Drive three registered projects (18 tasks) through the full orchestrator lifecycle simultaneously: project binding, per-project list filters, cap-respecting concurrency, interleaved event routing, and evidence-verified completion.",
    validate: async () => true,
    handler: async () => {
      const result = await runPortfolio();
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
    name: PORTFOLIO_PLUGIN_NAME,
    description:
      "Deterministic multi-project orchestration portfolio scenario.",
    actions: [action],
  };
}

export default scenario({
  id: "orchestrator-multi-project-portfolio",
  lane: "pr-deterministic",
  title:
    "Orchestrator manages 3 projects simultaneously: 18 tasks end-to-end with project binding, filters, cap-respecting concurrency, and verified completion",
  domain: "agent-orchestrator",
  tags: [
    "orchestrator",
    "multi-project",
    "multi-task",
    "concurrency",
    "pr",
    "deterministic",
  ],
  isolation: "shared-runtime",
  requires: {
    plugins: [PORTFOLIO_PLUGIN_NAME],
  },
  seed: [
    {
      type: "custom",
      name: "register multi-project portfolio scenario action",
      apply: async (ctx) => {
        const runtime = ctx.runtime as {
          registerPlugin?: (plugin: Plugin) => Promise<void>;
          plugins?: Array<{ name?: string }>;
        };
        const already = runtime.plugins?.some(
          (plugin) => plugin.name === PORTFOLIO_PLUGIN_NAME,
        );
        if (!already) {
          await runtime.registerPlugin?.(portfolioPlugin());
        }
        registerCalibratedJudgeFixture(
          ctx.runtime as Parameters<typeof registerCalibratedJudgeFixture>[0],
          ORCHESTRATOR_MULTI_PROJECT_PORTFOLIO,
          [
            "orchestrated 3 projects simultaneously",
            "checkout-service 6",
            "web-dashboard 5",
            "mobile-app 7",
            `${TOTAL}/${TOTAL} tasks done`,
          ],
        );
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "action",
      name: "manage three projects with 18 tasks simultaneously",
      text: "Run three projects at once — checkout-service, web-dashboard, and mobile-app — and drive every task to a verified completion.",
      actionName: ORCHESTRATOR_MULTI_PROJECT_PORTFOLIO,
      responseIncludesAny: [
        "orchestrated 3 projects simultaneously",
        "tasks done end-to-end",
      ],
      assertTurn: (turn) => {
        const data = turn.actionsCalled[0]?.result?.data as
          | PortfolioResult
          | undefined;
        if (!data) return "portfolio scenario produced no data";
        if (data.activeAtCap !== CAP || data.queuedAtCap !== TOTAL - CAP) {
          return `expected ${CAP} active + ${TOTAL - CAP} queued at cap, saw ${data.activeAtCap}/${data.queuedAtCap}`;
        }
        if (data.workerHighWaterMark !== CAP) {
          return `expected worker high-water mark ${CAP}, saw ${data.workerHighWaterMark}`;
        }
        return undefined;
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: ORCHESTRATOR_MULTI_PROJECT_PORTFOLIO,
      status: "success",
    },
    {
      type: "custom",
      name: "3 projects x 18 tasks: bindings, filters, routing, concurrency, and verified completion all hold",
      predicate: (ctx) => {
        const data = portfolioData(ctx);
        if (!data) return "portfolio scenario produced no data";
        if (data.perProject.length !== 3) {
          return `expected 3 projects, saw ${data.perProject.length}`;
        }
        const doneTotal = data.perProject.reduce(
          (sum, p) => sum + p.doneCount,
          0,
        );
        if (doneTotal !== TOTAL) {
          return `expected ${TOTAL} tasks done, saw ${doneTotal}`;
        }
        for (const [label, violations] of [
          ["worldBinding", data.worldBindingViolations],
          ["listFilter", data.listFilterViolations],
          ["workdir", data.workdirViolations],
          ["foreignRoutes", data.foreignRoutes],
          ["crossProjectMessages", data.crossProjectMessages],
        ] as const) {
          if (violations.length > 0) {
            return `${label} violations: ${violations.join(" | ").slice(0, 400)}`;
          }
        }
        if (data.judgeVerdicts !== TOTAL) {
          return `expected ${TOTAL} verifier verdicts (one per task), saw ${data.judgeVerdicts}`;
        }
        const badCounts = Object.entries(data.sessionsPerTask).filter(
          ([, n]) => n !== 1,
        );
        if (badCounts.length > 0) {
          return `expected one session per task, saw ${JSON.stringify(badCounts)}`;
        }
        return undefined;
      },
    },
    {
      type: "judgeRubric",
      name: "judge verifies simultaneous multi-project orchestration",
      minimumScore: 0.95,
      rubric:
        "Pass only if the trace shows three projects orchestrated simultaneously with 18 tasks driven end-to-end (create, spawn, progress, verify, complete), an 8-worker cap respected via admission queueing, exact per-project list filters, and zero cross-project event routing.",
    },
  ],
});
