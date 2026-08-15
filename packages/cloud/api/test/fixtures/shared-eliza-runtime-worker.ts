/**
 * Runs the production Shared turn adapter inside Workerd while an external
 * deterministic OpenAI-compatible endpoint supplies the model response.
 */

import { searchKeylessWeb, type UUID } from "@elizaos/core/edge";
import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskRunner,
} from "@elizaos/plugin-scheduling/edge";
import type {
  CreateTodoInput,
  Todo,
  TodoMutationRecord,
  TodoStore,
} from "@elizaos/plugin-todos/edge";
import { runWithCloudBindingsAsync } from "../../../shared/src/lib/runtime/cloud-bindings";
import { runSharedAgentTurn } from "../../../shared/src/lib/services/shared-runtime/run-shared-agent-turn";

type Env = {
  NODE_ENV: string;
  OPENROUTER_API_KEY: string;
  OPENROUTER_BASE_URL: string;
};

function createTodoProbeStore(records: Todo[]): TodoStore {
  const mutations: TodoMutationRecord[] = [];
  const create = (input: CreateTodoInput): Todo => {
    const now = new Date();
    const todo: Todo = {
      id: `90000000-0000-4000-8000-${String(records.length + 1).padStart(12, "0")}`,
      agentId: input.agentId,
      entityId: input.entityId,
      roomId: input.roomId ?? null,
      worldId: input.worldId ?? null,
      content: input.content,
      activeForm: input.activeForm ?? input.content,
      status: input.status ?? "pending",
      parentTodoId: input.parentTodoId ?? null,
      parentTrajectoryStepId: input.parentTrajectoryStepId ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
      completedAt: input.status === "completed" ? now : null,
    };
    records.push(todo);
    return todo;
  };
  return {
    async applyMutation(input) {
      const existing = mutations.find(
        (record) =>
          record.scope.agentId === input.scope.agentId &&
          record.scope.entityId === input.scope.entityId &&
          record.idempotencyKey === input.idempotencyKey,
      );
      if (existing) {
        return {
          mutationId: existing.mutationId,
          idempotencyKey: existing.idempotencyKey,
          replayed: true,
          committedAt: existing.committedAt,
          applied: existing.applied,
          result: existing.result,
        };
      }
      if (input.mutation.action !== "create") {
        throw new Error("The Workerd mutation probe only creates Todos");
      }
      const committedAt = new Date();
      const result = {
        action: "create" as const,
        todo: create({ ...input.scope, ...input.mutation.input }),
      };
      const record: TodoMutationRecord = {
        mutationId: `91000000-0000-4000-8000-${String(mutations.length + 1).padStart(12, "0")}`,
        scope: input.scope,
        idempotencyKey: input.idempotencyKey,
        requestDigest: "0".repeat(64),
        operation: "create",
        applied: true,
        result,
        committedAt,
      };
      mutations.push(record);
      return {
        mutationId: record.mutationId,
        idempotencyKey: record.idempotencyKey,
        replayed: false,
        committedAt,
        applied: true,
        result,
      };
    },
    async readCutoverState(scope) {
      return {
        todos: records.filter(
          (todo) =>
            todo.agentId === scope.agentId && todo.entityId === scope.entityId,
        ),
        mutations: mutations.filter(
          (record) =>
            record.scope.agentId === scope.agentId &&
            record.scope.entityId === scope.entityId,
        ),
      };
    },
    async listMutationRecords(scope) {
      return mutations.filter(
        (record) =>
          record.scope.agentId === scope.agentId &&
          record.scope.entityId === scope.entityId,
      );
    },
    async importMutationRecords() {
      throw new Error("The Workerd creation probe does not import mutations");
    },
    async create(input) {
      return create(input);
    },
    async get(scope, id) {
      return (
        records.find(
          (todo) =>
            todo.id === id &&
            todo.agentId === scope.agentId &&
            todo.entityId === scope.entityId,
        ) ?? null
      );
    },
    async list(filter) {
      return records.filter(
        (todo) =>
          todo.agentId === filter.agentId &&
          todo.entityId === filter.entityId &&
          (filter.includeCompleted !== false ||
            todo.status === "pending" ||
            todo.status === "in_progress"),
      );
    },
    async update() {
      throw new Error("The Workerd creation probe does not update Todos");
    },
    async delete() {
      throw new Error("The Workerd creation probe does not delete Todos");
    },
    async writeList() {
      throw new Error("The Workerd creation probe does not replace Todo lists");
    },
    async clear() {
      throw new Error("The Workerd creation probe does not clear Todo lists");
    },
  };
}

function createReminderProbeRunner(
  records: ScheduledTask[],
): ScheduledTaskRunner {
  return {
    async schedule(input: ScheduledTaskInput) {
      const task: ScheduledTask = {
        taskId: `92000000-0000-4000-8000-${String(records.length + 1).padStart(12, "0")}`,
        ...input,
        state: { status: "scheduled", followupCount: 0 },
      };
      records.push(task);
      return task;
    },
    async list() {
      return records;
    },
    async apply() {
      throw new Error("The Workerd reminder probe does not mutate tasks");
    },
    async pipeline() {
      return [];
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return await runWithCloudBindingsAsync(env, async () => {
      const url = new URL(request.url);
      if (url.pathname === "/todo-turn") {
        const storedTodos: Todo[] = [];
        const scope = {
          agentId: "70000000-0000-5000-8000-000000000001" as UUID,
          entityId: "70000000-0000-5000-8000-000000000002" as UUID,
        };
        const result = await runSharedAgentTurn({
          character: {
            name: "Shared Eliza Workerd Probe",
            system: "You are Eliza.",
            model: "local/shared-runtime-probe",
          },
          history: [],
          message: "add buy milk to my todo list",
          messageIds: {
            user: "70000000-0000-5000-8000-000000000003",
            assistant: "70000000-0000-5000-8000-000000000004",
          },
          execution: {
            engine: "eliza-runtime",
            agentKey: "personal:70000000-0000-5000-8000-000000000005",
            todos: {
              scope,
              store: createTodoProbeStore(storedTodos),
            },
          },
        });
        return Response.json({ result, storedTodos });
      }
      if (url.pathname === "/reminder-turn") {
        const scheduledTasks: ScheduledTask[] = [];
        const result = await runSharedAgentTurn({
          character: {
            name: "Shared Eliza Workerd Probe",
            system: "You are Eliza.",
            model: "local/shared-runtime-probe",
          },
          history: [],
          message: "remind me in two minutes to stretch",
          messageIds: {
            user: "70000000-0000-5000-8000-000000000013",
            assistant: "70000000-0000-5000-8000-000000000014",
          },
          execution: {
            engine: "eliza-runtime",
            agentKey: "personal:70000000-0000-5000-8000-000000000015",
            reminders: {
              delivery: {
                platform: "discord",
                discordUserId: "123456789012345678",
              },
              runner: createReminderProbeRunner(scheduledTasks),
            },
          },
        });
        return Response.json({ result, scheduledTasks });
      }
      if (url.pathname === "/search-turn") {
        const result = await runSharedAgentTurn({
          character: {
            name: "Shared Eliza Workerd Probe",
            system: "You are Eliza.",
            model: "local/shared-runtime-probe",
          },
          history: [],
          message: "What is the latest ElizaOS release?",
          messageIds: {
            user: "6328e4cb-4a1f-4d9c-a2fd-769e5fd33aa1",
            assistant: "059e33bc-8215-49f4-841f-7642e7505bc7",
          },
          execution: {
            engine: "eliza-runtime",
            agentKey: "personal:b55d99d0-ae38-4c7c-8791-7443e5de8ebc",
          },
        });
        return Response.json(result);
      }
      if (url.pathname === "/search") {
        const result = await searchKeylessWeb(url.searchParams.get("q") ?? "");
        return Response.json(result ?? { error: "search unavailable" }, {
          status: result ? 200 : 503,
        });
      }
      const result = await runSharedAgentTurn({
        character: {
          name: "Shared Eliza Workerd Probe",
          system: "You are Eliza.",
          model: "local/shared-runtime-probe",
        },
        history: [],
        message: "say hello",
        messageIds: {
          user: "c92f5aaa-59ce-40a6-994b-e9e16dc85198",
          assistant: "f492130b-2fc6-4b2b-bdca-51f441b0483d",
        },
        execution: {
          engine: "eliza-runtime",
          agentKey: "personal:39e40424-28eb-41fc-8844-63d16e84e14f",
        },
      });
      return Response.json(result);
    });
  },
};
