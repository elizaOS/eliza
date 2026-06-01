import { ModelType, stringToUuid, type UUID } from "@elizaos/core";
import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import todosPlugin, {
  currentTodosProvider,
  TodosService,
  todosTable,
} from "../../../../plugins/plugin-todos/src/index.ts";
import { matchesScenarioInput } from "./_helpers/strict-llm-action-fixtures";

const SCENARIO_ID = "deterministic-todos-actions";
const ENTITY_ID = stringToUuid(`scenario-account:${SCENARIO_ID}:main`);
const AGENT_ID = "546ac3ab-0468-01a2-9d5b-52dfa34bf9cc";
const ROOM_ID = stringToUuid(`scenario-room:${SCENARIO_ID}:main`);
const WORLD_ID = stringToUuid(`scenario-runner-world:${SCENARIO_ID}`);

const UPDATE_ID = stringToUuid(`${SCENARIO_ID}:update`);
const COMPLETE_ID = stringToUuid(`${SCENARIO_ID}:complete`);
const CANCEL_ID = stringToUuid(`${SCENARIO_ID}:cancel`);
const DELETE_ID = stringToUuid(`${SCENARIO_ID}:delete`);
let scenarioAgentId = AGENT_ID;
let scenarioRuntime: RuntimeWithPlugins | null = null;

type JsonRecord = Record<string, unknown>;

type RuntimeWithPlugins = {
  agentId?: string;
  adapter?: {
    runPluginMigrations?: (
      plugins: Array<{ name: string; schema?: Record<string, unknown> }>,
      options?: { verbose?: boolean; force?: boolean; dryRun?: boolean },
    ) => Promise<void>;
  };
  db?: {
    insert: (table: unknown) => {
      values: (values: unknown) => {
        returning: () => Promise<unknown>;
      };
    };
  };
  getService?: (serviceType: string) => unknown;
  getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
  plugins?: Array<{ name?: unknown }>;
  registerPlugin?: (plugin: unknown) => Promise<void>;
  scenarioLlmFixtures?: {
    register: (...fixtures: Array<Record<string, unknown>>) => void;
  };
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

function handleResponseFixture(input: string) {
  return {
    name: `route-todo-stage1-${input}`,
    match: {
      modelType: ModelType.RESPONSE_HANDLER,
      input: matchesScenarioInput(input),
      toolName: "HANDLE_RESPONSE",
    },
    response: {
      contexts: ["todos"],
      intents: [input.toLowerCase()],
      replyText: "On it.",
      threadOps: [],
      candidateActionNames: ["TODO"],
    },
    times: 1,
  };
}

function plannerFixture(input: string, args: Record<string, unknown>) {
  return {
    name: `route-todo-planner-${input}`,
    match: {
      modelType: ModelType.ACTION_PLANNER,
      input: matchesScenarioInput(input),
      toolName: "TODO",
    },
    response: {
      text: "",
      thought: `Call TODO for ${input}.`,
      messageToUser: "Added TODO scenario natural-language coverage.",
      completed: true,
      finishReason: "tool-calls",
      toolCalls: [
        {
          id: "call-todo-create-nl",
          name: "TODO",
          type: "function",
          arguments: args,
        },
      ],
    },
    times: 1,
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
    scenarioAgentId = String(runtime.agentId ?? AGENT_ID);
    await ensureTodosPlugin(runtime);
    await runtime.adapter?.runPluginMigrations?.([todosPlugin], {
      verbose: false,
    });
    runtime.scenarioLlmFixtures?.register(
      handleResponseFixture("Add a todo to cover natural language routing"),
      plannerFixture("Add a todo to cover natural language routing", {
        action: "create",
        content: "Prove TODO natural language routing",
        activeForm: "Proving TODO natural language routing",
        status: "pending",
      }),
    );
    const service = runtime.getService?.(TodosService.serviceType) as
      | TodosService
      | null
      | undefined;
    if (!service) return "TodosService was not registered";
    await service.clear({ entityId: ENTITY_ID, agentId: scenarioAgentId });
    if (!runtime.db) return "runtime.db was not available";
    const now = new Date("2026-05-29T12:00:00.000Z");
    await runtime.db
      .insert(todosTable)
      .values([
        {
          id: UPDATE_ID as UUID,
          entityId: ENTITY_ID as UUID,
          agentId: scenarioAgentId as UUID,
          roomId: null,
          worldId: WORLD_ID as UUID,
          content: "Draft TODO scenario",
          activeForm: "Drafting TODO scenario",
          status: "pending",
          parentTodoId: null,
          parentTrajectoryStepId: null,
          metadata: { scenario: SCENARIO_ID, fixture: "update" },
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        },
        {
          id: COMPLETE_ID as UUID,
          entityId: ENTITY_ID as UUID,
          agentId: scenarioAgentId as UUID,
          roomId: null,
          worldId: WORLD_ID as UUID,
          content: "Complete TODO scenario",
          activeForm: "Completing TODO scenario",
          status: "in_progress",
          parentTodoId: null,
          parentTrajectoryStepId: null,
          metadata: { scenario: SCENARIO_ID, fixture: "complete" },
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        },
        {
          id: CANCEL_ID as UUID,
          entityId: ENTITY_ID as UUID,
          agentId: scenarioAgentId as UUID,
          roomId: null,
          worldId: WORLD_ID as UUID,
          content: "Cancel TODO scenario",
          activeForm: "Cancelling TODO scenario",
          status: "pending",
          parentTodoId: null,
          parentTrajectoryStepId: null,
          metadata: { scenario: SCENARIO_ID, fixture: "cancel" },
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        },
        {
          id: DELETE_ID as UUID,
          entityId: ENTITY_ID as UUID,
          agentId: scenarioAgentId as UUID,
          roomId: null,
          worldId: WORLD_ID as UUID,
          content: "Delete TODO scenario",
          activeForm: "Deleting TODO scenario",
          status: "pending",
          parentTodoId: null,
          parentTrajectoryStepId: null,
          metadata: { scenario: SCENARIO_ID, fixture: "delete" },
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        },
      ])
      .returning();
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
  const todos = await service.list({
    entityId: ENTITY_ID,
    agentId: scenarioAgentId,
    includeCompleted: true,
  });
  const byId = new Map(todos.map((todo) => [todo.id, todo]));
  const failures: string[] = [];
  if (byId.get(UPDATE_ID)?.content !== "Polish TODO scenario") {
    failures.push("update action did not persist edited content");
  }
  if (byId.get(UPDATE_ID)?.status !== "in_progress") {
    failures.push("update action did not persist in_progress status");
  }
  if (byId.get(COMPLETE_ID)?.status !== "completed") {
    failures.push("complete action did not persist completed status");
  }
  if (byId.get(CANCEL_ID)?.status !== "cancelled") {
    failures.push("cancel action did not persist cancelled status");
  }
  if (byId.has(DELETE_ID)) {
    failures.push("delete action left the deleted fixture row in the store");
  }
  if (todos.some((todo) => todo.roomId === ROOM_ID)) {
    failures.push("clear action did not remove room-scoped write/create todos");
  }

  const providerResult = await currentTodosProvider.get(
    runtime as never,
    {
      entityId: ENTITY_ID,
      roomId: ROOM_ID,
      worldId: WORLD_ID,
      content: { text: "show my todos" },
    } as never,
  );
  const providerTodos = records(providerResult.data?.todos);
  if (!providerResult.text.includes("Polish TODO scenario")) {
    failures.push("CURRENT_TODOS provider did not render active updated todo");
  }
  if (
    providerTodos.some(
      (todo) => todo.id === COMPLETE_ID || todo.id === CANCEL_ID,
    )
  ) {
    failures.push("CURRENT_TODOS provider included completed/cancelled todos");
  }
  return failures.length > 0 ? failures.join("\n") : undefined;
}

export default scenario({
  id: "deterministic-todos-actions",
  title: "Deterministic TODO action and CURRENT_TODOS provider coverage",
  domain: "todos",
  status: "active",
  requires: {
    plugins: ["@elizaos/plugin-todos"],
  },
  seed: [
    {
      type: "custom",
      name: "register real todos plugin and seed fixed DB rows",
      apply: seedTodos,
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
          todos: [
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
          ],
        },
      },
      assertTurn: expectTodoTurn("write", (data) => {
        const todos = records(data.todos);
        if (todos.length !== 2) {
          return `expected write to produce 2 room-scoped todos, saw ${todos.length}`;
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
      options: {
        parameters: {
          action: "update",
          id: UPDATE_ID,
          content: "Polish TODO scenario",
          activeForm: "Polishing TODO scenario",
          status: "in_progress",
        },
      },
      assertTurn: expectTodoTurn("update", (data) => {
        const todo = isRecord(data.todo) ? data.todo : null;
        if (todo?.id !== UPDATE_ID || todo.content !== "Polish TODO scenario") {
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
      options: { parameters: { action: "complete", id: COMPLETE_ID } },
      assertTurn: expectTodoTurn("complete", (data) => {
        const todo = isRecord(data.todo) ? data.todo : null;
        if (todo?.id !== COMPLETE_ID || todo.status !== "completed") {
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
      options: { parameters: { action: "cancel", id: CANCEL_ID } },
      assertTurn: expectTodoTurn("cancel", (data) => {
        const todo = isRecord(data.todo) ? data.todo : null;
        if (todo?.id !== CANCEL_ID || todo.status !== "cancelled") {
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
      options: { parameters: { action: "delete", id: DELETE_ID } },
      assertTurn: expectTodoTurn("delete", (data) =>
        data.id === DELETE_ID
          ? undefined
          : `expected deleted id=${DELETE_ID}, saw ${String(data.id)}`,
      ),
    },
    {
      kind: "action",
      name: "TODO list returns persisted todos including completed",
      actionName: "TODO",
      text: "list todos",
      options: { parameters: { action: "list", includeCompleted: true } },
      assertTurn: expectTodoTurn("list", (data) => {
        if (!findTodo(data, UPDATE_ID)) return "list omitted updated fixture";
        if (!findTodo(data, COMPLETE_ID))
          return "list omitted completed fixture";
        if (!findTodo(data, CANCEL_ID)) return "list omitted cancelled fixture";
        if (findTodo(data, DELETE_ID)) return "list included deleted fixture";
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
