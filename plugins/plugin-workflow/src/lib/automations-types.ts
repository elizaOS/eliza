/** Types and projections for the `/api/automations` response. */

import type { ConversationMetadata, ConversationScope, WorkbenchTask } from '@elizaos/contracts';
import type { Task } from '@elizaos/core';

export function isAutomationConversationMetadata(
  metadata: ConversationMetadata | null | undefined
): boolean {
  return (
    metadata?.scope === 'automation-coordinator' ||
    metadata?.scope === 'automation-workflow' ||
    metadata?.scope === 'automation-workflow-draft' ||
    metadata?.scope === 'automation-draft'
  );
}

// ---------------------------------------------------------------------------
// Trigger (mirrors @elizaos/agent triggers/types.ts)
// ---------------------------------------------------------------------------

export type TriggerType = 'interval' | 'once' | 'cron' | 'event';
export type TriggerWakeMode = 'inject_now' | 'next_autonomy_cycle';
export type TriggerLastStatus = 'success' | 'error' | 'skipped';
export type TriggerKind = 'workflow' | 'prompt';

export interface TriggerSummary {
  id: string;
  taskId: string;
  displayName: string;
  instructions: string;
  triggerType: TriggerType;
  enabled: boolean;
  wakeMode: TriggerWakeMode;
  createdBy: string;
  timezone?: string;
  intervalMs?: number;
  scheduledAtIso?: string;
  cronExpression?: string;
  eventKind?: string;
  eventFilter?: Record<string, unknown>;
  maxRuns?: number;
  runCount: number;
  nextRunAtMs?: number;
  lastRunAtIso?: string;
  lastStatus?: TriggerLastStatus;
  lastError?: string;
  updatedAt?: number;
  updateInterval?: number;
  kind?: TriggerKind;
  workflowId?: string;
  workflowName?: string;
}

interface TriggerConfigShape {
  version?: number;
  triggerId?: string;
  displayName?: string;
  instructions?: string;
  triggerType?: TriggerType;
  enabled?: boolean;
  wakeMode?: TriggerWakeMode;
  createdBy?: string;
  timezone?: string;
  intervalMs?: number;
  scheduledAtIso?: string;
  cronExpression?: string;
  eventKind?: string;
  eventFilter?: Record<string, unknown>;
  maxRuns?: number;
  runCount?: number;
  nextRunAtMs?: number;
  lastRunAtIso?: string;
  lastStatus?: TriggerLastStatus;
  lastError?: string;
  kind?: TriggerKind;
  workflowId?: string;
  workflowName?: string;
}

interface TriggerTaskMetadataShape {
  updatedAt?: number;
  updateInterval?: number;
  trigger?: TriggerConfigShape;
  triggerRuns?: unknown[];
  [key: string]: unknown;
}

const HEARTBEAT_TASK_TAGS = ['queue', 'repeat', 'heartbeat'] as const;

function taskMetadata(task: Task): TriggerTaskMetadataShape {
  return (task.metadata ?? {}) as TriggerTaskMetadataShape;
}

/**
 * Mirrors `readTriggerConfig` in @elizaos/agent triggers/runtime.ts.
 */
export function readTriggerConfig(task: Task): TriggerConfigShape | null {
  const trigger = taskMetadata(task).trigger;
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return null;
  return trigger.triggerId ? trigger : null;
}

function isExplicitHeartbeatTask(task: Task): boolean {
  const tags = task.tags ?? [];
  return HEARTBEAT_TASK_TAGS.every((tag) => tags.includes(tag));
}

function deriveSystemHeartbeatName(task: Task): string {
  if (task.name && task.name.length > 0) {
    return task.name
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  const tag = (task.tags ?? []).find((t) => t !== 'queue' && t !== 'repeat' && t !== 'trigger');
  if (tag) {
    return `${tag.charAt(0).toUpperCase()}${tag.slice(1)} Heartbeat`;
  }
  return 'System Heartbeat';
}

function synthesizeSystemHeartbeatSummary(task: Task): TriggerSummary | null {
  if (!task.id) return null;
  const metadata = taskMetadata(task);
  const intervalMs =
    typeof metadata.updateInterval === 'number' ? metadata.updateInterval : undefined;
  const tags = task.tags ?? [];
  const createdBy =
    tags.find((t) => t !== 'queue' && t !== 'repeat' && t !== 'trigger') ?? 'system';
  return {
    id: task.id,
    taskId: task.id,
    displayName: deriveSystemHeartbeatName(task),
    instructions: task.description ?? '',
    triggerType: 'interval',
    enabled: true,
    wakeMode: 'next_autonomy_cycle',
    createdBy,
    intervalMs,
    runCount: 0,
    updatedAt: typeof metadata.updatedAt === 'number' ? metadata.updatedAt : undefined,
    updateInterval: intervalMs,
  };
}

/**
 * Mirrors `taskToTriggerSummary` in @elizaos/agent triggers/runtime.ts.
 */
export function taskToTriggerSummary(task: Task): TriggerSummary | null {
  const trigger = readTriggerConfig(task);
  if (
    trigger &&
    task.id &&
    trigger.triggerId &&
    trigger.displayName !== undefined &&
    trigger.instructions !== undefined &&
    trigger.triggerType &&
    trigger.enabled !== undefined &&
    trigger.wakeMode &&
    trigger.createdBy
  ) {
    const metadata = taskMetadata(task);
    return {
      id: trigger.triggerId,
      taskId: task.id,
      displayName: trigger.displayName,
      instructions: trigger.instructions,
      triggerType: trigger.triggerType,
      enabled: trigger.enabled,
      wakeMode: trigger.wakeMode,
      createdBy: trigger.createdBy,
      ...(trigger.timezone !== undefined ? { timezone: trigger.timezone } : {}),
      ...(trigger.intervalMs !== undefined ? { intervalMs: trigger.intervalMs } : {}),
      ...(trigger.scheduledAtIso !== undefined ? { scheduledAtIso: trigger.scheduledAtIso } : {}),
      ...(trigger.cronExpression !== undefined ? { cronExpression: trigger.cronExpression } : {}),
      ...(trigger.eventKind !== undefined ? { eventKind: trigger.eventKind } : {}),
      ...(trigger.eventFilter !== undefined ? { eventFilter: trigger.eventFilter } : {}),
      ...(trigger.maxRuns !== undefined ? { maxRuns: trigger.maxRuns } : {}),
      runCount: typeof trigger.runCount === 'number' ? trigger.runCount : 0,
      ...(trigger.nextRunAtMs !== undefined ? { nextRunAtMs: trigger.nextRunAtMs } : {}),
      ...(trigger.lastRunAtIso !== undefined ? { lastRunAtIso: trigger.lastRunAtIso } : {}),
      ...(trigger.lastStatus !== undefined ? { lastStatus: trigger.lastStatus } : {}),
      ...(trigger.lastError !== undefined ? { lastError: trigger.lastError } : {}),
      ...(metadata.updatedAt !== undefined ? { updatedAt: metadata.updatedAt } : {}),
      ...(metadata.updateInterval !== undefined ? { updateInterval: metadata.updateInterval } : {}),
      ...(trigger.kind !== undefined ? { kind: trigger.kind } : {}),
      ...(trigger.workflowId !== undefined ? { workflowId: trigger.workflowId } : {}),
      ...(trigger.workflowName !== undefined ? { workflowName: trigger.workflowName } : {}),
    };
  }

  if (isExplicitHeartbeatTask(task)) {
    return synthesizeSystemHeartbeatSummary(task);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Automation response (mirrors @elizaos/ui client-types-config.ts)
// ---------------------------------------------------------------------------

export type AutomationType = 'coordinator_text' | 'workflow' | 'automation_draft';

export type AutomationSource =
  | 'workbench_task'
  | 'trigger'
  | 'workflow'
  | 'workflow_draft'
  | 'workflow_shadow'
  | 'automation_draft';

export type AutomationStatus = 'active' | 'paused' | 'completed' | 'draft' | 'system';

export interface AutomationRoomBinding {
  conversationId: string | null;
  roomId: string;
  scope: ConversationScope;
  sourceConversationId?: string;
  terminalBridgeConversationId?: string;
}

export interface AutomationLastExecution {
  status: 'success' | 'error' | 'cancelled' | 'running' | 'waiting' | 'unknown';
  startedAt: string;
  stoppedAt?: string | null;
  errorMessage?: string;
}

export interface AutomationItem {
  id: string;
  type: AutomationType;
  source: AutomationSource;
  title: string;
  description: string;
  status: AutomationStatus;
  enabled: boolean;
  system: boolean;
  isDraft: boolean;
  hasBackingWorkflow: boolean;
  updatedAt: string | null;
  taskId?: string;
  triggerId?: string;
  workflowId?: string;
  draftId?: string;
  task?: WorkbenchTask;
  trigger?: TriggerSummary;
  workflow?: unknown;
  schedules: TriggerSummary[];
  room?: AutomationRoomBinding | null;
  lastExecution?: AutomationLastExecution;
  executionFetchError?: string;
}

export interface AutomationExecutionFetchError {
  workflowId: string;
  error: string;
}

export interface AutomationSummary {
  total: number;
  coordinatorCount: number;
  workflowCount: number;
  scheduledCount: number;
  draftCount: number;
}

export interface AutomationListResponse {
  automations: AutomationItem[];
  summary: AutomationSummary;
  workflowStatus: unknown;
  workflowFetchError: string | null;
  executionFetchErrors: AutomationExecutionFetchError[];
}
