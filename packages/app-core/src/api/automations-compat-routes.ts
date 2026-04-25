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
import { LifeOpsService } from "@elizaos/app-lifeops/lifeops/service";
import {
  type AgentRuntime,
  logger,
  type Room,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import type {
  LifeOpsDiscordConnectorStatus,
  LifeOpsGoogleConnectorStatus,
  LifeOpsSignalConnectorStatus,
  LifeOpsTelegramConnectorStatus,
} from "@elizaos/shared/contracts/lifeops";
import { ensureCompatApiAuthorized } from "./auth";
import type { N8nStatusResponse, N8nWorkflow } from "./client-types-chat";
import type {
  AutomationItem,
  AutomationNodeCatalogResponse,
  AutomationNodeDescriptor,
  AutomationRoomBinding,
  AutomationSummary,
  WorkbenchTask,
} from "./client-types-config";
import type { CompatRuntimeState } from "./compat-route-shared";
import { handleN8nRoutes } from "./n8n-routes";
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

const WORKFLOW_DRAFT_TITLE = "New Workflow Draft";
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
  state: CompatRuntimeState,
  pathname: string,
): Promise<N8nRouteCapture<T>> {
  let payload: T | null = null;
  let status = 200;

  await handleN8nRoutes({
    req,
    res,
    method: "GET",
    pathname,
    config: loadElizaConfig(),
    runtime: state.current,
    json: (_res, body, nextStatus = 200) => {
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
    (fallback.trigger
      ? `Scheduled workflow automation for ${title}.`
      : "");

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
    state,
    "/api/n8n/status",
  );
  const n8nStatus =
    n8nStatusResult.status === 200 ? n8nStatusResult.payload : null;

  const n8nWorkflowsResult = await invokeN8nCompatRoute<{
    workflows?: N8nWorkflow[];
    error?: string;
  }>(req, res, state, "/api/n8n/workflows");
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

async function resolveGoogleStatus(
  lifeOps: LifeOpsService,
): Promise<LifeOpsGoogleConnectorStatus | null> {
  try {
    return await lifeOps.getGoogleConnectorStatus(
      new URL("http://127.0.0.1/api/lifeops/connectors/google/status"),
      undefined,
      "owner",
    );
  } catch (error) {
    logger.warn(
      `[automations] Failed to resolve Google connector status: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

async function resolveTelegramStatus(
  lifeOps: LifeOpsService,
): Promise<LifeOpsTelegramConnectorStatus | null> {
  try {
    return await lifeOps.getTelegramConnectorStatus("owner");
  } catch (error) {
    logger.warn(
      `[automations] Failed to resolve Telegram connector status: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

async function resolveSignalStatus(
  lifeOps: LifeOpsService,
): Promise<LifeOpsSignalConnectorStatus | null> {
  try {
    return await lifeOps.getSignalConnectorStatus("owner");
  } catch (error) {
    logger.warn(
      `[automations] Failed to resolve Signal connector status: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

async function resolveDiscordStatus(
  lifeOps: LifeOpsService,
): Promise<LifeOpsDiscordConnectorStatus | null> {
  try {
    return await lifeOps.getDiscordConnectorStatus("owner");
  } catch (error) {
    logger.warn(
      `[automations] Failed to resolve Discord connector status: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function buildLifeOpsNode(
  id: string,
  label: string,
  description: string,
  enabled: boolean,
  disabledReason: string,
): AutomationNodeDescriptor {
  return {
    id,
    label,
    description,
    class: "integration",
    source: "lifeops",
    backingCapability: id,
    ownerScoped: true,
    requiresSetup: true,
    availability: enabled ? "enabled" : "disabled",
    ...(enabled ? {} : { disabledReason }),
  };
}

function buildLifeOpsEventNode(
  eventKind: string,
  label: string,
  description: string,
  enabled: boolean,
  disabledReason: string,
): AutomationNodeDescriptor {
  return {
    id: `event:${eventKind}`,
    label,
    description,
    class: "trigger",
    source: "lifeops_event",
    backingCapability: eventKind,
    ownerScoped: true,
    requiresSetup: !enabled,
    availability: enabled ? "enabled" : "disabled",
    ...(enabled ? {} : { disabledReason }),
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
  const lifeOps = new LifeOpsService(runtime, { ownerEntityId: adminEntityId });
  const [googleStatus, telegramStatus, signalStatus, discordStatus] =
    await Promise.all([
      resolveGoogleStatus(lifeOps),
      resolveTelegramStatus(lifeOps),
      resolveSignalStatus(lifeOps),
      resolveDiscordStatus(lifeOps),
    ]);

  const runtimeActionNodes: AutomationNodeDescriptor[] = runtime.actions
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((action) => ({
      id: `action:${action.name}`,
      label: humanizeCapabilityName(action.name),
      description: action.description || `${action.name} runtime action`,
      class:
        action.name === "CREATE_TASK" || action.name === "CODE_TASK"
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

  const googleCapabilities = new Set(googleStatus?.grantedCapabilities ?? []);
  const githubToken = runtime.getSetting("GITHUB_TOKEN");
  const githubConnected =
    typeof githubToken === "string" && githubToken.trim().length > 0;

  const lifeOpsNodes: AutomationNodeDescriptor[] = [
    buildLifeOpsNode(
      "lifeops:gmail",
      "Gmail",
      "Owner-scoped Gmail triage, drafting, and send operations.",
      Boolean(
        googleStatus?.connected &&
          [...googleCapabilities].some((capability) =>
            capability.includes("gmail"),
          ),
      ),
      "Connect the owner Google account with Gmail access.",
    ),
    buildLifeOpsNode(
      "lifeops:calendar",
      "Calendar",
      "Owner-scoped calendar reading and event creation.",
      Boolean(
        googleStatus?.connected &&
          [...googleCapabilities].some((capability) =>
            capability.includes("calendar"),
          ),
      ),
      "Connect the owner Google account with Calendar access.",
    ),
    buildLifeOpsNode(
      "lifeops:telegram",
      "Telegram",
      "Owner-scoped Telegram account messaging.",
      Boolean(telegramStatus?.connected),
      "Connect the owner Telegram account.",
    ),
    buildLifeOpsNode(
      "lifeops:signal",
      "Signal",
      "Owner-scoped Signal messaging.",
      Boolean(signalStatus?.connected),
      "Pair the owner Signal account.",
    ),
    buildLifeOpsNode(
      "lifeops:discord",
      "Discord",
      "Owner-scoped Discord messaging through the active owner session.",
      Boolean(discordStatus?.connected && discordStatus.available),
      "Connect the owner Discord session.",
    ),
    buildLifeOpsNode(
      "lifeops:github",
      "GitHub",
      "Owner-scoped GitHub access for repositories, issues, and pull requests.",
      githubConnected,
      "Link the owner GitHub account.",
    ),
  ];

  const calendarConnected = Boolean(
    googleStatus?.connected &&
      [...googleCapabilities].some((capability) =>
        capability.includes("calendar"),
      ),
  );
  const lifeOpsEventNodes: AutomationNodeDescriptor[] = [
    buildLifeOpsEventNode(
      "calendar.event.ended",
      "Calendar event ended",
      "Fires a workflow after a synced calendar event's end time has passed.",
      calendarConnected,
      "Connect the owner Google account with Calendar access.",
    ),
  ];

  const nodes = [
    ...runtimeActionNodes,
    ...runtimeProviderNodes,
    ...lifeOpsNodes,
    ...lifeOpsEventNodes,
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

  if (!ensureCompatApiAuthorized(req, res)) {
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
