/**
 * Keyless coverage for the plugin-todos action surface and the CURRENT_TODOS
 * provider. Runs on the pr-deterministic lane under the model provider.
 */
import { type IAgentRuntime, stringToUuid } from "@elizaos/core";
import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import todosPlugin, {
  currentTodosProvider,
  TodosService,
} from "../../../../plugins/plugin-todos/src/index.ts";

const SCENARIO_ID = "deterministic-todos-actions";
const WORLD_ID = stringToUuid(`scenario-runner-world:${SCENARIO_ID}`);

const UNKNOWN_ID = stringToUuid(`${SCENARIO_ID}:unknown`);
let updateId: string | null = null;
let completeId: string | null = null;
let cancelId: string | null = null;
let deleteId: string | null = null;
let scenarioAgentId: string | null = null;
let scenarioOwnerId: string | null = null;
let scenarioRoomId: string | null = null;
let scenarioRuntime: RuntimeWithPlugins | null = null;
let previousEvaluators: IAgentRuntime["evaluators"] | null = null;

type JsonRecord = Record<string, unknown>;
type ScenarioTodoInput = {
  id?: string;
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
};

const SEEDED_TODO_INPUTS: ScenarioTodoInput[] = [
  {
    content: "Draft TODO scenario",
    activeForm: "Drafting TODO scenario",
    status: "pending",
  },
  {
    content: "Complete TODO scenario",
    activeForm: "Completing TODO scenario",
    status: "in_progress",
  },
  {
    content: "Cancel TODO scenario",
    activeForm: "Cancelling TODO scenario",
    status: "pending",
  },
  {
    content: "Delete TODO scenario",
    activeForm: "Deleting TODO scenario",
    status: "pending",
  },
];

const FULL_WRITE_TODOS: ScenarioTodoInput[] = [
  ...SEEDED_TODO_INPUTS.map((todo) => ({ ...todo })),
  {
    content: "Review deterministic TODO mocks",
    activeForm: "Reviewing deterministic TODO mocks",
    status: "pending",
  },
  {
    content: "Ship TODO scenario",
    activeForm: "Shipping TODO scenario",
    status: "in_progress",
  },
];

const UPDATE_PARAMETERS: JsonRecord = {
  action: "update",
  content: "Polish TODO scenario",
  activeForm: "Polishing TODO scenario",
  status: "in_progress",
};
const COMPLETE_PARAMETERS: JsonRecord = { action: "complete" };
const CANCEL_PARAMETERS: JsonRecord = { action: "cancel" };
const DELETE_PARAMETERS: JsonRecord = { action: "delete" };
const WRONG_OWNER_PARAMETERS: JsonRecord = {
  action: "update",
  content: "Wrong owner overwrite",
  status: "completed",
};

// The repository assigns Todo ids. Scenario turns are declared before seeds
// run, so the seed fills these shared parameter objects with the ids returned
// by the same production store boundary the TODO handler consumes.

type RuntimeWithPlugins = {
  agentId?: string;
  evaluators: IAgentRuntime["evaluators"];
  adapter?: {
    runPluginMigrations?: (
      plugins: Array<{ name: string; schema?: Record<string, unknown> }>,
      options?: { verbose?: boolean; force?: boolean; dryRun?: boolean },
    ) => Promise<void>;
  };
  getService?: (serviceType: string) => unknown;
  getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
  plugins?: Array<{ name?: unknown }>;
  registerPlugin?: (plugin: unknown) => Promise<void>;
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function actionResult(execution: ScenarioTurnExecution): JsonRecord | null {
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === "TODO",
  ) as CapturedAction | undefined;
  return isRecord(action?.result) ? action.result : null;
}

function resultData(execution: ScenarioTurnExecution): JsonRecord | null {
  const result = actionResult(execution);
  return isRecord(result?.data) ? result.data : null;
}

function expectTodoTurn(
  op: string,
  check?: (
    data: JsonRecord,
    execution: ScenarioTurnExecution,
  ) => string | undefined,
): (execution: ScenarioTurnExecution) => string | undefined {
  return (execution) => {
    const result = actionResult(execution);
    if (!result) return "TODO action was not captured";
    if (result.success !== true) {
      return `TODO action failed: ${JSON.stringify(result)}`;
    }
    const data = resultData(execution);
    if (!data) return "TODO action result had no data object";
    if (data.action !== op || data.op !== op) {
      return `expected op=${op}, saw ${JSON.stringify({ action: data.action, op: data.op })}`;
    }
    return check?.(data, execution);
  };
}

function findTodo(data: JsonRecord, id: string): JsonRecord | null {
  const todos = records(data.todos);
  return todos.find((todo) => todo.id === id) ?? null;
}

function expectTodoNotFound(
  getId: () => string | null,
): (execution: ScenarioTurnExecution) => string | undefined {
  return (execution) => {
    const id = getId();
    if (!id) return "seeded TODO id was not available";
    const result = actionResult(execution);
    if (!result) return "TODO action was not captured";
    if (result.success !== false) {
      return `expected TODO not_found failure, saw ${JSON.stringify(result)}`;
    }
    const expected = `[Todos] not_found: todo ${id} not found for this user`;
    if (result.text !== expected) {
      return `expected ${JSON.stringify(expected)}, saw ${JSON.stringify(result.text)}`;
    }
    if (result.data !== undefined) {
      return `not_found must not expose fabricated success data: ${JSON.stringify(result.data)}`;
    }
    const raw = isRecord(result.raw) ? result.raw : null;
    if (Array.isArray(raw?.effectReceipts) && raw.effectReceipts.length > 0) {
      return `not_found must not emit effect receipts: ${JSON.stringify(raw.effectReceipts)}`;
    }
    return undefined;
  };
}

async function ensureTodosPlugin(runtime: RuntimeWithPlugins): Promise<void> {
  const registered = (runtime.plugins ?? []).some(
    (plugin) => plugin.name === todosPlugin.name,
  );
  if (!registered) {
    await runtime.registerPlugin?.(todosPlugin);
  }
  await runtime.getServiceLoadPromise?.(TodosService.serviceType);
}

async function seedTodos(ctx: ScenarioContext): Promise<string | undefined> {
  try {
    const runtime = ctx.runtime as RuntimeWithPlugins;
    scenarioRuntime = runtime;
    scenarioAgentId =
      typeof runtime.agentId === "string" && runtime.agentId.length > 0
        ? runtime.agentId
        : null;
    scenarioOwnerId =
      typeof ctx.primaryUserId === "string" && ctx.primaryUserId.length > 0
        ? ctx.primaryUserId
        : null;
    scenarioRoomId =
      typeof ctx.primaryRoomId === "string" && ctx.primaryRoomId.length > 0
        ? ctx.primaryRoomId
        : null;
    if (!scenarioAgentId || !scenarioOwnerId || !scenarioRoomId) {
      return "scenario runtime did not expose the agent, owner, and room identity";
    }
    // This scenario owns TODO routing and persistence, not semantic recall or
    // post-turn reflection. Isolate the runtime's public evaluator registry to
    // prevent unrelated background model calls, then restore it in cleanup.
    previousEvaluators = [...runtime.evaluators];
    runtime.evaluators.length = 0;
    await ensureTodosPlugin(runtime);
    await runtime.adapter?.runPluginMigrations?.([todosPlugin], {
      verbose: false,
    });
    const service = runtime.getService?.(TodosService.serviceType) as
      | TodosService
      | null
      | undefined;
    if (!service) return "TodosService was not registered";
    const scope = { entityId: scenarioOwnerId, agentId: scenarioAgentId };
    await service.clear(scope);
    const seedExecution = await service.applyMutation({
      scope,
      idempotencyKey: `todos:scenario-seed:${crypto.randomUUID()}`,
      mutation: {
        action: "write",
        input: {
          roomId: null,
          worldId: WORLD_ID,
          parentTrajectoryStepId: null,
          todos: SEEDED_TODO_INPUTS,
        },
      },
    });
    if (seedExecution.result.action !== "write") {
      return `unexpected TODO seed result: ${seedExecution.result.action}`;
    }
    const seeded = seedExecution.result;
    const byContent = new Map(
      seeded.after.map((todo) => [todo.content, todo.id]),
    );
    updateId = byContent.get("Draft TODO scenario") ?? null;
    completeId = byContent.get("Complete TODO scenario") ?? null;
    cancelId = byContent.get("Cancel TODO scenario") ?? null;
    deleteId = byContent.get("Delete TODO scenario") ?? null;
    if (!updateId || !completeId || !cancelId || !deleteId) {
      return `TodosService did not return every seeded identity: ${JSON.stringify(seeded.after)}`;
    }
    [updateId, completeId, cancelId, deleteId].forEach((id, index) => {
      FULL_WRITE_TODOS[index].id = id;
    });
    UPDATE_PARAMETERS.id = updateId;
    COMPLETE_PARAMETERS.id = completeId;
    CANCEL_PARAMETERS.id = cancelId;
    DELETE_PARAMETERS.id = deleteId;
    WRONG_OWNER_PARAMETERS.id = updateId;
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function finalTodosCheck(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime =
    (ctx.runtime as RuntimeWithPlugins | undefined) ?? scenarioRuntime;
  if (!runtime) return "scenario runtime was not available";
  const service = runtime.getService?.(TodosService.serviceType) as
    | TodosService
    | null
    | undefined;
  if (!service) return "TodosService missing in final check";
  if (!scenarioAgentId || !scenarioOwnerId || !scenarioRoomId) {
    return "scenario owner identity was not retained for final checks";
  }
  if (!updateId || !completeId || !cancelId || !deleteId) {
    return "seeded TODO identities were not retained for final checks";
  }
  const todos = await service.list({
    entityId: scenarioOwnerId,
    agentId: scenarioAgentId,
    includeCompleted: true,
  });
  const byId = new Map(todos.map((todo) => [todo.id, todo]));
  const failures: string[] = [];
  if (byId.get(updateId)?.content !== "Polish TODO scenario") {
    failures.push("update action did not persist edited content");
  }
  if (byId.get(updateId)?.status !== "in_progress") {
    failures.push("update action did not persist in_progress status");
  }
  if (byId.get(completeId)?.status !== "completed") {
    failures.push("complete action did not persist completed status");
  }
  if (byId.get(cancelId)?.status !== "cancelled") {
    failures.push("cancel action did not persist cancelled status");
  }
  if (byId.has(deleteId)) {
    failures.push("delete action left the deleted fixture row in the store");
  }
  if (todos.some((todo) => todo.roomId === scenarioRoomId)) {
    failures.push("clear action did not remove room-scoped write/create todos");
  }

  const providerResult = await currentTodosProvider.get(
    runtime as never,
    {
      entityId: scenarioOwnerId,
      roomId: scenarioRoomId,
      worldId: WORLD_ID,
      content: { text: "show my todos" },
    } as never,
  );
  const providerTodos = records(providerResult.data?.todos);
  if (!providerResult.text.includes("Polish TODO scenario")) {
    failures.push("CURRENT_TODOS provider did not render active updated todo");
  }
  if (
    providerTodos.some((todo) => todo.id === completeId || todo.id === cancelId)
  ) {
    failures.push("CURRENT_TODOS provider included completed/cancelled todos");
  }
  return failures.length > 0 ? failures.join("\n") : undefined;
}

export default scenario({
  id: "deterministic-todos-actions",
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "fixtures",
    fixtures: [
      {
        name: "route-todo-stage1-natural-language-create",
        match: {
          modelType: "RESPONSE_HANDLER",
          input: {
            pattern:
              "Add a todo to cover natural language routing(?![\\s\\S]*message:user:\\n)",
          },
          toolNames: ["HANDLE_RESPONSE"],
        },
        response: {
          json: {
            contexts: ["todos"],
            intents: ["add a todo to cover natural language routing"],
            replyText: "On it.",
            threadOps: [],
            candidateActionNames: ["TODO"],
          },
        },
      },
      {
        name: "route-todo-planner-natural-language-create",
        match: {
          modelType: "ACTION_PLANNER",
          input: {
            pattern:
              "Add a todo to cover natural language routing(?![\\s\\S]*message:user:\\n)",
          },
          // `toolNames` is set equality against the planner's ACTUAL tool
          // surface, and retrieval ranks the catalog without ever narrowing it
          // ("Retrieval ranks every parent; it never limits availability" —
          // core/src/runtime/action-retrieval.ts). On this lane the runner
          // registers the whole personal-assistant + goals roster, so the
          // planner is offered every OWNER_* family, not just the todos one.
          // Listing a subset matches nothing and the turn dies as an unmatched
          // model call. Keep this list in sync with the plugins
          // scenario-runner/src/runtime-factory.ts registers for the simulated
          // profile.
          toolNames: [
            "OWNER_REMINDERS",
            "OWNER_REMINDERS_CREATE",
            "OWNER_REMINDERS_UPDATE",
            "OWNER_REMINDERS_DELETE",
            "OWNER_REMINDERS_COMPLETE",
            "OWNER_REMINDERS_SKIP",
            "OWNER_REMINDERS_SNOOZE",
            "OWNER_REMINDERS_REVIEW",
            "OWNER_ALARMS",
            "OWNER_ALARMS_CREATE",
            "OWNER_ALARMS_UPDATE",
            "OWNER_ALARMS_DELETE",
            "OWNER_ALARMS_COMPLETE",
            "OWNER_ALARMS_SKIP",
            "OWNER_ALARMS_SNOOZE",
            "OWNER_ALARMS_REVIEW",
            "OWNER_GOALS",
            "OWNER_GOALS_CREATE",
            "OWNER_GOALS_UPDATE",
            "OWNER_GOALS_DELETE",
            "OWNER_GOALS_REVIEW",
            "OWNER_TODOS",
            "OWNER_TODOS_CREATE",
            "OWNER_TODOS_UPDATE",
            "OWNER_TODOS_DELETE",
            "OWNER_TODOS_COMPLETE",
            "OWNER_TODOS_SKIP",
            "OWNER_TODOS_SNOOZE",
            "OWNER_TODOS_REVIEW",
            "OWNER_ROUTINES",
            "OWNER_ROUTINES_CREATE",
            "OWNER_ROUTINES_UPDATE",
            "OWNER_ROUTINES_DELETE",
            "OWNER_ROUTINES_COMPLETE",
            "OWNER_ROUTINES_SKIP",
            "OWNER_ROUTINES_SNOOZE",
            "OWNER_ROUTINES_REVIEW",
            "OWNER_ROUTINES_SCHEDULE_SUMMARY",
            "OWNER_ROUTINES_SCHEDULE_INSPECT",
            "TODO",
            "REPLY",
            "IGNORE",
            "STOP",
          ],
        },
        response: {
          json: {
            text: "",
            thought:
              "Call TODO for Add a todo to cover natural language routing.",
            messageToUser: "Added TODO scenario natural-language coverage.",
            completed: true,
            finishReason: "tool-calls",
            toolCalls: [
              {
                id: "call-todo-create-nl",
                name: "TODO",
                type: "function",
                arguments: {
                  action: "create",
                  content: "Prove TODO natural language routing",
                  activeForm: "Proving TODO natural language routing",
                  status: "pending",
                },
              },
            ],
          },
        },
      },
    ],
  },
  title: "Deterministic TODO action and CURRENT_TODOS provider coverage",
  domain: "todos",
  status: "active",
  requires: {
    plugins: ["@elizaos/plugin-todos"],
  },
  rooms: [
    {
      id: "main",
      source: "client_chat",
      title: "Todo Owner",
    },
    {
      id: "other-owner",
      source: "client_chat",
      title: "Other Todo Owner",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "register real todos plugin and seed through TodosService",
      apply: seedTodos,
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "restore shared runtime evaluators",
      apply: (ctx) => {
        const runtime = ctx.runtime as RuntimeWithPlugins;
        if (previousEvaluators !== null) {
          runtime.evaluators.splice(
            0,
            runtime.evaluators.length,
            ...previousEvaluators,
          );
          previousEvaluators = null;
        }
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "TODO natural-language route creates a todo with strict JSON",
      text: "Add a todo to cover natural language routing",
      assertTurn: expectTodoTurn("create", (data) => {
        const todo = isRecord(data.todo) ? data.todo : null;
        if (todo?.content !== "Prove TODO natural language routing") {
          return `unexpected natural-language TODO result: ${JSON.stringify(todo)}`;
        }
        return undefined;
      }),
    },
    {
      kind: "action",
      name: "TODO write replaces room-scoped list",
      actionName: "TODO",
      text: "replace my todo list",
      options: {
        parameters: {
          action: "write",
          todos: FULL_WRITE_TODOS,
        },
      },
      assertTurn: expectTodoTurn("write", (data) => {
        const todos = records(data.todos);
        if (todos.length !== 6) {
          return `expected full write to preserve 4 seeded and add 2 room-scoped todos, saw ${todos.length}`;
        }
        const seededIds = [updateId, completeId, cancelId, deleteId];
        if (
          seededIds.some((id) => id === null || findTodo(data, id) === null)
        ) {
          return "full write dropped one or more seeded todo identities";
        }
        if (!todos.some((todo) => todo.content === "Ship TODO scenario")) {
          return "write result did not include Ship TODO scenario";
        }
        return undefined;
      }),
    },
    {
      kind: "action",
      name: "TODO create adds a room-scoped todo",
      actionName: "TODO",
      text: "add one todo",
      options: {
        parameters: {
          action: "create",
          content: "Document TODO coverage",
          activeForm: "Documenting TODO coverage",
          status: "pending",
        },
      },
      assertTurn: expectTodoTurn("create", (data) => {
        const todo = isRecord(data.todo) ? data.todo : null;
        if (todo?.content !== "Document TODO coverage") {
          return `unexpected created todo: ${JSON.stringify(todo)}`;
        }
        return undefined;
      }),
    },
    {
      kind: "action",
      name: "TODO update edits seeded todo by id",
      actionName: "TODO",
      text: "update a todo",
      options: { parameters: UPDATE_PARAMETERS },
      assertTurn: expectTodoTurn("update", (data) => {
        if (!updateId) return "seeded update id was not available";
        const todo = isRecord(data.todo) ? data.todo : null;
        if (todo?.id !== updateId || todo.content !== "Polish TODO scenario") {
          return `unexpected updated todo: ${JSON.stringify(todo)}`;
        }
        return undefined;
      }),
    },
    {
      kind: "action",
      name: "TODO complete marks seeded todo completed",
      actionName: "TODO",
      text: "complete a todo",
      options: { parameters: COMPLETE_PARAMETERS },
      assertTurn: expectTodoTurn("complete", (data) => {
        if (!completeId) return "seeded complete id was not available";
        const todo = isRecord(data.todo) ? data.todo : null;
        if (todo?.id !== completeId || todo.status !== "completed") {
          return `unexpected completed todo: ${JSON.stringify(todo)}`;
        }
        return undefined;
      }),
    },
    {
      kind: "action",
      name: "TODO cancel marks seeded todo cancelled",
      actionName: "TODO",
      text: "cancel a todo",
      options: { parameters: CANCEL_PARAMETERS },
      assertTurn: expectTodoTurn("cancel", (data) => {
        if (!cancelId) return "seeded cancel id was not available";
        const todo = isRecord(data.todo) ? data.todo : null;
        if (todo?.id !== cancelId || todo.status !== "cancelled") {
          return `unexpected cancelled todo: ${JSON.stringify(todo)}`;
        }
        return undefined;
      }),
    },
    {
      kind: "action",
      name: "TODO delete removes seeded todo",
      actionName: "TODO",
      text: "delete a todo",
      options: { parameters: DELETE_PARAMETERS },
      assertTurn: expectTodoTurn("delete", (data) => {
        if (!deleteId) return "seeded delete id was not available";
        return data.id === deleteId
          ? undefined
          : `expected deleted id=${deleteId}, saw ${String(data.id)}`;
      }),
    },
    {
      kind: "action",
      name: "TODO wrong owner cannot update seeded todo",
      room: "other-owner",
      actionName: "TODO",
      text: "update another owner's todo",
      options: { parameters: WRONG_OWNER_PARAMETERS },
      assertTurn: expectTodoNotFound(() => updateId),
    },
    {
      kind: "action",
      name: "TODO unknown id fails without fabricated success",
      actionName: "TODO",
      text: "update an unknown todo",
      options: {
        parameters: {
          action: "update",
          id: UNKNOWN_ID,
          content: "Unknown todo overwrite",
        },
      },
      assertTurn: expectTodoNotFound(() => UNKNOWN_ID),
    },
    {
      kind: "action",
      name: "TODO list returns persisted todos including completed",
      actionName: "TODO",
      text: "list todos",
      options: { parameters: { action: "list", includeCompleted: true } },
      assertTurn: expectTodoTurn("list", (data) => {
        if (!updateId || !completeId || !cancelId || !deleteId) {
          return "seeded TODO identities were not available to list assertion";
        }
        if (!findTodo(data, updateId)) return "list omitted updated fixture";
        if (!findTodo(data, completeId))
          return "list omitted completed fixture";
        if (!findTodo(data, cancelId)) return "list omitted cancelled fixture";
        if (findTodo(data, deleteId)) return "list included deleted fixture";
        return undefined;
      }),
    },
    {
      kind: "action",
      name: "TODO clear removes room-scoped todos",
      actionName: "TODO",
      text: "clear todos",
      options: { parameters: { action: "clear" } },
      assertTurn: expectTodoTurn("clear", (data) =>
        data.count === 3
          ? undefined
          : `expected clear count=3 for room-scoped write/create rows, saw ${String(data.count)}`,
      ),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "real TodosService state and CURRENT_TODOS provider are exact",
      predicate: finalTodosCheck,
    },
  ],
});
