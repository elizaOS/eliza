/**
 * Live-lane proof for issue #14368 AC4 (task-filter half): a real LLM, asked to
 * "show me only my overdue tasks", must route through the semantic
 * `SCHEDULED_TASKS action=list dueWindow=overdue` verb rather than the
 * generic synthetic-DOM bridge (`VIEWS agent-fill`/`agent-click`). The
 * due-window verb was added by PR #14531; this scenario is the outstanding
 * live-model trajectory that closes the issue.
 *
 * The seed writes two `once` reminders directly through the same
 * ScheduledTask runner the action reads (one an hour overdue, one due
 * tomorrow) so the overdue window has an exact expected membership. No Tasks
 * view is mounted, so the synthetic-DOM path is structurally unavailable — the
 * only way to satisfy the request is the discoverable semantic action, and the
 * final check asserts no `VIEWS`/`agent-*` capability was used. Needs live
 * model credentials (live-only lane).
 */
import type { IAgentRuntime } from "@elizaos/core";
import {
  getScheduledTaskRunner,
  type ScheduledTask,
} from "@elizaos/plugin-scheduling";
import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

const OVERDUE_INSTRUCTIONS = "review the overdue quarterly report";
const FUTURE_INSTRUCTIONS = "prep tomorrow's standup notes";
const FILTER_TEXT = "Show me only my overdue scheduled tasks.";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A selected action's arguments arrive wrapped in a `{ parameters, ... }`
 * envelope from the planner; unwrap one level when present so callers assert
 * against the concrete op fields the handler received.
 */
function actionParams(action: CapturedAction): JsonRecord {
  const envelope = isRecord(action.parameters) ? action.parameters : {};
  return isRecord(envelope.parameters) ? envelope.parameters : envelope;
}

function findAction(
  execution: ScenarioTurnExecution,
  name: string,
): CapturedAction | undefined {
  return execution.actionsCalled.find(
    (candidate) => candidate.actionName === name,
  );
}

function seedOverdueAndFutureTasks(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as IAgentRuntime;
  const runner = getScheduledTaskRunner(runtime, { agentId: runtime.agentId });
  const now = Date.now();
  const overdueIso = new Date(now - 60 * 60 * 1000).toISOString();
  const futureIso = new Date(now + 24 * 60 * 60 * 1000).toISOString();

  const seedOne = (
    promptInstructions: string,
    atIso: string,
    idempotencyKey: string,
  ): Promise<ScheduledTask> =>
    runner.schedule({
      kind: "reminder",
      promptInstructions,
      trigger: { kind: "once", atIso },
      priority: "medium",
      respectsGlobalPause: false,
      source: "user_chat",
      createdBy: runtime.agentId,
      ownerVisible: true,
      idempotencyKey,
    });

  return Promise.all([
    seedOne(OVERDUE_INSTRUCTIONS, overdueIso, "live-14368-overdue-report"),
    seedOne(FUTURE_INSTRUCTIONS, futureIso, "live-14368-future-standup"),
  ]).then(() => undefined);
}

function noSyntheticDomFallback(ctx: ScenarioContext): string | undefined {
  for (const call of ctx.actionsCalled) {
    if (call.actionName === "VIEWS") {
      return `expected no VIEWS synthetic-DOM fallback, saw VIEWS with ${JSON.stringify(actionParams(call))}`;
    }
    const capability = actionParams(call).capability;
    if (capability === "agent-fill" || capability === "agent-click") {
      return `expected no agent-fill/agent-click, saw capability=${String(capability)}`;
    }
  }
  return undefined;
}

function expectOverdueFilterTurn(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = findAction(execution, "SCHEDULED_TASKS");
  if (!action) {
    const seen =
      execution.actionsCalled.map((c) => c.actionName).join(", ") || "none";
    return `expected SCHEDULED_TASKS action (semantic verb), saw ${seen}`;
  }
  const params = actionParams(action);
  if (params.action !== "list") {
    return `expected action=list, saw ${String(params.action)}`;
  }
  if (params.dueWindow !== "overdue") {
    return `expected dueWindow=overdue, saw ${String(params.dueWindow)}`;
  }
  if (action.result?.success !== true) {
    return `expected ActionResult.success=true, saw ${JSON.stringify(action.result)}`;
  }
  const data = isRecord(action.result.data) ? action.result.data : null;
  if (!data) {
    return `expected ActionResult.data object, saw ${JSON.stringify(action.result.data)}`;
  }
  if (data.dueWindow !== "overdue") {
    return `expected data.dueWindow=overdue, saw ${String(data.dueWindow)}`;
  }
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const instructions = tasks
    .map((task) =>
      isRecord(task) && typeof task.promptInstructions === "string"
        ? task.promptInstructions
        : null,
    )
    .filter((value): value is string => value !== null);
  if (!instructions.includes(OVERDUE_INSTRUCTIONS)) {
    return `expected overdue task in filtered list, saw ${JSON.stringify(instructions)}`;
  }
  if (instructions.includes(FUTURE_INSTRUCTIONS)) {
    return `expected the future task excluded from the overdue window, saw ${JSON.stringify(instructions)}`;
  }
  return noSyntheticDomFallback({ actionsCalled: execution.actionsCalled });
}

export default scenario({
  id: "live-lifeops-task-filter-due-window",
  lane: "live-only",
  title: "Live task-filter routes to SCHEDULED_TASKS dueWindow, not agent-fill",
  domain: "lifeops",
  tags: ["live", "lifeops", "scheduled-tasks", "views", "task-filter"],
  isolation: "shared-runtime",
  requires: {
    plugins: [
      "@elizaos/plugin-scheduling",
      "@elizaos/plugin-personal-assistant",
    ],
  },
  seed: [
    {
      type: "custom",
      name: "seed one overdue + one future reminder through the runner",
      apply: seedOverdueAndFutureTasks,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "client_chat",
      title: "Live LifeOps Task Filter",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "owner asks for only overdue tasks",
      text: FILTER_TEXT,
      expectedActions: ["SCHEDULED_TASKS"],
      assertTurn: expectOverdueFilterTurn,
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "SCHEDULED_TASKS",
      status: "success",
      minCount: 1,
    },
    {
      type: "selectedActionArguments",
      actionName: "SCHEDULED_TASKS",
      includesAll: [/"action":"list"/, /"dueWindow":"overdue"/],
    },
    {
      type: "custom",
      name: "no synthetic-DOM (VIEWS/agent-fill) fallback was used",
      predicate: noSyntheticDomFallback,
    },
  ],
});
