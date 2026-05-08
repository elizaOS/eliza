import type http from "node:http";
import {
  extractConversationMetadataFromRoom,
  isAutomationConversationMetadata,
} from "@elizaos/agent/api/conversation-metadata";
import type {
  ConversationMetadata,
  ConversationScope,
} from "@elizaos/agent/api/server-types";
import { toWorkbenchTask } from "@elizaos/agent/api/workbench-helpers";
import { loadElizaConfig } from "@elizaos/agent/config/config";
import {
  listTriggerTasks,
  taskToTriggerSummary,
} from "@elizaos/agent/triggers/runtime";
import type { TriggerSummary } from "@elizaos/agent/triggers/types";
import {
  type AgentRuntime,
  type Room,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { ensureRouteAuthorized } from "./auth";
import { listAutomationNodeContributors } from "./automation-node-contributors";
import type { N8nStatusResponse, N8nWorkflow } from "./client-types-chat";
import type {
  AutomationItem,
  AutomationLastExecution,
  AutomationNodeCatalogResponse,
  AutomationNodeDescriptor,
  AutomationRoomBinding,
  AutomationSummary,
  WorkbenchTask,
} from "./client-types-config";
import type { CompatRuntimeState } from "./compat-route-shared";
import {
  sendJsonError as sendJsonErrorResponse,
  sendJson as sendJsonResponse,
} from "./response";

interface AutomationListResponse {
  automations: AutomationItem[];
  summary: AutomationSummary;
  n8nStatus: N8nStatusResponse | null;
  workflowFetchError: string | null;
}

interface AutomationRoomRecord {
  title: string;
  roomId: string;
  conversationId: string | null;
  metadata: ConversationMetadata;
  updatedAt: string | null;
}

interface N8nRouteCapture<T> {
  status: number;
  payload: T | null;
}

type N8nJsonResponder = (
  res: http.ServerResponse,
  body: unknown,
  status?: number,
) => void;

interface N8nRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  config: ReturnType<typeof loadElizaConfig>;
  runtime: AgentRuntime;
  json: N8nJsonResponder;
}

type N8nRouteHandler = (context: N8nRouteContext) => Promise<void> | void;

const WORKFLOW_DRAFT_TITLE = "New Workflow Draft";
const N8N_ROUTES_MODULE: string =
  "@elizaos/plugin-n8n-workflow/routes/n8n-routes";
const SYSTEM_TASK_NAMES = new Set([
  "EMBEDDING_DRAIN",
  "PROACTIVE_AGENT",
  "LIFEOPS_SCHEDULER",
  "TRIGGER_DISPATCH",
  "heartbeat",
]);
const BLOCKED_AUTOMATION_PROVIDER_NODES = new Set([
  "recent-conversations",
  "relevant-conversations",
]);

// 30s cache for last-execution data — avoids hammering n8n on every automations poll.
// null data = checked and found no executions yet (still cached to avoid re-polling).
const lastExecutionCache = new Map<string, { data: AutomationLastExecution | null; expiresAt: number }>();
const LAST_EXECUTION_TTL_MS = 30_000;

interface StaticAutomationNodeSpec {
  id: string;
  label: string;
  description: string;
  class: AutomationNodeDescriptor["class"];
  backingCapability: string;
  actionNames: string[];
  pluginNames: string[];
  ownerScoped: boolean;
  enabledWithoutRuntimeCapability: boolean;
  disabledReason: string;
}

const STATIC_AUTOMATION_NODE_SPECS: StaticAutomationNodeSpec[] = [
  {
    id: "crypto:evm.swap",
    label: "EVM swap",
    description:
      "EVM token swap automation backed by a loaded EVM runtime action.",
    class: "action",
    backingCapability: "SWAP",
    actionNames: ["SWAP", "SWAP_TOKENS", "SWAP_TOKEN"],
    pluginNames: ["evm", "wallet", "plugin-wallet", "@elizaos/plugin-wallet"],
    ownerScoped: true,
    enabledWithoutRuntimeCapability: false,
    disabledReason: "Load the EVM plugin with swap support.",
  },
  {
    id: "crypto:evm.bridge",
    label: "EVM bridge",
    description:
      "EVM cross-chain bridge automation backed by a loaded EVM runtime action.",
    class: "action",
    backingCapability: "CROSS_CHAIN_TRANSFER",
    actionNames: ["CROSS_CHAIN_TRANSFER", "BRIDGE", "BRIDGE_TOKENS"],
    pluginNames: ["evm", "wallet", "plugin-wallet", "@elizaos/plugin-wallet"],
    ownerScoped: true,
    enabledWithoutRuntimeCapability: false,
    disabledReason: "Load the EVM plugin with bridge support.",
  },
  {
    id: "crypto:solana.swap",
    label: "Solana swap",
    description:
      "Solana token swap automation backed by a loaded Solana runtime action.",
    class: "action",
    backingCapability: "SWAP_SOLANA",
    actionNames: [
      "SWAP_SOLANA",
      "SWAP_SOL",
      "SWAP_TOKENS_SOLANA",
      "TOKEN_SWAP_SOLANA",
      "TRADE_TOKENS_SOLANA",
      "EXCHANGE_TOKENS_SOLANA",
    ],
    pluginNames: [
      "chain_solana",
      "solana",
      "wallet",
      "plugin-wallet",
      "@elizaos/plugin-wallet",
    ],
    ownerScoped: true,
    enabledWithoutRuntimeCapability: false,
    disabledReason: "Load the Solana plugin with swap support.",
  },
  {
    id: "crypto:hyperliquid.action",
    label: "Hyperliquid action",
    description:
      "Hyperliquid automation entry point backed by a loaded Hyperliquid runtime plugin.",
    class: "action",
    backingCapability: "HYPERLIQUID_ACTION",
    actionNames: [
      "HYPERLIQUID_ACTION",
      "HYPERLIQUID_ORDER",
      "HYPERLIQUID_TRADE",
    ],
    pluginNames: [
      "hyperliquid",
      "plugin-hyperliquid",
      "@elizaos/plugin-hyperliquid",
    ],
    ownerScoped: true,
    enabledWithoutRuntimeCapability: false,
    disabledReason: "Load the Hyperliquid runtime plugin.",
  },
  {
    id: "trigger:order.schedule",
    label: "Order schedule",
    description:
      "Schedule order-intent workflows; venue execution still requires a loaded trading action.",
    class: "trigger",
    backingCapability: "ORDER_SCHEDULE",
    actionNames: [],
    pluginNames: [],
    ownerScoped: false,
    enabledWithoutRuntimeCapability: true,
    disabledReason: "Automation schedules are unavailable.",
  },
  {
    id: "trigger:order.event",
    label: "Order event",
    description:
      "React to order lifecycle events emitted by a loaded trading venue plugin.",
    class: "trigger",
    backingCapability: "ORDER_EVENT",
    actionNames: [
      "ORDER_EVENT",
      "ORDER_FILLED",
      "ORDER_UPDATED",
      "HYPERLIQUID_ACTION",
    ],
    pluginNames: [
      "hyperliquid",
      "plugin-hyperliquid",
      "@elizaos/plugin-hyperliquid",
    ],
    ownerScoped: false,
    enabledWithoutRuntimeCapability: false,
    disabledReason: "Load an order-event-capable runtime plugin.",
  },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeDateValue(value: unknown): string | null {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return null;
}

function humanizeCapabilityName(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function resolveAgentName(
  runtime: AgentRuntime | null,
  config: ReturnType<typeof loadElizaConfig>,
): string {
  return (
    runtime?.character?.name?.trim() ||
    config.ui?.assistant?.name?.trim() ||
    "Eliza"
  );
}

function resolveAdminEntityId(
  config: ReturnType<typeof loadElizaConfig>,
  agentName: string,
): UUID {
  const configured = config.agents?.defaults?.adminEntityId?.trim();
  if (configured) {
    return configured as UUID;
  }
  return stringToUuid(`${agentName}-admin-entity`) as UUID;
}

function isSystemTask(task: WorkbenchTask): boolean {
  if (SYSTEM_TASK_NAMES.has(task.name)) {
    return true;
  }
  const tags = new Set(task.tags ?? []);
  return tags.has("queue") && tags.has("repeat");
}

function choosePreferredSystemTask(
  current: WorkbenchTask,
  candidate: WorkbenchTask,
): WorkbenchTask {
  const currentHasDescription = current.description.trim().length > 0;
  const candidateHasDescription = candidate.description.trim().length > 0;
  if (candidateHasDescription && !currentHasDescription) {
    return candidate;
  }
  if (currentHasDescription && !candidateHasDescription) {
    return current;
  }
  return (candidate.updatedAt ?? 0) > (current.updatedAt ?? 0)
    ? candidate
    : current;
}

function deduplicateSystemTasks(tasks: WorkbenchTask[]): WorkbenchTask[] {
  const systemTasksByName = new Map<string, WorkbenchTask>();
  const userTasks: WorkbenchTask[] = [];

  for (const task of tasks) {
    if (!isSystemTask(task)) {
      userTasks.push(task);
      continue;
    }
    const existing = systemTasksByName.get(task.name);
    if (!existing) {
      systemTasksByName.set(task.name, task);
      continue;
    }
    systemTasksByName.set(task.name, choosePreferredSystemTask(existing, task));
  }

  return [...userTasks, ...systemTasksByName.values()];
}

function buildRoomBinding(
  room: AutomationRoomRecord | undefined,
): AutomationRoomBinding | null {
  if (!room) {
    return null;
  }
  return {
    conversationId: room.conversationId,
    roomId: room.roomId,
    scope: (room.metadata.scope ?? "general") as ConversationScope,
    ...(room.metadata.sourceConversationId
      ? { sourceConversationId: room.metadata.sourceConversationId }
      : {}),
    ...(room.metadata.terminalBridgeConversationId
      ? {
          terminalBridgeConversationId:
            room.metadata.terminalBridgeConversationId,
        }
      : {}),
  };
}

function readAutomationRoomRecord(
  room: Record<string, unknown>,
): AutomationRoomRecord | null {
  const roomId = asString(room.id);
  if (!roomId) {
    return null;
  }

  const metadata = extractConversationMetadataFromRoom(
    room as unknown as Pick<Room, "metadata">,
  );
  if (!metadata || !isAutomationConversationMetadata(metadata)) {
    return null;
  }

  const webConversation = asRecord(asRecord(room.metadata)?.webConversation);

  return {
    title: asString(room.name) ?? "Automation",
    roomId,
    conversationId: asString(webConversation?.conversationId) ?? null,
    metadata,
    updatedAt: normalizeDateValue(room.updatedAt),
  };
}

let n8nRouteHandlerPromise: Promise<N8nRouteHandler | null> | null = null;

async function loadN8nRouteHandler(): Promise<N8nRouteHandler | null> {
  n8nRouteHandlerPromise ??= import(N8N_ROUTES_MODULE)
    .then((mod: unknown) => {
      const handler = (mod as { handleN8nRoutes?: unknown }).handleN8nRoutes;
      return typeof handler === "function"
        ? (handler as N8nRouteHandler)
        : null;
    })
    .catch(() => null);
  return n8nRouteHandlerPromise;
}

async function listAutomationRooms(
  runtime: AgentRuntime,
  agentName: string,
): Promise<AutomationRoomRecord[]> {
  const worldId = stringToUuid(`${agentName}-web-chat-world`) as UUID;
  const rooms = await runtime.getRooms(worldId);
  return rooms
    .map((room) =>
      readAutomationRoomRecord(room as unknown as Record<string, unknown>),
    )
    .filter((room): room is AutomationRoomRecord => room !== null);
}

async function invokeN8nCompatRoute<T>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime,
  pathname: string,
): Promise<N8nRouteCapture<T>> {
  const handleN8nRoutes = await loadN8nRouteHandler();
  if (!handleN8nRoutes) {
    return {
      status: 503,
      payload: { error: "n8n workflow routes are unavailable" } as T,
    };
  }

  let payload: T | null = null;
  let status = 200;

  await handleN8nRoutes({
    req,
    res,
    method: "GET",
    pathname,
    config: loadElizaConfig(),
    runtime,
    json: (_res: http.ServerResponse, body: unknown, nextStatus = 200) => {
      payload = body as T;
      status = nextStatus;
    },
  });

  return { status, payload };
}

function extractErrorMessage(payload: unknown): string | null {
  const record = asRecord(payload);
  const errorValue = record?.error ?? record?.message;
  return typeof errorValue === "string" && errorValue.trim().length > 0
    ? errorValue
    : null;
}

function buildCoordinatorTaskItem(
  task: WorkbenchTask,
  room: AutomationRoomRecord | undefined,
): AutomationItem {
  const system = isSystemTask(task);
  return {
    id: `task:${task.id}`,
    type: "coordinator_text",
    source: "workbench_task",
    title: task.name,
    description: task.description,
    status: system ? "system" : task.isCompleted ? "completed" : "active",
    enabled: !task.isCompleted,
    system,
    isDraft: false,
    hasBackingWorkflow: false,
    updatedAt: room?.updatedAt ?? normalizeDateValue(task.updatedAt),
    taskId: task.id,
    task,
    schedules: [],
    room: buildRoomBinding(room),
  };
}

function buildCoordinatorTriggerItem(
  trigger: TriggerSummary,
  room: AutomationRoomRecord | undefined,
): AutomationItem {
  return {
    id: `trigger:${trigger.id}`,
    type: "coordinator_text",
    source: "trigger",
    title: trigger.displayName,
    description: trigger.instructions,
    status: trigger.enabled ? "active" : "paused",
    enabled: trigger.enabled,
    system: false,
    isDraft: false,
    hasBackingWorkflow: false,
    updatedAt:
      room?.updatedAt ??
      normalizeDateValue(trigger.updatedAt) ??
      normalizeDateValue(trigger.lastRunAtIso),
    triggerId: trigger.id,
    trigger,
    schedules: [trigger],
    room: buildRoomBinding(room),
  };
}

function buildWorkflowDraftItem(room: AutomationRoomRecord): AutomationItem {
  const metadata = room.metadata;
  const title =
    metadata.workflowName?.trim() || room.title.trim() || WORKFLOW_DRAFT_TITLE;
  return {
    id: `workflow-draft:${metadata.draftId}`,
    type: "n8n_workflow",
    source: "workflow_draft",
    title,
    description: "",
    status: "draft",
    enabled: true,
    system: false,
    isDraft: true,
    hasBackingWorkflow: false,
    updatedAt: room.updatedAt,
    draftId: room.metadata.draftId,
    schedules: [],
    room: buildRoomBinding(room),
  };
}

function buildAutomationDraftItem(room: AutomationRoomRecord): AutomationItem {
  const metadata = room.metadata;
  const trimmedTitle = room.title.trim();
  const title =
    trimmedTitle && trimmedTitle.toLowerCase() !== "default"
      ? trimmedTitle
      : "New automation";
  return {
    id: `automation-draft:${metadata.draftId}`,
    type: "automation_draft",
    source: "automation_draft",
    title,
    description: "",
    status: "draft",
    enabled: true,
    system: false,
    isDraft: true,
    hasBackingWorkflow: false,
    updatedAt: room.updatedAt,
    draftId: metadata.draftId,
    schedules: [],
    room: buildRoomBinding(room),
  };
}

function buildWorkflowItem(
  workflow: N8nWorkflow | undefined,
  room: AutomationRoomRecord | undefined,
  fallback: {
    workflowId: string;
    workflowName?: string;
    trigger?: TriggerSummary;
  },
): AutomationItem {
  const missingBackingWorkflow = !workflow && !fallback.trigger;
  const title =
    workflow?.name?.trim() ||
    room?.metadata.workflowName?.trim() ||
    fallback.workflowName?.trim() ||
    fallback.workflowId;
  const enabled =
    missingBackingWorkflow === true
      ? false
      : (workflow?.active ?? fallback.trigger?.enabled ?? false);
  const description =
    workflow?.description?.trim() ||
    (fallback.trigger ? `Scheduled workflow automation for ${title}.` : "");

  return {
    id: `workflow:${fallback.workflowId}`,
    type: "n8n_workflow",
    source: workflow ? "n8n_workflow" : "workflow_shadow",
    title,
    description,
    status: missingBackingWorkflow ? "draft" : enabled ? "active" : "paused",
    enabled,
    system: false,
    isDraft: missingBackingWorkflow,
    hasBackingWorkflow: Boolean(workflow),
    updatedAt:
      room?.updatedAt ??
      normalizeDateValue(fallback.trigger?.updatedAt) ??
      normalizeDateValue(fallback.trigger?.lastRunAtIso),
    workflowId: fallback.workflowId,
    workflow,
    schedules: fallback.trigger ? [fallback.trigger] : [],
    room: buildRoomBinding(room),
  };
}

function compareAutomationItems(
  left: AutomationItem,
  right: AutomationItem,
): number {
  if (left.system !== right.system) {
    return left.system ? 1 : -1;
  }
  if (left.isDraft !== right.isDraft) {
    return left.isDraft ? -1 : 1;
  }
  const leftUpdated = left.updatedAt ? Date.parse(left.updatedAt) : 0;
  const rightUpdated = right.updatedAt ? Date.parse(right.updatedAt) : 0;
  if (rightUpdated !== leftUpdated) {
    return rightUpdated - leftUpdated;
  }
  return left.title.localeCompare(right.title);
}

async function buildAutomationListResponse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<AutomationListResponse> {
  const runtime = state.current;
  if (!runtime) {
    throw new Error("Agent runtime is not available");
  }

  const config = loadElizaConfig();
  const agentName = resolveAgentName(runtime, config);
  const rooms = await listAutomationRooms(runtime, agentName);
  const taskRooms = new Map(
    rooms
      .filter((room) => room.metadata.taskId)
      .map((room) => [room.metadata.taskId as string, room]),
  );
  const triggerRooms = new Map(
    rooms
      .filter((room) => room.metadata.triggerId)
      .map((room) => [room.metadata.triggerId as string, room]),
  );
  const workflowRooms = new Map(
    rooms
      .filter((room) => room.metadata.workflowId)
      .map((room) => [room.metadata.workflowId as string, room]),
  );
  const workflowDraftItems = rooms
    .filter((room) => room.metadata.scope === "automation-workflow-draft")
    .filter((room) => typeof room.metadata.draftId === "string")
    .map((room) => buildWorkflowDraftItem(room));
  const automationDraftItems = rooms
    .filter((room) => room.metadata.scope === "automation-draft")
    .filter((room) => typeof room.metadata.draftId === "string")
    .map((room) => buildAutomationDraftItem(room));

  const tasks = deduplicateSystemTasks(
    (await runtime.getTasks({}))
      .map((task) => toWorkbenchTask(task))
      .filter((task): task is WorkbenchTask => task !== null),
  );

  const triggerItems = (await listTriggerTasks(runtime))
    .map((task) => taskToTriggerSummary(task))
    .filter((trigger): trigger is TriggerSummary => trigger !== null);
  const triggerTaskIds = new Set(triggerItems.map((trigger) => trigger.taskId));
  const taskItems = tasks
    .filter((task) => !triggerTaskIds.has(task.id))
    .map((task) => buildCoordinatorTaskItem(task, taskRooms.get(task.id)));

  const n8nStatusResult = await invokeN8nCompatRoute<N8nStatusResponse>(
    req,
    res,
    runtime,
    "/api/n8n/status",
  );
  const n8nStatus =
    n8nStatusResult.status === 200 ? n8nStatusResult.payload : null;

  const n8nWorkflowsResult = await invokeN8nCompatRoute<{
    workflows?: N8nWorkflow[];
    error?: string;
  }>(req, res, runtime, "/api/n8n/workflows");
  const workflowFetchError =
    n8nWorkflowsResult.status === 200
      ? null
      : (extractErrorMessage(n8nWorkflowsResult.payload) ??
        "Unable to load workflows");
  const workflowList =
    n8nWorkflowsResult.status === 200 &&
    Array.isArray(n8nWorkflowsResult.payload?.workflows)
      ? n8nWorkflowsResult.payload.workflows
      : [];

  const workflowItemsById = new Map<string, AutomationItem>();
  for (const workflow of workflowList) {
    workflowItemsById.set(
      workflow.id,
      buildWorkflowItem(workflow, workflowRooms.get(workflow.id), {
        workflowId: workflow.id,
        workflowName: workflow.name,
      }),
    );
  }

  for (const trigger of triggerItems) {
    if (trigger.kind === "workflow" && trigger.workflowId) {
      const existing = workflowItemsById.get(trigger.workflowId);
      if (existing) {
        existing.schedules = [...existing.schedules, trigger];
        existing.updatedAt =
          existing.updatedAt ??
          normalizeDateValue(trigger.updatedAt) ??
          normalizeDateValue(trigger.lastRunAtIso);
        continue;
      }
      workflowItemsById.set(
        trigger.workflowId,
        buildWorkflowItem(undefined, workflowRooms.get(trigger.workflowId), {
          workflowId: trigger.workflowId,
          workflowName: trigger.workflowName,
          trigger,
        }),
      );
    }
  }

  // Only synthesize workflow items from rooms when n8n itself is offline
  // (`workflowFetchError` set) — in that case the room is the most-recent
  // ground truth we have and should be surfaced. When n8n IS online and
  // returned a list, any workflowId in `workflowRooms` that isn't in the
  // current n8n list is an ORPHAN: the workflow was deleted but the chat
  // room/conversation wasn't cleaned up. Surfacing those creates ghost
  // rows the user can't dismiss. Skip them; the UI's deleteWorkflow path
  // also deletes the conversation now, so future deletions won't leak
  // rooms.
  const n8nOffline = workflowFetchError !== null;
  if (n8nOffline) {
    for (const [workflowId, room] of workflowRooms.entries()) {
      if (!workflowItemsById.has(workflowId)) {
        workflowItemsById.set(
          workflowId,
          buildWorkflowItem(undefined, room, {
            workflowId,
            workflowName: room.metadata.workflowName,
          }),
        );
      }
    }
  }

  // Fetch last execution for each live n8n workflow in parallel.
  // Promise.allSettled ensures one failure does not block the full list.
  if (!n8nOffline && workflowItemsById.size > 0) {
    const now = Date.now();
    for (const [k, v] of lastExecutionCache) {
      if (v.expiresAt < now) lastExecutionCache.delete(k);
    }
    const workflowIds = [...workflowItemsById.keys()];
    await Promise.allSettled(
      workflowIds.map(async (workflowId) => {
        const cached = lastExecutionCache.get(workflowId);
        if (cached && cached.expiresAt > Date.now()) {
          if (cached.data !== null) {
            const item = workflowItemsById.get(workflowId);
            if (item) item.lastExecution = cached.data;
          }
          return;
        }
        const result = await invokeN8nCompatRoute<{ executions?: unknown[] }>(
          req,
          res,
          runtime,
          `/api/n8n/workflows/${encodeURIComponent(workflowId)}/executions?limit=1`,
        );
        if (result.status !== 200 || !Array.isArray(result.payload?.executions)) {
          return;
        }
        if (result.payload.executions.length === 0) {
          lastExecutionCache.set(workflowId, { data: null, expiresAt: Date.now() + LAST_EXECUTION_TTL_MS });
          return;
        }
        const raw = result.payload.executions[0] as Record<string, unknown>;
        const exec = normalizeLastExecution(raw);
        if (!exec) return;
        lastExecutionCache.set(workflowId, { data: exec, expiresAt: Date.now() + LAST_EXECUTION_TTL_MS });
        const item = workflowItemsById.get(workflowId);
        if (item) item.lastExecution = exec;
      }),
    );
  }

  const coordinatorTriggerItems = triggerItems
    .filter((trigger) => trigger.kind !== "workflow")
    .map((trigger) =>
      buildCoordinatorTriggerItem(trigger, triggerRooms.get(trigger.id)),
    );

  const automations = [
    ...automationDraftItems,
    ...workflowDraftItems,
    ...taskItems,
    ...coordinatorTriggerItems,
    ...workflowItemsById.values(),
  ].sort(compareAutomationItems);

  const summary: AutomationSummary = {
    total: automations.length,
    coordinatorCount: automations.filter(
      (automation) => automation.type === "coordinator_text",
    ).length,
    workflowCount: automations.filter(
      (automation) => automation.type === "n8n_workflow",
    ).length,
    scheduledCount: automations.filter(
      (automation) => automation.schedules.length > 0,
    ).length,
    draftCount: automations.filter((automation) => automation.isDraft).length,
  };

  return {
    automations,
    summary,
    n8nStatus,
    workflowFetchError,
  };
}

function normalizeLastExecution(raw: Record<string, unknown>): AutomationLastExecution | null {
  const rawStatus = raw.status;
  if (typeof rawStatus !== "string") return null;
  const STATUS_MAP: Record<string, AutomationLastExecution["status"]> = {
    success: "success",
    error: "error",
    crashed: "error",
    running: "running",
    waiting: "waiting",
  };
  const status = STATUS_MAP[rawStatus] ?? "unknown";
  const startedAt = typeof raw.startedAt === "string" ? raw.startedAt : null;
  if (!startedAt) return null;
  const stoppedAt = typeof raw.stoppedAt === "string" ? raw.stoppedAt : null;
  const errorMessage = (() => {
    const data = raw.data as Record<string, unknown> | undefined;
    const resultData = data?.resultData as Record<string, unknown> | undefined;
    const error = resultData?.error as Record<string, unknown> | undefined;
    return typeof error?.message === "string" ? error.message : undefined;
  })();
  return { status, startedAt, stoppedAt, ...(errorMessage ? { errorMessage } : {}) };
}

function normalizeCapabilityName(value: string): string {
  return value.trim().toLowerCase();
}

function getRuntimeActionCapabilityNames(runtime: AgentRuntime): Set<string> {
  const names = new Set<string>();
  for (const action of runtime.actions) {
    names.add(normalizeCapabilityName(action.name));
    for (const simile of action.similes ?? []) {
      names.add(normalizeCapabilityName(simile));
    }
  }
  return names;
}

function getRuntimePluginNames(runtime: AgentRuntime): Set<string> {
  return new Set(
    (runtime.plugins ?? [])
      .map((plugin) => normalizeCapabilityName(plugin.name))
      .filter((name) => name.length > 0),
  );
}

function hasMatchingRuntimeCapability(
  spec: StaticAutomationNodeSpec,
  actionNames: Set<string>,
  pluginNames: Set<string>,
): boolean {
  if (spec.enabledWithoutRuntimeCapability) {
    return true;
  }
  return (
    spec.actionNames.some((name) =>
      actionNames.has(normalizeCapabilityName(name)),
    ) ||
    spec.pluginNames.some((name) =>
      pluginNames.has(normalizeCapabilityName(name)),
    )
  );
}

function buildStaticAutomationNode(
  spec: StaticAutomationNodeSpec,
  actionNames: Set<string>,
  pluginNames: Set<string>,
): AutomationNodeDescriptor {
  const enabled = hasMatchingRuntimeCapability(spec, actionNames, pluginNames);
  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    class: spec.class,
    source: "static_catalog",
    backingCapability: spec.backingCapability,
    ownerScoped: spec.ownerScoped,
    requiresSetup: !enabled,
    availability: enabled ? "enabled" : "disabled",
    ...(enabled ? {} : { disabledReason: spec.disabledReason }),
  };
}

async function buildAutomationNodeCatalog(
  state: CompatRuntimeState,
): Promise<AutomationNodeCatalogResponse> {
  const runtime = state.current;
  if (!runtime) {
    throw new Error("Agent runtime is not available");
  }

  const config = loadElizaConfig();
  const agentName = resolveAgentName(runtime, config);
  const adminEntityId = resolveAdminEntityId(config, agentName);

  const runtimeActionNodes: AutomationNodeDescriptor[] = runtime.actions
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((action) => ({
      id: `action:${action.name}`,
      label: humanizeCapabilityName(action.name),
      description: action.description || `${action.name} runtime action`,
      class:
        action.name === "START_CODING_TASK" ||
        action.name === "CREATE_TASK" ||
        action.name === "CODE_TASK"
          ? "agent"
          : "action",
      source: "runtime_action",
      backingCapability: action.name,
      ownerScoped: false,
      requiresSetup: false,
      availability: "enabled",
    }));

  const runtimeProviderNodes: AutomationNodeDescriptor[] = runtime.providers
    .slice()
    .filter((provider) => !BLOCKED_AUTOMATION_PROVIDER_NODES.has(provider.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((provider) => ({
      id: `provider:${provider.name}`,
      label: humanizeCapabilityName(provider.name),
      description: provider.description || `${provider.name} runtime provider`,
      class: "context",
      source: "runtime_provider",
      backingCapability: provider.name,
      ownerScoped: false,
      requiresSetup: false,
      availability: "enabled",
    }));

  const runtimeActionCapabilityNames = getRuntimeActionCapabilityNames(runtime);
  const runtimePluginNames = getRuntimePluginNames(runtime);
  const staticAutomationNodes = STATIC_AUTOMATION_NODE_SPECS.map((spec) =>
    buildStaticAutomationNode(
      spec,
      runtimeActionCapabilityNames,
      runtimePluginNames,
    ),
  );
  const contributorNodeGroups = await Promise.all(
    listAutomationNodeContributors().map((contributor) =>
      contributor({ runtime, config, agentName, adminEntityId }),
    ),
  );
  const contributorNodes = contributorNodeGroups.flat();

  const nodes = [
    ...runtimeActionNodes,
    ...runtimeProviderNodes,
    ...staticAutomationNodes,
    ...contributorNodes,
  ].sort((left, right) => {
    if (left.class !== right.class) {
      return left.class.localeCompare(right.class);
    }
    return left.label.localeCompare(right.label);
  });

  return {
    nodes,
    summary: {
      total: nodes.length,
      enabled: nodes.filter((node) => node.availability === "enabled").length,
      disabled: nodes.filter((node) => node.availability === "disabled").length,
    },
  };
}

export async function handleAutomationsCompatRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  if (!url.pathname.startsWith("/api/automations")) {
    return false;
  }

  if (!(await ensureRouteAuthorized(req, res, state))) {
    return true;
  }

  if (method === "GET" && url.pathname === "/api/automations") {
    if (!state.current) {
      sendJsonErrorResponse(res, 503, "Agent runtime is not available");
      return true;
    }
    const payload = await buildAutomationListResponse(req, res, state);
    sendJsonResponse(res, 200, payload);
    return true;
  }

  if (method === "GET" && url.pathname === "/api/automations/nodes") {
    if (!state.current) {
      sendJsonErrorResponse(res, 503, "Agent runtime is not available");
      return true;
    }
    const payload = await buildAutomationNodeCatalog(state);
    sendJsonResponse(res, 200, payload);
    return true;
  }

  return false;
}
