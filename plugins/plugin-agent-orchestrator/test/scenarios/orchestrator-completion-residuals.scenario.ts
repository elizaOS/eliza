/**
 * orchestrator-completion-residuals — a sub-agent that claims `task_complete`
 * while its REAL git workspace still holds uncommitted work must NOT reach
 * `done`: the completion-residual gate re-engages it, and only after the work
 * is committed+pushed does the task verify done.
 *
 * The residual gate itself lands in a separate workstream (different
 * worktree); this scenario PROBES for it and SKIPS VISIBLY when it is absent —
 * the action succeeds with a loud "SKIPPED (gate not present)" summary and
 * `data.skipped=true`, so the lane stays green without pretending the gate was
 * proven. Once the gate module ships, the probe finds it and the full drive
 * (real OrchestratorTaskService + real git repo + scripted ACP boundary, no
 * mocked router/service/evaluator) becomes the enforced path.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action, IAgentRuntime, Plugin } from "@elizaos/core";
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store";
import {
  makeGrillingRuntime,
  makeScriptedAcp,
  OrchestratorTaskService,
  waitFor,
} from "./_helpers/orchestrator-grilling-harness";

const PLUGIN_NAME = "orchestrator-completion-residuals-scenario";
const ACTION_NAME = "ORCHESTRATOR_COMPLETION_RESIDUALS";

type ResidualsScenarioResult = {
  summary: string;
  skipped: boolean;
  skipReason?: string;
  statusAfterDirtyClaim?: string;
  reEngaged?: boolean;
  finalStatus?: string;
};

function residualsScenarioData(
  ctx: ScenarioContext,
): ResidualsScenarioResult | null {
  const action = ctx.actionsCalled.find(
    (candidate) => candidate.actionName === ACTION_NAME,
  );
  const data = action?.result?.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as ResidualsScenarioResult)
    : null;
}

/**
 * Probe for the workstream-B completion-residual gate. Two signals count:
 * a dedicated module under src/services, or a residual/dirty-workspace hook on
 * the task service itself. Absent both, the gate has not landed in this tree.
 */
async function probeResidualGate(): Promise<{
  present: boolean;
  detail: string;
}> {
  const moduleCandidates = [
    "../../src/services/completion-residuals.js",
    "../../src/services/completion-residual-gate.js",
    "../../src/services/completion-gate.js",
    "../../src/services/workspace-residuals.js",
  ];
  for (const candidate of moduleCandidates) {
    try {
      await import(candidate);
      return { present: true, detail: `module ${candidate}` };
    } catch {
      // Candidate not present — keep probing. This is the probe itself, not a
      // swallowed failure: absence is the signal being measured.
    }
  }
  const hookPattern = /residual|dirtyworkspace|uncommitted/i;
  const hook = Object.getOwnPropertyNames(
    OrchestratorTaskService.prototype,
  ).find((name) => hookPattern.test(name));
  if (hook) return { present: true, detail: `service hook ${hook}` };
  return {
    present: false,
    detail:
      "no completion-residual module or service hook found (workstream B not landed in this tree)",
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function runResidualsCheck(
  baseRuntime: IAgentRuntime,
): Promise<ResidualsScenarioResult> {
  const probe = await probeResidualGate();
  if (!probe.present) {
    return {
      summary: `SKIPPED — completion-residual gate not present: ${probe.detail}. This scenario proves nothing until the gate lands; it will enforce automatically once the probe finds it.`,
      skipped: true,
      skipReason: probe.detail,
    };
  }

  // ── Full drive (runs once the gate exists). ──────────────────────────────
  const bare = mkdtempSync(join(tmpdir(), "residuals-bare-"));
  const work = mkdtempSync(join(tmpdir(), "residuals-work-"));
  try {
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
    execFileSync("git", ["clone", "-q", bare, work]);
    git(work, "config", "user.email", "residuals@test.local");
    git(work, "config", "user.name", "Residuals");
    writeFileSync(join(work, "README.md"), "# seed\n");
    git(work, "add", "README.md");
    git(work, "commit", "-q", "-m", "seed");
    git(work, "push", "-q", "-u", "origin", "main");

    const store = new OrchestratorTaskStore({ backend: "memory" });
    const detail = await store.createTask({
      title: "Residuals task",
      goal: "implement the widget and leave a clean workspace",
      acceptanceCriteria: ["tests pass"],
      roomId: "scenario-room-residuals",
      worldId: "scenario-world",
    });
    const taskId = detail.task.id;
    const sessionId = "residuals-sess-1";
    const now = Date.now();
    await store.addSession({
      id: "row-1",
      taskId,
      sessionId,
      framework: "opencode",
      label: "Ada",
      originalTask: "implement the widget",
      workdir: work,
      status: "ready",
      decisionCount: 0,
      autoResolvedCount: 0,
      registeredAt: now,
      lastActivityAt: now,
      idleCheckCount: 0,
      taskDelivered: false,
      lastSeenDecisionIndex: 0,
      spawnedAt: now,
      retryCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      costUsd: 0,
      usageState: "unavailable",
      metadata: { workdir: work },
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });
    await store.updateTask(taskId, { status: "active" });

    const acp = makeScriptedAcp();
    // Verifier always passes: with the judge satisfied, ONLY the residual gate
    // can hold the task back — the discriminating variable is workspace state.
    const alwaysPassVerifier = async () =>
      JSON.stringify({ passed: true, summary: "ok", missing: [] });
    const runtime = makeGrillingRuntime(
      baseRuntime,
      acp.service,
      alwaysPassVerifier,
    );
    const service = new OrchestratorTaskService(runtime, { store });
    await service.start();
    try {
      // Round 1: DIRTY workspace + task_complete claim → must not go done.
      writeFileSync(join(work, "widget.ts"), "export const widget = 1;\n");
      acp.emit(sessionId, "task_complete", {
        response: "Done — implemented the widget. Tests 3 passed (3).",
      });
      const reEngaged = await waitFor(() => acp.sent.length > 0, {
        timeoutMs: 10_000,
      });
      const statusAfterDirtyClaim =
        (await store.getTask(taskId))?.task.status ?? "";
      if (statusAfterDirtyClaim === "done") {
        throw new Error(
          "task reached done while the workspace still had uncommitted work",
        );
      }
      if (!reEngaged) {
        throw new Error(
          "the residual gate never re-engaged the sub-agent about the dirty workspace",
        );
      }

      // Round 2: the fake agent commits + pushes, then re-claims → done.
      git(work, "add", "-A");
      git(work, "commit", "-q", "-m", "feat: widget");
      git(work, "push", "-q", "origin", "main");
      acp.emit(sessionId, "task_complete", {
        response: "Committed and pushed. Tests 3 passed (3).",
      });
      const done = await waitFor(
        async () => (await store.getTask(taskId))?.task.status === "done",
        { timeoutMs: 10_000 },
      );
      const finalStatus = (await store.getTask(taskId))?.task.status ?? "";
      if (!done) {
        throw new Error(
          `task did not reach done after the workspace was cleaned; status=${finalStatus}`,
        );
      }
      return {
        summary: `residual gate (${probe.detail}) blocked a dirty-workspace completion (status=${statusAfterDirtyClaim}), re-engaged the sub-agent, and verified done after commit+push`,
        skipped: false,
        statusAfterDirtyClaim,
        reEngaged,
        finalStatus,
      };
    } finally {
      await service.stop().catch(() => undefined);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
}

let capturedRuntime: IAgentRuntime | undefined;

function residualsScenarioPlugin(): Plugin {
  const action: Action = {
    name: ACTION_NAME,
    description:
      "Drive the completion-residual gate: a dirty-workspace task_complete is blocked and re-engaged; a clean workspace verifies done. Skips visibly while the gate has not landed.",
    validate: async () => true,
    handler: async (runtime) => {
      const result = await runResidualsCheck(
        (runtime as IAgentRuntime | undefined) ??
          capturedRuntime ??
          ({} as IAgentRuntime),
      );
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
    name: PLUGIN_NAME,
    description:
      "Completion-residuals gate scenario action (skip-if-absent probe for the workstream-B gate).",
    actions: [action],
  };
}

export default scenario({
  id: "orchestrator-completion-residuals",
  lane: "pr-deterministic",
  title:
    "Orchestrator blocks dirty-workspace completions until the work is committed and pushed",
  domain: "agent-orchestrator",
  tags: ["orchestrator", "residuals", "completion", "pr", "deterministic"],
  isolation: "shared-runtime",
  requires: {
    plugins: [PLUGIN_NAME],
  },
  seed: [
    {
      type: "custom",
      name: "register completion-residuals scenario action",
      apply: async (ctx) => {
        capturedRuntime = ctx.runtime as IAgentRuntime;
        const runtime = ctx.runtime as {
          registerPlugin?: (plugin: Plugin) => Promise<void>;
          plugins?: Array<{ name?: string }>;
        };
        const already = runtime.plugins?.some(
          (plugin) => plugin.name === PLUGIN_NAME,
        );
        if (!already) await runtime.registerPlugin?.(residualsScenarioPlugin());
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "action",
      name: "claim completion on a dirty workspace, then on a clean one",
      text: "A sub-agent claims task_complete while its git workspace is dirty.",
      actionName: ACTION_NAME,
      responseIncludesAny: ["residual gate", "SKIPPED"],
      assertTurn: (turn) => {
        const data = turn.actionsCalled[0]?.result?.data as
          | ResidualsScenarioResult
          | undefined;
        if (!data) return "residuals scenario produced no data";
        if (data.skipped) return undefined; // visible skip; summary carries why
        if (data.finalStatus !== "done") {
          return `expected the cleaned workspace to verify done, saw ${data.finalStatus}`;
        }
        return undefined;
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: ACTION_NAME,
      status: "success",
    },
    {
      type: "custom",
      name: "dirty completion blocked, clean completion verified done (or visibly skipped)",
      predicate: (ctx) => {
        const data = residualsScenarioData(ctx);
        if (!data) return "residuals scenario produced no data";
        if (data.skipped) {
          // Visible skip: summary already says SKIPPED + why. Fail instead if
          // the reason went missing — silence is not an acceptable skip.
          return data.skipReason
            ? undefined
            : "scenario skipped without a recorded reason";
        }
        if (data.statusAfterDirtyClaim === "done") {
          return "dirty-workspace completion reached done — the gate did not block it";
        }
        if (!data.reEngaged) return "sub-agent was never re-engaged";
        if (data.finalStatus !== "done") {
          return `clean completion did not verify done: ${data.finalStatus}`;
        }
        return undefined;
      },
    },
  ],
});
