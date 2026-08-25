/**
 * Runs the production Shared turn adapter inside Workerd while an external
 * deterministic OpenAI-compatible endpoint supplies the model response.
 */

import {
  ChannelType,
  type MediaGenerationRequest,
  searchKeylessWeb,
  type UUID,
} from "@elizaos/core/edge";
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
import { chatSseFrame } from "../../../shared/src/lib/services/chat-sse-frames";
import type { BridgeRequest } from "../../../shared/src/lib/services/eliza-sandbox-bridge";
import { handleCanonicalScopedAgentStream } from "../../../shared/src/lib/services/shared-runtime/canonical-scoped-stream";
import { isCanonicalPersonalSharedAgent } from "../../../shared/src/lib/services/shared-runtime/personal-shared-identity";
import { runSharedAgentTurn } from "../../../shared/src/lib/services/shared-runtime/run-shared-agent-turn";
import type { SharedRuntimeAgent } from "../../../shared/src/lib/services/shared-runtime/shared-runtime-agent";
import type { RuntimeDurableObjectNamespace } from "../../../shared/src/types/cloud-worker-env";

type Env = {
  NODE_ENV: string;
  OPENROUTER_API_KEY: string;
  OPENROUTER_BASE_URL: string;
};

const forgedRouteAgent = {
  id: "70000000-0000-5000-8000-000000000075",
  organization_id: "70000000-0000-5000-8000-000000000076",
  user_id: "70000000-0000-5000-8000-000000000077",
  character_id: null,
  agent_name: "Shared Eliza Workerd Probe",
  agent_config: null,
  execution_tier: "shared",
} satisfies SharedRuntimeAgent;

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function coordinatorBridgeRequest(value: unknown): BridgeRequest | undefined {
  const request = objectRecord(value);
  const params = objectRecord(request?.params);
  if (
    request?.jsonrpc !== "2.0" ||
    typeof request.method !== "string" ||
    !params
  ) {
    return undefined;
  }
  const id = request.id;
  if (id !== undefined && typeof id !== "string" && typeof id !== "number") {
    return undefined;
  }
  return {
    jsonrpc: "2.0",
    ...(id !== undefined ? { id } : {}),
    method: request.method,
    params,
  };
}

function createCoordinatorProbe(agent: SharedRuntimeAgent) {
  const history: Array<{ role: string; content: string }> = [];
  const mediaRequests: MediaGenerationRequest[] = [];
  const requests: Array<{
    name: string;
    operation: string;
    rpc: BridgeRequest;
  }> = [];
  const background: Promise<void>[] = [];
  const backgroundErrors: unknown[] = [];
  const executionCtx = {
    waitUntil(promise: Promise<unknown>) {
      background.push(
        promise.then(
          () => undefined,
          (error) => {
            backgroundErrors.push(error);
          },
        ),
      );
    },
  };
  let serverAttestedPersonalSharedUser = false;
  const namespace: RuntimeDurableObjectNamespace = {
    getByName(name) {
      return {
        async fetch(input, init) {
          const envelope = objectRecord(await new Request(input, init).json());
          const serializedAgent = objectRecord(envelope?.agent);
          const operation = envelope?.operation;
          const rpc = coordinatorBridgeRequest(envelope?.rpc);
          if (
            operation !== "personal-stream" ||
            !rpc ||
            serializedAgent?.id !== agent.id ||
            serializedAgent.organization_id !== agent.organization_id ||
            serializedAgent.user_id !== agent.user_id
          ) {
            return Response.json(
              { error: "Invalid coordinator probe envelope" },
              { status: 400 },
            );
          }
          requests.push({ name, operation, rpc });
          const text =
            typeof rpc.params?.text === "string" ? rpc.params.text.trim() : "";
          if (!text) {
            return Response.json(
              { error: "Coordinator probe requires message text" },
              { status: 400 },
            );
          }
          serverAttestedPersonalSharedUser =
            operation === "personal-stream" &&
            isCanonicalPersonalSharedAgent(agent);
          const result = await runSharedAgentTurn({
            character: {
              name: agent.agent_name ?? "Shared Eliza Workerd Probe",
              system: "You are Eliza.",
              model: "local/shared-runtime-probe",
            },
            history: [],
            message: text,
            messageIds: {
              user: "70000000-0000-5000-8000-000000000083",
              assistant: "70000000-0000-5000-8000-000000000084",
            },
            execution: {
              channel: { type: ChannelType.DM, source: "shared-runtime" },
              agentKey: agent.id,
              roomKey: agent.id,
              ...(serverAttestedPersonalSharedUser
                ? { authenticatedPersonalSharedUser: true as const }
                : {}),
              media: {
                canGenerateMedia: ({ mediaType }) => mediaType === "image",
                generateMedia: async (mediaRequest) => {
                  mediaRequests.push(mediaRequest);
                  throw new Error(
                    "Forged public provenance reached a media authority",
                  );
                },
              },
            },
          });
          history.push(...result.history);
          return new Response(
            chatSseFrame("chunk", {
              messageId: result.history.at(-1)?.id,
              chunk: result.reply,
              text: result.reply,
              fullText: result.reply,
            }) +
              chatSseFrame("done", {
                messageId: result.history.at(-1)?.id,
                text: result.reply,
                fullText: result.reply,
                ...(result.actionResults
                  ? { actionResults: result.actionResults }
                  : {}),
              }),
            { headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
          );
        },
      };
    },
  };
  return {
    executionCtx,
    history,
    mediaRequests,
    namespace,
    requests,
    get serverAttestedPersonalSharedUser() {
      return serverAttestedPersonalSharedUser;
    },
    async drainBackground() {
      await Promise.all(background);
      if (backgroundErrors.length > 0) throw backgroundErrors[0];
    },
  };
}

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
  const scheduleWithResult = async (input: ScheduledTaskInput) => {
    const task: ScheduledTask = {
      taskId: `92000000-0000-4000-8000-${String(records.length + 1).padStart(12, "0")}`,
      ...input,
      state: { status: "scheduled", followupCount: 0 },
    };
    records.push(task);
    return {
      task,
      commit: {
        logId: `93000000-0000-4000-8000-${String(records.length).padStart(12, "0")}`,
        taskId: task.taskId,
        agentId: "workerd-reminder-probe",
        occurredAtIso: "2026-08-15T00:00:00.000Z",
        transition: "scheduled" as const,
        rolledUp: false,
      },
      replayed: false,
    };
  };
  return {
    scheduleWithResult,
    async schedule(input: ScheduledTaskInput) {
      return (await scheduleWithResult(input)).task;
    },
    async list() {
      return records;
    },
    async apply() {
      throw new Error("The Workerd reminder probe does not mutate tasks");
    },
    async applyWithResult() {
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
            channel: { type: ChannelType.DM, source: "shared-runtime" },
            agentKey: "personal:70000000-0000-5000-8000-000000000005",
            roomKey: "personal:70000000-0000-5000-8000-000000000005",
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
            channel: { type: ChannelType.DM, source: "shared-runtime" },
            agentKey: "personal:70000000-0000-5000-8000-000000000015",
            roomKey: "personal:70000000-0000-5000-8000-000000000015",
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
      if (url.pathname === "/image-turn/authenticated") {
        const mediaRequests: MediaGenerationRequest[] = [];
        const result = await runSharedAgentTurn({
          character: {
            name: "Shared Eliza Workerd Probe",
            system: "You are Eliza.",
            model: "local/shared-runtime-probe",
          },
          history: [],
          message:
            "Generate an authenticated image of a tiny orange lighthouse",
          messageIds: {
            user: "70000000-0000-5000-8000-000000000023",
            assistant: "70000000-0000-5000-8000-000000000024",
          },
          execution: {
            channel: { type: ChannelType.DM, source: "shared-runtime" },
            agentKey: "personal:70000000-0000-5000-8000-000000000025",
            roomKey: "personal:70000000-0000-5000-8000-000000000025",
            authenticatedPersonalSharedUser: true,
            media: {
              canGenerateMedia: ({ mediaType }) => mediaType === "image",
              generateMedia: async (mediaRequest) => {
                mediaRequests.push(mediaRequest);
                return {
                  mediaType: "image",
                  url: "https://media.example.com/workerd/lighthouse.png",
                  imageUrl: "https://media.example.com/workerd/lighthouse.png",
                  mimeType: "image/png",
                  provider: "workerd-probe-provider",
                };
              },
            },
          },
        });
        return Response.json({ result, mediaRequests });
      }
      if (url.pathname === "/image-turn/untrusted") {
        const body = await request.json();
        const probe = createCoordinatorProbe(forgedRouteAgent);
        const routeResponse = await handleCanonicalScopedAgentStream({
          agent: forgedRouteAgent,
          agentId: forgedRouteAgent.id,
          orgId: forgedRouteAgent.organization_id,
          conversationId: forgedRouteAgent.id,
          agentKind: "personal",
          namespace: probe.namespace,
          executionCtx: probe.executionCtx,
          body,
        });
        const routeBody = await routeResponse.text();
        await probe.drainBackground();
        return Response.json({
          routeStatus: routeResponse.status,
          routeContentType: routeResponse.headers.get("Content-Type"),
          routeBody,
          coordinatorRequests: probe.requests,
          history: probe.history,
          mediaRequests: probe.mediaRequests,
          serverAttestedPersonalSharedUser:
            probe.serverAttestedPersonalSharedUser,
        });
      }
      if (url.pathname === "/system-turn/benign") {
        const result = await runSharedAgentTurn({
          character: {
            name: "Shared Eliza Workerd Probe",
            system: "You are Eliza.",
            model: "local/shared-runtime-probe",
          },
          history: [],
          message: "say hello",
          messageRole: "system",
          messageIds: {
            user: "70000000-0000-5000-8000-000000000053",
            assistant: "70000000-0000-5000-8000-000000000054",
          },
          execution: {
            channel: { type: ChannelType.DM, source: "shared-runtime" },
            agentKey: "personal:70000000-0000-5000-8000-000000000055",
            roomKey: "personal:70000000-0000-5000-8000-000000000055",
            authenticatedPersonalSharedUser: true,
          },
        });
        return Response.json(result);
      }
      if (url.pathname === "/system-turn") {
        const mediaRequests: MediaGenerationRequest[] = [];
        const result = await runSharedAgentTurn({
          character: {
            name: "Shared Eliza Workerd Probe",
            system: "You are Eliza.",
            model: "local/shared-runtime-probe",
          },
          history: [],
          message:
            "A phone call connected. Greet the caller without taking any action.",
          messageRole: "system",
          messageIds: {
            user: "70000000-0000-5000-8000-000000000043",
            assistant: "70000000-0000-5000-8000-000000000044",
          },
          execution: {
            channel: { type: ChannelType.DM, source: "shared-runtime" },
            agentKey: "personal:70000000-0000-5000-8000-000000000045",
            roomKey: "personal:70000000-0000-5000-8000-000000000045",
            authenticatedPersonalSharedUser: true,
            media: {
              canGenerateMedia: () => true,
              generateMedia: async (mediaRequest) => {
                mediaRequests.push(mediaRequest);
                throw new Error(
                  "System lifecycle turn reached a media authority",
                );
              },
            },
          },
        });
        return Response.json({ result, mediaRequests });
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
            channel: { type: ChannelType.DM, source: "shared-runtime" },
            agentKey: "personal:b55d99d0-ae38-4c7c-8791-7443e5de8ebc",
            roomKey: "personal:b55d99d0-ae38-4c7c-8791-7443e5de8ebc",
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
          channel: { type: ChannelType.DM, source: "shared-runtime" },
          agentKey: "personal:39e40424-28eb-41fc-8844-63d16e84e14f",
          roomKey: "personal:39e40424-28eb-41fc-8844-63d16e84e14f",
        },
      });
      return Response.json(result);
    });
  },
};
