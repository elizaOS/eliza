import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const scenarioMetadata = {
  scenario: "deterministic-lifeops-scheduled-tasks",
};

const createParameters = {
  action: "create",
  kind: "reminder",
  promptInstructions: "drink a glass of water",
  trigger: { kind: "manual" },
  priority: "medium",
  idempotencyKey: "deterministic-lifeops-scheduled-tasks-water",
  respectsGlobalPause: false,
  ownerVisible: true,
  source: "user_chat",
  metadata: scenarioMetadata,
};

const listParameters = {
  action: "list",
  kind: "reminder",
  status: "scheduled",
  ownerVisibleOnly: true,
};

const getParameters = {
  action: "get",
  taskId: "__created_task_id_unset__",
};

const snoozeParameters = {
  action: "snooze",
  taskId: "__created_task_id_unset__",
  minutes: 15,
};

const completeParameters = {
  action: "complete",
  taskId: "__created_task_id_unset__",
  reason: "scenario user completed it",
};

const historyParameters = {
  action: "history",
  taskId: "__created_task_id_unset__",
  limit: 10,
};

let createdTaskId: string | null = null;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function expectEqual(actual: unknown, expected: unknown, label: string) {
  const actualJson = stableStringify(actual);
  const expectedJson = stableStringify(expected);
  return actualJson === expectedJson
    ? undefined
    : `expected ${label}=${expectedJson}, saw ${actualJson}`;
}

function firstAction(
  execution: ScenarioTurnExecution,
): CapturedAction | string {
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === "SCHEDULED_TASKS",
  );
  return (
    action ??
    `expected SCHEDULED_TASKS action, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`
  );
}

function actionData(action: CapturedAction): JsonRecord | string {
  const data = action.result?.data;
  return isRecord(data)
    ? data
    : `expected ActionResult.data object, saw ${stableStringify(data)}`;
}

function taskFromData(data: JsonRecord): JsonRecord | string {
  const task = data.task;
  return isRecord(task)
    ? task
    : `expected ActionResult.data.task object, saw ${stableStringify(task)}`;
}

function taskState(task: JsonRecord): JsonRecord | string {
  const state = task.state;
  return isRecord(state)
    ? state
    : `expected task.state object, saw ${stableStringify(state)}`;
}

function exactParameters(
  action: CapturedAction,
  expectedParameters: JsonRecord,
): string | undefined {
  return expectEqual(
    action.parameters,
    { parameters: expectedParameters },
    "handler options",
  );
}

function expectSuccess(action: CapturedAction): string | undefined {
  return action.result?.success === true
    ? undefined
    : `expected ActionResult.success=true, saw ${stableStringify(action.result)}`;
}

function expectCreatedTurn(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = firstAction(execution);
  if (typeof action === "string") return action;
  const parameterFailure = exactParameters(action, createParameters);
  if (parameterFailure) return parameterFailure;
  const successFailure = expectSuccess(action);
  if (successFailure) return successFailure;

  const data = actionData(action);
  if (typeof data === "string") return data;
  if (data.subaction !== "create") {
    return `expected data.subaction=create, saw ${String(data.subaction)}`;
  }
  const task = taskFromData(data);
  if (typeof task === "string") return task;
  const state = taskState(task);
  if (typeof state === "string") return state;
  if (typeof task.taskId !== "string" || task.taskId.length === 0) {
    return `expected task.taskId string, saw ${stableStringify(task.taskId)}`;
  }
  if (task.kind !== "reminder") {
    return `expected task.kind=reminder, saw ${String(task.kind)}`;
  }
  if (task.promptInstructions !== createParameters.promptInstructions) {
    return `expected task.promptInstructions=${createParameters.promptInstructions}, saw ${String(task.promptInstructions)}`;
  }
  const trigger = isRecord(task.trigger) ? task.trigger : null;
  if (trigger?.kind !== "manual") {
    return `expected task.trigger.kind=manual, saw ${stableStringify(task.trigger)}`;
  }
  if (state.status !== "scheduled") {
    return `expected task.state.status=scheduled, saw ${String(state.status)}`;
  }
  if (task.idempotencyKey !== createParameters.idempotencyKey) {
    return `expected task.idempotencyKey=${createParameters.idempotencyKey}, saw ${String(task.idempotencyKey)}`;
  }
  createdTaskId = task.taskId;
  getParameters.taskId = createdTaskId;
  snoozeParameters.taskId = createdTaskId;
  completeParameters.taskId = createdTaskId;
  historyParameters.taskId = createdTaskId;
  return undefined;
}

function expectTaskStatusTurn(
  execution: ScenarioTurnExecution,
  expectedParameters: JsonRecord,
  expectedSubaction: string,
  expectedStatus: string,
): string | undefined {
  const action = firstAction(execution);
  if (typeof action === "string") return action;
  const parameterFailure = exactParameters(action, expectedParameters);
  if (parameterFailure) return parameterFailure;
  const successFailure = expectSuccess(action);
  if (successFailure) return successFailure;
  const data = actionData(action);
  if (typeof data === "string") return data;
  if (data.subaction !== expectedSubaction) {
    return `expected data.subaction=${expectedSubaction}, saw ${String(data.subaction)}`;
  }
  const task = taskFromData(data);
  if (typeof task === "string") return task;
  if (task.taskId !== createdTaskId) {
    return `expected task.taskId=${String(createdTaskId)}, saw ${String(task.taskId)}`;
  }
  const state = taskState(task);
  if (typeof state === "string") return state;
  if (state.status !== expectedStatus) {
    return `expected task.state.status=${expectedStatus}, saw ${String(state.status)}`;
  }
  return undefined;
}

function expectListTurn(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = firstAction(execution);
  if (typeof action === "string") return action;
  const parameterFailure = exactParameters(action, listParameters);
  if (parameterFailure) return parameterFailure;
  const successFailure = expectSuccess(action);
  if (successFailure) return successFailure;
  const data = actionData(action);
  if (typeof data === "string") return data;
  if (data.subaction !== "list") {
    return `expected data.subaction=list, saw ${String(data.subaction)}`;
  }
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const task = tasks.find(
    (candidate): candidate is JsonRecord =>
      isRecord(candidate) && candidate.taskId === createdTaskId,
  );
  if (!task) {
    return `expected list to include created task ${String(createdTaskId)}, saw ${stableStringify(data.tasks)}`;
  }
  const state = taskState(task);
  if (typeof state === "string") return state;
  return state.status === "scheduled"
    ? undefined
    : `expected listed task.state.status=scheduled, saw ${String(state.status)}`;
}

function expectSnoozeTurn(
  execution: ScenarioTurnExecution,
): string | undefined {
  const statusFailure = expectTaskStatusTurn(
    execution,
    snoozeParameters,
    "snooze",
    "scheduled",
  );
  if (statusFailure) return statusFailure;
  const action = firstAction(execution);
  if (typeof action === "string") return action;
  const data = actionData(action);
  if (typeof data === "string") return data;
  const task = taskFromData(data);
  if (typeof task === "string") return task;
  const state = taskState(task);
  if (typeof state === "string") return state;
  return typeof state.lastDecisionLog === "string" &&
    state.lastDecisionLog.startsWith("snoozed until ")
    ? undefined
    : `expected snooze lastDecisionLog, saw ${stableStringify(state.lastDecisionLog)}`;
}

function expectHistoryTurn(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = firstAction(execution);
  if (typeof action === "string") return action;
  const parameterFailure = exactParameters(action, historyParameters);
  if (parameterFailure) return parameterFailure;
  const successFailure = expectSuccess(action);
  if (successFailure) return successFailure;
  const data = actionData(action);
  if (typeof data === "string") return data;
  if (data.subaction !== "history") {
    return `expected data.subaction=history, saw ${String(data.subaction)}`;
  }
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const transitions = entries
    .map((entry) =>
      isRecord(entry) && typeof entry.transition === "string"
        ? entry.transition
        : null,
    )
    .filter((entry): entry is string => entry !== null);
  const missing = ["scheduled", "snoozed", "completed"].filter(
    (transition) => !transitions.includes(transition),
  );
  return missing.length === 0
    ? undefined
    : `expected history transitions scheduled,snoozed,completed; missing ${missing.join(", ")}; saw ${transitions.join(", ") || "(none)"}`;
}

function finalActionLedgerCheck(ctx: ScenarioContext): string | undefined {
  const calls = (ctx.actionsCalled ?? []).filter(
    (call) => call.actionName === "SCHEDULED_TASKS",
  );
  if (calls.length !== 6) {
    return `expected exactly 6 SCHEDULED_TASKS calls, saw ${calls.length}`;
  }
  const subactions = calls.map((call) => {
    const parameters = isRecord(call.parameters)
      ? call.parameters.parameters
      : undefined;
    return isRecord(parameters) ? parameters.action : undefined;
  });
  const expected = ["create", "list", "get", "snooze", "complete", "history"];
  const orderFailure = expectEqual(subactions, expected, "action order");
  if (orderFailure) return orderFailure;
  const failed = calls.filter((call) => call.result?.success !== true);
  return failed.length === 0
    ? undefined
    : `expected every SCHEDULED_TASKS ActionResult.success=true, saw ${stableStringify(failed)}`;
}

export default scenario({
  id: "deterministic-lifeops-scheduled-tasks",
  title: "Deterministic LifeOps ScheduledTask action execution",
  domain: "lifeops",
  tags: ["pr", "deterministic", "zero-cost", "lifeops", "scheduled-tasks"],
  isolation: "shared-runtime",
  requires: {
    plugins: ["@elizaos/plugin-lifeops"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Deterministic LifeOps ScheduledTasks",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "create scheduled reminder",
      text: "Schedule a deterministic water reminder",
      actionName: "SCHEDULED_TASKS",
      options: { parameters: createParameters },
      responseIncludesAny: ["Scheduled reminder task"],
      assertTurn: expectCreatedTurn,
    },
    {
      kind: "action",
      name: "list scheduled reminders",
      text: "List scheduled reminders",
      actionName: "SCHEDULED_TASKS",
      options: { parameters: listParameters },
      responseIncludesAny: ["scheduled task"],
      assertTurn: expectListTurn,
    },
    {
      kind: "action",
      name: "get created scheduled reminder",
      text: "Fetch the deterministic water reminder",
      actionName: "SCHEDULED_TASKS",
      options: { parameters: getParameters },
      responseIncludesAny: ["Found scheduled task"],
      assertTurn: (execution) =>
        expectTaskStatusTurn(execution, getParameters, "get", "scheduled"),
    },
    {
      kind: "action",
      name: "snooze created scheduled reminder",
      text: "Snooze the deterministic water reminder",
      actionName: "SCHEDULED_TASKS",
      options: { parameters: snoozeParameters },
      responseIncludesAny: ["Snoozed scheduled task"],
      assertTurn: expectSnoozeTurn,
    },
    {
      kind: "action",
      name: "complete created scheduled reminder",
      text: "Complete the deterministic water reminder",
      actionName: "SCHEDULED_TASKS",
      options: { parameters: completeParameters },
      responseIncludesAny: ["Completed scheduled task"],
      assertTurn: (execution) =>
        expectTaskStatusTurn(
          execution,
          completeParameters,
          "complete",
          "completed",
        ),
    },
    {
      kind: "action",
      name: "read scheduled reminder history",
      text: "Read the deterministic water reminder history",
      actionName: "SCHEDULED_TASKS",
      options: { parameters: historyParameters },
      responseIncludesAny: ["scheduled-task log row"],
      assertTurn: expectHistoryTurn,
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "SCHEDULED_TASKS",
      status: "success",
      minCount: 6,
    },
    {
      type: "selectedActionArguments",
      actionName: "SCHEDULED_TASKS",
      includesAll: [
        /"action":"create"/,
        /"action":"list"/,
        /"action":"get"/,
        /"action":"snooze"/,
        /"action":"complete"/,
        /"action":"history"/,
        /drink a glass of water/,
        /scenario user completed it/,
      ],
    },
    {
      type: "custom",
      name: "SCHEDULED_TASKS action ledger is exact and successful",
      predicate: finalActionLedgerCheck,
    },
  ],
});
