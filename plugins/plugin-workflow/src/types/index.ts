/**
 * Canonical Smithers workflow, run, event, approval, revision, and widget
 * contracts shared by the workflow runtime, elizaOS Cloud routes, chat, and UI.
 * A workflow is executable Smithers source plus presentation metadata; no
 * foreign workflow schema is accepted or persisted.
 */
import type { EventPayload } from '@elizaos/core';

export type WorkflowSourceLanguage = 'tsx' | 'typescript';

export interface WorkflowStepManifest {
  id: string;
  label: string;
  kind:
    | 'approval'
    | 'branch'
    | 'loop'
    | 'parallel'
    | 'sequence'
    | 'signal'
    | 'task'
    | 'timer'
    | 'ui'
    | 'workflow';
  dependsOn?: string[];
  description?: string;
  agent?: string;
}

export interface WorkflowWidgetManifest {
  id: string;
  title: string;
  description?: string;
  surface: 'chat' | 'workflow' | 'both';
  component:
    | 'approval'
    | 'chart'
    | 'data-table'
    | 'form'
    | 'issue-list'
    | 'json'
    | 'markdown'
    | 'status';
  dataPath?: string;
  actions?: Array<{
    id: string;
    label: string;
    signal?: string;
    style?: 'default' | 'primary' | 'danger';
  }>;
}

export interface WorkflowSchedule {
  cron: string;
  timezone: string;
  enabled: boolean;
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  source: string;
  language: WorkflowSourceLanguage;
  active?: boolean;
  inputSchema?: Record<string, unknown>;
  steps?: WorkflowStepManifest[];
  widgets?: WorkflowWidgetManifest[];
  schedule?: WorkflowSchedule;
  tags?: WorkflowTag[];
  metadata?: Record<string, string | number | boolean>;
  id?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkflowDefinitionResponse extends WorkflowDefinition {
  id: string;
  createdAt: string;
  updatedAt: string;
  versionId: string;
}

export type WorkflowRevisionOperation =
  | 'update'
  | 'activate'
  | 'deactivate'
  | 'tags'
  | 'restore'
  | 'delete';

export interface WorkflowRevision {
  id: string;
  workflowId: string;
  versionId: string;
  name: string;
  active: boolean;
  workflow: WorkflowDefinition;
  createdAt: string;
  updatedAt: string;
  capturedAt: string;
  operation: WorkflowRevisionOperation;
}

export interface WorkflowTag {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export type WorkflowExecutionMode =
  | 'chat'
  | 'evaluation'
  | 'manual'
  | 'retry'
  | 'schedule'
  | 'trigger';
export type WorkflowExecutionStatus =
  | 'cancelled'
  | 'continued'
  | 'failed'
  | 'finished'
  | 'paused'
  | 'queued'
  | 'running'
  | 'waiting-approval'
  | 'waiting-event'
  | 'waiting-quota'
  | 'waiting-timer';

export interface WorkflowRunEvent {
  id: string;
  sequence: number;
  runId: string;
  workflowId: string;
  timestamp: string;
  type: string;
  nodeId?: string;
  iteration?: number;
  payload: Record<string, unknown>;
}

export interface WorkflowApproval {
  runId: string;
  workflowId: string;
  nodeId: string;
  iteration: number;
  status: 'pending' | 'approved' | 'denied';
  prompt?: string;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decision?: unknown;
}

export interface WorkflowExecution {
  id: string;
  workflowId: string;
  workflowVersionId: string;
  workflowName: string;
  mode: WorkflowExecutionMode;
  status: WorkflowExecutionStatus;
  finished: boolean;
  startedAt: string;
  stoppedAt?: string | null;
  input: Record<string, unknown>;
  output?: unknown;
  error?: { message: string; stack?: string };
  parentRunId?: string | null;
  nextRunId?: string;
  events?: WorkflowRunEvent[];
  approvals?: WorkflowApproval[];
  idempotencyKey?: string;
  /** Internal ancestry carried across native workflow-trigger executions. */
  triggerChainDepth?: number;
}

export interface WorkflowCreationResult {
  id: string;
  name: string;
  active: boolean;
  stepCount: number;
}

export interface WorkflowDraft {
  workflow: WorkflowDefinition;
  prompt: string;
  userId: string;
  createdAt: number;
  originMessageId?: string;
}

export interface WorkflowValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface TriggerContext {
  source?: string;
  discord?: { channelId?: string; guildId?: string; threadId?: string };
  telegram?: { chatId?: string | number; threadId?: string | number };
  slack?: { channelId?: string; teamId?: string };
  resolvedNames?: { channel?: string; server?: string };
}

export const WORKFLOW_RUN_EVENT = 'workflow_run_event';
export interface WorkflowRunEventPayload extends EventPayload {
  event: WorkflowRunEvent;
}

export class WorkflowApiError extends Error {
  constructor(
    message: string,
    public statusCode = 500,
    public response?: unknown
  ) {
    super(message);
    this.name = 'WorkflowApiError';
  }
}
