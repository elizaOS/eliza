/**
 * Builder for the `/api/automations` response surface.
 *
 * Reads workflows in-process via WorkflowService, runtime tasks via the core
 * runtime task API, and draft conversations via runtime room APIs. There is
 * no dynamic import of plugin-workflow because this code IS the plugin.
 *
 * Trigger task lookup: the runtime stores trigger tasks under three tag
 * combinations — `["queue","repeat","trigger"]` for user-defined triggers and
 * `["queue","repeat","heartbeat"]` for plugin-owned heartbeats. We replicate
 * `listTriggerTasks` from `packages/agent/src/triggers/runtime.ts` here
 * because plugin-workflow cannot depend on @elizaos/agent.
 */

import type { AgentRuntime, Room, Task, UUID } from '@elizaos/core';
import { stringToUuid } from '@elizaos/core';
import {
  type AutomationItem,
  type AutomationLastExecution,
  type AutomationListResponse,
  type AutomationRoomBinding,
  type AutomationSummary,
  type ConversationMetadata,
  type ConversationScope,
  type TriggerSummary,
  type WorkbenchTaskView,
  isAutomationConversationMetadata,
  readTriggerConfig,
  taskToTriggerSummary,
  toWorkbenchTaskView,
} from './automations-types';
import { WORKFLOW_SERVICE_TYPE, type WorkflowService } from '../services/workflow-service';
import type { WorkflowDefinition, WorkflowDefinitionResponse } from '../types/index';
import type { WorkflowStatusResponse } from '../routes/workflow-routes';

const WORKFLOW_DRAFT_TITLE = 'New Workflow Draft';

const SYSTEM_TASK_NAMES = new Set([
  'EMBEDDING_DRAIN',
  'PROACTIVE_AGENT',
  'LIFEOPS_SCHEDULER',
  'TRIGGER_DISPATCH',
  'heartbeat',
]);

// 30s cache for last-execution data — avoids hammering the workflow runtime on
// every automations poll. null data = checked and found no executions yet
// (still cached to avoid re-polling).
const lastExecutionCache = new Map<
  string,
  { data: AutomationLastExecution | null; expiresAt: number }
>();
const LAST_EXECUTION_TTL_MS = 30_000;

interface AutomationRoomRecord {
  title: string;
  roomId: string;
  conversationId: string | null;
  metadata: ConversationMetadata;
  updatedAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeDateValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return null;
}

function resolveAgentName(runtime: AgentRuntime): string {
  return runtime.character?.name?.trim() || 'Eliza';
}

function isSystemTask(task: WorkbenchTaskView): boolean {
  if (SYSTEM_TASK_NAMES.has(task.name)) {
    return true;
  }
  const tags = new Set(task.tags ?? []);
  return tags.has('queue') && tags.has('repeat');
}

function choosePreferredSystemTask(
  current: WorkbenchTaskView,
  candidate: WorkbenchTaskView
): WorkbenchTaskView {
  const currentHasDescription = current.description.trim().length > 0;
  const candidateHasDescription = candidate.description.trim().length > 0;
  if (candidateHasDescription && !currentHasDescription) {
    return candidate;
  }
  if (currentHasDescription && !candidateHasDescription) {
    return current;
  }
  return (candidate.updatedAt ?? 0) > (current.updatedAt ?? 0) ? candidate : current;
}

function deduplicateSystemTasks(tasks: WorkbenchTaskView[]): WorkbenchTaskView[] {
  const systemTasksByName = new Map<string, WorkbenchTaskView>();
  const userTasks: WorkbenchTaskView[] = [];

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

function buildRoomBinding(room: AutomationRoomRecord | undefined): AutomationRoomBinding | null {
  if (!room) {
    return null;
  }
  return {
    conversationId: room.conversationId,
    roomId: room.roomId,
    scope: (room.metadata.scope ?? 'general') as ConversationScope,
    ...(room.metadata.sourceConversationId
      ? { sourceConversationId: room.metadata.sourceConversationId }
      : {}),
    ...(room.metadata.terminalBridgeConversationId
      ? {
          terminalBridgeConversationId: room.metadata.terminalBridgeConversationId,
        }
      : {}),
  };
}

function extractConversationMetadataFromRoom(
  room: Pick<Room, 'metadata'> | null | undefined
): ConversationMetadata | undefined {
  const roomMetadata = isRecord(room?.metadata) ? room.metadata : null;
  if (!roomMetadata) {
    return undefined;
  }
  const stored = isRecord(roomMetadata.webConversation) ? roomMetadata.webConversation : null;
  if (!stored) {
    return undefined;
  }
  // The full sanitization lives in @elizaos/agent; here we just extract the
  // metadata fields we actually consume in the automations response.
  const next: ConversationMetadata = {};
  const scope = asString(stored.scope);
  if (scope) next.scope = scope as ConversationScope;
  const automationType = asString(stored.automationType);
  if (automationType === 'coordinator_text' || automationType === 'workflow') {
    next.automationType = automationType;
  }
  const taskId = asString(stored.taskId);
  if (taskId) next.taskId = taskId;
  const triggerId = asString(stored.triggerId);
  if (triggerId) next.triggerId = triggerId;
  const workflowId = asString(stored.workflowId);
  if (workflowId) next.workflowId = workflowId;
  const workflowName = asString(stored.workflowName);
  if (workflowName) next.workflowName = workflowName;
  const draftId = asString(stored.draftId);
  if (draftId) next.draftId = draftId;
  const sourceConversationId = asString(stored.sourceConversationId);
  if (sourceConversationId) next.sourceConversationId = sourceConversationId;
  const terminalBridgeConversationId = asString(stored.terminalBridgeConversationId);
  if (terminalBridgeConversationId) next.terminalBridgeConversationId = terminalBridgeConversationId;
  return Object.keys(next).length > 0 ? next : undefined;
}

function readAutomationRoomRecord(
  room: Room & { updatedAt?: unknown }
): AutomationRoomRecord | null {
  const roomId = asString(room.id);
  if (!roomId) {
    return null;
  }

  const metadata = extractConversationMetadataFromRoom(room);
  if (!metadata || !isAutomationConversationMetadata(metadata)) {
    return null;
  }

  const roomMetadata = isRecord(room.metadata) ? room.metadata : null;
  const webConversation = isRecord(roomMetadata?.webConversation)
    ? roomMetadata.webConversation
    : null;

  return {
    title: asString(room.name) ?? 'Automation',
    roomId,
    conversationId: asString(webConversation?.conversationId) ?? null,
    metadata,
    updatedAt: normalizeDateValue(room.updatedAt),
  };
}

async function listAutomationRooms(
  runtime: AgentRuntime,
  agentName: string
): Promise<AutomationRoomRecord[]> {
  const worldId = stringToUuid(`${agentName}-web-chat-world`) as UUID;
  const rooms = await runtime.getRooms(worldId);
  return rooms
    .map((room) => readAutomationRoomRecord(room))
    .filter((room): room is AutomationRoomRecord => room !== null);
}

/**
 * Replicates `listTriggerTasks` from @elizaos/agent's triggers/runtime.ts.
 * We can't import from @elizaos/agent (would create a dependency cycle),
 * so we hit the runtime's task API directly with the same tag filters.
 * `runtime.getTasks` automatically scopes by `agentId`.
 */
async function listTriggerTasks(runtime: AgentRuntime): Promise<Task[]> {
  const [triggerTasks, heartbeatTasks] = await Promise.all([
    runtime.getTasks({ tags: ['repeat', 'trigger'] }),
    runtime.getTasks({ tags: ['repeat', 'heartbeat'] }),
  ]);

  const merged = new Map<string, Task>();
  for (const task of [...triggerTasks, ...heartbeatTasks]) {
    const key =
      task.id ??
      `${task.name ?? ''}:${task.description ?? ''}:${(task.tags ?? []).join(',')}`;
    if (!merged.has(key)) {
      merged.set(key, task);
    }
  }
  return [...merged.values()];
}

function buildCoordinatorTaskItem(
  task: WorkbenchTaskView,
  room: AutomationRoomRecord | undefined
): AutomationItem {
  const system = isSystemTask(task);
  return {
    id: `task:${task.id}`,
    type: 'coordinator_text',
    source: 'workbench_task',
    title: task.name,
    description: task.description,
    status: system ? 'system' : task.isCompleted ? 'completed' : 'active',
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
  room: AutomationRoomRecord | undefined
): AutomationItem {
  return {
    id: `trigger:${trigger.id}`,
    type: 'coordinator_text',
    source: 'trigger',
    title: trigger.displayName,
    description: trigger.instructions,
    status: trigger.enabled ? 'active' : 'paused',
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
  const title = metadata.workflowName?.trim() || room.title.trim() || WORKFLOW_DRAFT_TITLE;
  return {
    id: `workflow-draft:${metadata.draftId}`,
    type: 'workflow',
    source: 'workflow_draft',
    title,
    description: '',
    status: 'draft',
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
    trimmedTitle && trimmedTitle.toLowerCase() !== 'default' ? trimmedTitle : 'New automation';
  return {
    id: `automation-draft:${metadata.draftId}`,
    type: 'automation_draft',
    source: 'automation_draft',
    title,
    description: '',
    status: 'draft',
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
  workflow: WorkflowDefinition | undefined,
  room: AutomationRoomRecord | undefined,
  fallback: {
    workflowId: string;
    workflowName?: string;
    trigger?: TriggerSummary;
  }
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
    (workflow as { description?: string } | undefined)?.description?.trim() ||
    (fallback.trigger ? `Scheduled workflow automation for ${title}.` : '');

  return {
    id: `workflow:${fallback.workflowId}`,
    type: 'workflow',
    source: workflow ? 'workflow' : 'workflow_shadow',
    title,
    description,
    status: missingBackingWorkflow ? 'draft' : enabled ? 'active' : 'paused',
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

function compareAutomationItems(left: AutomationItem, right: AutomationItem): number {
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

function normalizeLastExecution(raw: Record<string, unknown>): AutomationLastExecution | null {
  const rawStatus = raw.status;
  if (typeof rawStatus !== 'string') return null;
  const STATUS_MAP: Record<string, AutomationLastExecution['status']> = {
    success: 'success',
    error: 'error',
    crashed: 'error',
    running: 'running',
    waiting: 'waiting',
  };
  const status = STATUS_MAP[rawStatus] ?? 'unknown';
  const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt : null;
  if (!startedAt) return null;
  const stoppedAt = typeof raw.stoppedAt === 'string' ? raw.stoppedAt : null;
  const errorMessage = (() => {
    const data = raw.data as Record<string, unknown> | undefined;
    const resultData = data?.resultData as Record<string, unknown> | undefined;
    const error = resultData?.error as Record<string, unknown> | undefined;
    return typeof error?.message === 'string' ? error.message : undefined;
  })();
  return {
    status,
    startedAt,
    stoppedAt,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function getWorkflowService(runtime: AgentRuntime): WorkflowService | null {
  const candidate = runtime.getService?.(WORKFLOW_SERVICE_TYPE);
  return (candidate as WorkflowService | null) ?? null;
}

function buildWorkflowStatus(service: WorkflowService | null): WorkflowStatusResponse {
  return {
    mode: service ? 'local' : 'disabled',
    host: 'in-process',
    status: service ? 'ready' : 'error',
    cloudConnected: false,
    localEnabled: Boolean(service),
    platform: 'desktop',
    cloudHealth: 'unknown',
    errorMessage: service ? null : 'Workflow service is not registered',
  };
}

async function loadWorkflowList(
  service: WorkflowService | null
): Promise<{
  workflows: WorkflowDefinitionResponse[];
  workflowFetchError: string | null;
}> {
  if (!service) {
    return { workflows: [], workflowFetchError: 'Workflow service is not registered' };
  }
  try {
    const workflows = await service.listWorkflows();
    return { workflows, workflowFetchError: null };
  } catch (error) {
    return {
      workflows: [],
      workflowFetchError: error instanceof Error ? error.message : 'Unable to load workflows',
    };
  }
}

async function fetchLastExecution(
  service: WorkflowService,
  workflowId: string
): Promise<AutomationLastExecution | null> {
  const cached = lastExecutionCache.get(workflowId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }
  const response = await service.listExecutions({ workflowId, limit: 1 });
  if (!response.data || response.data.length === 0) {
    lastExecutionCache.set(workflowId, {
      data: null,
      expiresAt: Date.now() + LAST_EXECUTION_TTL_MS,
    });
    return null;
  }
  const exec = normalizeLastExecution(response.data[0] as unknown as Record<string, unknown>);
  lastExecutionCache.set(workflowId, {
    data: exec,
    expiresAt: Date.now() + LAST_EXECUTION_TTL_MS,
  });
  return exec;
}

export async function buildAutomationListResponse(
  runtime: AgentRuntime
): Promise<AutomationListResponse> {
  const agentName = resolveAgentName(runtime);
  const rooms = await listAutomationRooms(runtime, agentName);
  const taskRooms = new Map(
    rooms
      .filter((room) => room.metadata.taskId)
      .map((room) => [room.metadata.taskId as string, room])
  );
  const triggerRooms = new Map(
    rooms
      .filter((room) => room.metadata.triggerId)
      .map((room) => [room.metadata.triggerId as string, room])
  );
  const workflowRooms = new Map(
    rooms
      .filter((room) => room.metadata.workflowId)
      .map((room) => [room.metadata.workflowId as string, room])
  );
  const workflowDraftItems = rooms
    .filter((room) => room.metadata.scope === 'automation-workflow-draft')
    .filter((room) => typeof room.metadata.draftId === 'string')
    .map((room) => buildWorkflowDraftItem(room));
  const automationDraftItems = rooms
    .filter((room) => room.metadata.scope === 'automation-draft')
    .filter((room) => typeof room.metadata.draftId === 'string')
    .map((room) => buildAutomationDraftItem(room));

  const allTasks = await runtime.getTasks({});
  const tasks = deduplicateSystemTasks(
    allTasks
      .map((task) => toWorkbenchTaskView(task))
      .filter((task): task is WorkbenchTaskView => task !== null)
  );

  const triggerTaskRecords = await listTriggerTasks(runtime);
  const triggerItems = triggerTaskRecords
    .map((task) => taskToTriggerSummary(task))
    .filter((trigger): trigger is TriggerSummary => trigger !== null);
  const triggerTaskIds = new Set(triggerItems.map((trigger) => trigger.taskId));
  const taskItems = tasks
    .filter((task) => !triggerTaskIds.has(task.id))
    .map((task) => buildCoordinatorTaskItem(task, taskRooms.get(task.id)));

  const service = getWorkflowService(runtime);
  const workflowStatus = buildWorkflowStatus(service);
  const { workflows: workflowList, workflowFetchError } = await loadWorkflowList(service);

  const workflowItemsById = new Map<string, AutomationItem>();
  for (const workflow of workflowList) {
    workflowItemsById.set(
      workflow.id,
      buildWorkflowItem(workflow, workflowRooms.get(workflow.id), {
        workflowId: workflow.id,
        workflowName: workflow.name,
      })
    );
  }

  for (const trigger of triggerItems) {
    if (trigger.kind === 'workflow' && trigger.workflowId) {
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
        })
      );
    }
  }

  // Only synthesize workflow items from rooms when workflow runtime is offline
  // (`workflowFetchError` set) — in that case the room is the most-recent
  // ground truth we have and should be surfaced. When workflow runtime is online and
  // returned a list, any workflowId in `workflowRooms` that isn't in the
  // current workflow list is an ORPHAN: the workflow was deleted but the chat
  // room/conversation wasn't cleaned up. Surfacing those creates ghost
  // rows the user can't dismiss. Skip them; the UI's deleteWorkflow path
  // also deletes the conversation now, so future deletions won't leak rooms.
  const workflowOffline = workflowFetchError !== null;
  if (workflowOffline) {
    for (const [workflowId, room] of workflowRooms.entries()) {
      if (!workflowItemsById.has(workflowId)) {
        workflowItemsById.set(
          workflowId,
          buildWorkflowItem(undefined, room, {
            workflowId,
            workflowName: room.metadata.workflowName,
          })
        );
      }
    }
  }

  // Fetch last execution for each live workflow in parallel.
  // Promise.allSettled ensures one failure does not block the full list.
  if (!workflowOffline && service && workflowItemsById.size > 0) {
    const now = Date.now();
    for (const [k, v] of lastExecutionCache) {
      if (v.expiresAt < now) lastExecutionCache.delete(k);
    }
    const workflowIds = [...workflowItemsById.keys()];
    await Promise.allSettled(
      workflowIds.map(async (workflowId) => {
        const exec = await fetchLastExecution(service, workflowId);
        if (!exec) return;
        const item = workflowItemsById.get(workflowId);
        if (item) item.lastExecution = exec;
      })
    );
  }

  const coordinatorTriggerItems = triggerItems
    .filter((trigger) => trigger.kind !== 'workflow')
    .map((trigger) => buildCoordinatorTriggerItem(trigger, triggerRooms.get(trigger.id)));

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
      (automation) => automation.type === 'coordinator_text'
    ).length,
    workflowCount: automations.filter((automation) => automation.type === 'workflow').length,
    scheduledCount: automations.filter((automation) => automation.schedules.length > 0).length,
    draftCount: automations.filter((automation) => automation.isDraft).length,
  };

  return {
    automations,
    summary,
    workflowStatus,
    workflowFetchError,
  };
}

/**
 * Test-only: clear the last-execution cache between cases.
 */
export function __resetAutomationsCacheForTests(): void {
  lastExecutionCache.clear();
}
