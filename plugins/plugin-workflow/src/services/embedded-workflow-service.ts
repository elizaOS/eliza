/**
 * Tenant-scoped persistence and execution service for native Smithers workflow
 * modules. elizaOS owns definitions, revisions, run summaries, API events, and
 * scheduling; Smithers owns workflow evaluation inside the isolated runner.
 */
import { randomUUID } from 'node:crypto';
import {
  computeNextCronRunAtMs,
  type IAgentRuntime,
  logger,
  ModelType,
  Service,
  stringToUuid,
  type Task,
  TRIGGER_SCHEMA_VERSION,
  type TriggerConfig,
} from '@elizaos/core';
import { and, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  embeddedExecutions,
  embeddedTags,
  embeddedWorkflows,
  LEGACY_UNSCOPED_WORKFLOW_AGENT_ID,
  workflowRevisions,
} from '../db/schema';
import type {
  WorkflowApproval,
  WorkflowDefinition,
  WorkflowDefinitionResponse,
  WorkflowExecution,
  WorkflowExecutionMode,
  WorkflowRevision,
  WorkflowRevisionOperation,
  WorkflowRunEvent,
  WorkflowTag,
} from '../types/index';
import { WORKFLOW_RUN_EVENT, WorkflowApiError } from '../types/index';
import {
  controlSmithersRun,
  runSmithersWorkflow,
  validateSmithersSource,
} from './smithers-runtime';
import { cloneJson } from './workflow-json';

export const EMBEDDED_WORKFLOW_SERVICE_TYPE = 'embedded_workflow_service';
export const WORKFLOW_TASK_KIND = 'workflow';
const WORKFLOW_TRIGGER_TASK_NAME = 'TRIGGER_DISPATCH';
const WORKFLOW_TRIGGER_TAGS = ['queue', 'repeat', 'trigger'] as const;

interface StoredWorkflow {
  workflow: WorkflowDefinition;
  createdAt: string;
  updatedAt: string;
  versionId: string;
}

export interface ExecuteWorkflowOptions {
  mode?: WorkflowExecutionMode;
  input?: Record<string, unknown>;
  triggerData?: Record<string, unknown>;
  idempotencyKey?: string;
  throwOnError?: boolean;
  /** Trigger hops inherited by events emitted from this execution. */
  triggerChainDepth?: number;
}

type RunListener = (event: WorkflowRunEvent) => void;

function nowIso(): string {
  return new Date().toISOString();
}

function approvalPrompt(payload: Record<string, unknown>): string | undefined {
  const request = payload.request;
  if (!request || typeof request !== 'object') return undefined;
  const record = request as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
  return summary || title || undefined;
}

function normalizeWorkflow(
  workflow: WorkflowDefinition,
  id: string | undefined,
  fallbackActive: boolean
): WorkflowDefinition {
  const snapshot = cloneJson(workflow);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new WorkflowApiError('Workflow definition must be an object', 400);
  }
  if (typeof snapshot.source !== 'string') {
    throw new WorkflowApiError('Workflow source is required', 400);
  }
  validateSmithersSource(snapshot.source);
  if (typeof snapshot.name !== 'string' || !snapshot.name.trim()) {
    throw new WorkflowApiError('Workflow name is required', 400);
  }
  if (snapshot.language !== 'tsx' && snapshot.language !== 'typescript') {
    throw new WorkflowApiError('Workflow language must be tsx or typescript', 400);
  }
  if (snapshot.active !== undefined && typeof snapshot.active !== 'boolean') {
    throw new WorkflowApiError('Workflow active must be a boolean', 400);
  }
  if (snapshot.id !== undefined && typeof snapshot.id !== 'string') {
    throw new WorkflowApiError('Workflow id must be a string', 400);
  }
  if (snapshot.steps !== undefined && !Array.isArray(snapshot.steps)) {
    throw new WorkflowApiError('Workflow steps must be an array', 400);
  }
  const stepIds = new Set<string>();
  for (const step of snapshot.steps ?? []) {
    if (!step || typeof step !== 'object' || typeof step.id !== 'string' || !step.id.trim()) {
      throw new WorkflowApiError('Workflow step id is required', 400);
    }
    if (stepIds.has(step.id))
      throw new WorkflowApiError(`Duplicate workflow step id: ${step.id}`, 400);
    stepIds.add(step.id);
  }
  for (const step of snapshot.steps ?? []) {
    if (step.dependsOn !== undefined && !Array.isArray(step.dependsOn)) {
      throw new WorkflowApiError(`Workflow dependencies must be an array: ${step.id}`, 400);
    }
    for (const dependency of step.dependsOn ?? []) {
      if (typeof dependency !== 'string') {
        throw new WorkflowApiError(`Workflow dependency must be a string: ${step.id}`, 400);
      }
      if (!stepIds.has(dependency)) {
        throw new WorkflowApiError(`Unknown dependency ${dependency} on step ${step.id}`, 400);
      }
    }
  }
  return {
    ...snapshot,
    id: id ?? (snapshot.id?.trim() || randomUUID()),
    active: snapshot.active ?? fallbackActive,
  };
}

function responseFromStored(stored: StoredWorkflow): WorkflowDefinitionResponse {
  return {
    ...cloneJson(stored.workflow),
    id: stored.workflow.id ?? '',
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    versionId: stored.versionId,
  };
}

export class EmbeddedWorkflowService extends Service {
  static override readonly serviceType = EMBEDDED_WORKFLOW_SERVICE_TYPE;
  override capabilityDescription = 'Native Smithers workflow persistence and execution on elizaOS.';

  private readonly listeners = new Map<string, Set<RunListener>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = new Map<string, Promise<WorkflowExecution>>();

  static async start(runtime: IAgentRuntime): Promise<EmbeddedWorkflowService> {
    const service = new EmbeddedWorkflowService(runtime);
    await service.resumeInterruptedExecutions();
    logger.info({ src: 'plugin:workflow:embedded' }, 'Native Smithers workflow service ready');
    return service;
  }

  override async stop(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.running.values());
    this.controllers.clear();
    this.running.clear();
    this.listeners.clear();
  }

  get host(): string {
    return 'eliza://workflow';
  }

  private getDb(): NodePgDatabase {
    if (!this.runtime.db) {
      throw new WorkflowApiError('Workflow persistence requires the elizaOS database', 503);
    }
    return this.runtime.db as NodePgDatabase;
  }

  private get tenantId(): string {
    const value = this.runtime.agentId;
    if (!value || value === LEGACY_UNSCOPED_WORKFLOW_AGENT_ID) {
      throw new WorkflowApiError('Workflow tenant is unavailable', 503);
    }
    return value;
  }

  private async getStoredWorkflow(id: string): Promise<StoredWorkflow> {
    const rows = await this.getDb()
      .select()
      .from(embeddedWorkflows)
      .where(and(eq(embeddedWorkflows.agentId, this.tenantId), eq(embeddedWorkflows.id, id)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new WorkflowApiError(`Workflow not found: ${id}`, 404);
    return {
      workflow: cloneJson(row.workflow),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      versionId: row.versionId,
    };
  }

  private async workflowVersionForExecution(
    execution: WorkflowExecution
  ): Promise<WorkflowDefinitionResponse> {
    const currentRows = await this.getDb()
      .select()
      .from(embeddedWorkflows)
      .where(
        and(
          eq(embeddedWorkflows.agentId, this.tenantId),
          eq(embeddedWorkflows.id, execution.workflowId),
          eq(embeddedWorkflows.versionId, execution.workflowVersionId)
        )
      )
      .limit(1);
    const current = currentRows[0];
    if (current) {
      return responseFromStored({
        workflow: current.workflow,
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
        versionId: current.versionId,
      });
    }
    const revisionRows = await this.getDb()
      .select()
      .from(workflowRevisions)
      .where(
        and(
          eq(workflowRevisions.agentId, this.tenantId),
          eq(workflowRevisions.workflowId, execution.workflowId),
          eq(workflowRevisions.versionId, execution.workflowVersionId)
        )
      )
      .limit(1);
    const revision = revisionRows[0];
    if (!revision) {
      throw new WorkflowApiError(
        `Workflow version not found: ${execution.workflowId}/${execution.workflowVersionId}`,
        404
      );
    }
    return responseFromStored({
      workflow: revision.workflow,
      createdAt: revision.createdAt,
      updatedAt: revision.updatedAt,
      versionId: revision.versionId,
    });
  }

  private async resumeExecution(execution: WorkflowExecution): Promise<void> {
    if (execution.finished || this.running.has(execution.id)) return;
    const workflow = await this.workflowVersionForExecution(execution);
    const controller = new AbortController();
    this.controllers.set(execution.id, controller);
    const executionPromise = this.runInBackground(workflow, execution, controller).finally(() => {
      this.controllers.delete(execution.id);
      this.running.delete(execution.id);
    });
    this.running.set(execution.id, executionPromise);
  }

  private async resumeInterruptedExecutions(): Promise<void> {
    const interrupted = (await this.listExecutions()).data.filter(
      (execution) => !execution.finished
    );
    for (const execution of interrupted) {
      try {
        await this.resumeExecution(execution);
      } catch (error) {
        // error-policy:J4 an unrecoverable persisted run becomes an explicit
        // failed execution instead of remaining in a healthy-looking wait state.
        const failed: WorkflowExecution = {
          ...execution,
          status: 'failed',
          finished: true,
          stoppedAt: nowIso(),
          error: { message: error instanceof Error ? error.message : String(error) },
        };
        await this.saveExecution(failed);
        logger.error(
          {
            src: 'plugin:workflow:embedded',
            runId: execution.id,
            workflowId: execution.workflowId,
            error: failed.error?.message,
          },
          'Unable to resume persisted Smithers workflow run'
        );
      }
    }
  }

  private async captureRevision(
    id: string,
    stored: StoredWorkflow,
    operation: WorkflowRevisionOperation
  ): Promise<void> {
    await this.getDb()
      .insert(workflowRevisions)
      .values(this.revisionValues(id, stored, operation));
  }

  private revisionValues(id: string, stored: StoredWorkflow, operation: WorkflowRevisionOperation) {
    return {
      agentId: this.tenantId,
      id: randomUUID(),
      workflowId: id,
      versionId: stored.versionId,
      name: stored.workflow.name,
      active: stored.workflow.active === true,
      workflow: cloneJson(stored.workflow),
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      capturedAt: nowIso(),
      operation,
    };
  }

  async createWorkflow(workflow: WorkflowDefinition): Promise<WorkflowDefinitionResponse> {
    const timestamp = nowIso();
    const versionId = randomUUID();
    const normalized = normalizeWorkflow(workflow, undefined, false);
    const id = normalized.id ?? randomUUID();
    await this.getDb()
      .insert(embeddedWorkflows)
      .values({
        agentId: this.tenantId,
        id,
        name: normalized.name,
        active: normalized.active === true,
        workflow: normalized,
        createdAt: timestamp,
        updatedAt: timestamp,
        versionId,
      });
    const response = responseFromStored({
      workflow: normalized,
      createdAt: timestamp,
      updatedAt: timestamp,
      versionId,
    });
    await this.syncSchedule(response);
    return response;
  }

  async updateWorkflow(
    id: string,
    workflow: WorkflowDefinition,
    revisionOperation: WorkflowRevisionOperation = 'update'
  ): Promise<WorkflowDefinitionResponse> {
    const current = await this.getStoredWorkflow(id);
    const updatedAt = nowIso();
    const versionId = randomUUID();
    const normalized = normalizeWorkflow(workflow, id, current.workflow.active === true);
    await this.getDb().transaction(async (transaction) => {
      await transaction
        .insert(workflowRevisions)
        .values(this.revisionValues(id, current, revisionOperation));
      const updatedRows = await transaction
        .update(embeddedWorkflows)
        .set({
          name: normalized.name,
          active: normalized.active === true,
          workflow: normalized,
          updatedAt,
          versionId,
        })
        .where(and(eq(embeddedWorkflows.agentId, this.tenantId), eq(embeddedWorkflows.id, id)))
        .returning({ id: embeddedWorkflows.id });
      if (updatedRows.length !== 1) {
        throw new WorkflowApiError(`Workflow not found: ${id}`, 404);
      }
    });
    const response = responseFromStored({
      workflow: normalized,
      createdAt: current.createdAt,
      updatedAt,
      versionId,
    });
    await this.syncSchedule(response);
    return response;
  }

  async listWorkflows(params?: {
    active?: boolean;
    limit?: number;
  }): Promise<{ data: WorkflowDefinitionResponse[] }> {
    const rows = await this.getDb()
      .select()
      .from(embeddedWorkflows)
      .where(eq(embeddedWorkflows.agentId, this.tenantId))
      .orderBy(desc(embeddedWorkflows.updatedAt));
    const workflows = rows
      .filter((row) => params?.active === undefined || row.active === params.active)
      .map((row) =>
        responseFromStored({
          workflow: row.workflow,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          versionId: row.versionId,
        })
      );
    return { data: params?.limit ? workflows.slice(0, params.limit) : workflows };
  }

  async getWorkflow(id: string): Promise<WorkflowDefinitionResponse> {
    return responseFromStored(await this.getStoredWorkflow(id));
  }

  async deleteWorkflow(id: string): Promise<void> {
    const current = await this.getStoredWorkflow(id);
    await this.captureRevision(id, current, 'delete');
    await this.getDb()
      .delete(embeddedWorkflows)
      .where(and(eq(embeddedWorkflows.agentId, this.tenantId), eq(embeddedWorkflows.id, id)));
    await this.removeWorkflowTriggers(id);
  }

  async activateWorkflow(id: string): Promise<WorkflowDefinitionResponse> {
    return this.setActive(id, true);
  }

  async deactivateWorkflow(id: string): Promise<WorkflowDefinitionResponse> {
    return this.setActive(id, false);
  }

  private async setActive(id: string, active: boolean): Promise<WorkflowDefinitionResponse> {
    const current = await this.getStoredWorkflow(id);
    await this.captureRevision(id, current, active ? 'activate' : 'deactivate');
    const workflow = { ...current.workflow, active };
    const updatedAt = nowIso();
    const versionId = randomUUID();
    await this.getDb()
      .update(embeddedWorkflows)
      .set({ active, workflow, updatedAt, versionId })
      .where(and(eq(embeddedWorkflows.agentId, this.tenantId), eq(embeddedWorkflows.id, id)));
    const response = responseFromStored({
      workflow,
      createdAt: current.createdAt,
      updatedAt,
      versionId,
    });
    await this.syncSchedule(response);
    return response;
  }

  private async workflowTriggerTasks(workflowId: string): Promise<Task[]> {
    const tasks = await this.runtime.getTasks({
      agentIds: [this.runtime.agentId],
      tags: [...WORKFLOW_TRIGGER_TAGS],
    });
    return tasks.filter((task) => {
      const trigger = task.metadata?.trigger as TriggerConfig | undefined;
      return trigger?.kind === 'workflow' && trigger.workflowId === workflowId;
    });
  }

  private async removeWorkflowTriggers(workflowId: string): Promise<void> {
    for (const task of await this.workflowTriggerTasks(workflowId)) {
      if (task.id) await this.runtime.deleteTask(task.id);
    }
  }

  private async removeSchedule(workflowId: string): Promise<void> {
    const scheduleDedupeKey = `workflow-schedule:${workflowId}`;
    for (const task of await this.workflowTriggerTasks(workflowId)) {
      const trigger = task.metadata?.trigger as TriggerConfig | undefined;
      if (trigger?.dedupeKey !== scheduleDedupeKey) continue;
      if (task.id) await this.runtime.deleteTask(task.id);
    }
  }

  private async syncSchedule(workflow: WorkflowDefinitionResponse): Promise<void> {
    await this.removeSchedule(workflow.id);
    const schedule = workflow.schedule;
    if (!workflow.active || !schedule?.enabled) return;
    const now = Date.now();
    const nextRunAtMs = computeNextCronRunAtMs(schedule.cron, now, schedule.timezone);
    if (nextRunAtMs === null) {
      throw new WorkflowApiError(`Invalid workflow cron schedule: ${schedule.cron}`, 400);
    }
    const triggerId = stringToUuid(`workflow-schedule:${this.tenantId}:${workflow.id}`);
    const trigger: TriggerConfig = {
      version: TRIGGER_SCHEMA_VERSION,
      triggerId,
      displayName: `${workflow.name} schedule`,
      instructions: `Run workflow ${workflow.name}`,
      triggerType: 'cron',
      enabled: true,
      wakeMode: 'inject_now',
      createdBy: this.tenantId,
      timezone: schedule.timezone,
      cronExpression: schedule.cron,
      runCount: 0,
      nextRunAtMs,
      dedupeKey: `workflow-schedule:${workflow.id}`,
      kind: 'workflow',
      workflowId: workflow.id,
      workflowName: workflow.name,
    };
    await this.runtime.createTask({
      name: WORKFLOW_TRIGGER_TASK_NAME,
      description: trigger.displayName,
      tags: [...WORKFLOW_TRIGGER_TAGS],
      metadata: {
        blocking: true,
        updatedAt: now,
        updateInterval: Math.max(1, nextRunAtMs - now),
        trigger,
      },
    });
  }

  async startWorkflow(
    id: string,
    options: ExecuteWorkflowOptions = {}
  ): Promise<WorkflowExecution> {
    if (options.idempotencyKey) {
      const prior = await this.findExecutionByIdempotencyKey(id, options.idempotencyKey);
      if (prior) return prior;
    }
    const workflow = await this.getWorkflow(id);
    const runId = randomUUID();
    const pending: WorkflowExecution = {
      id: runId,
      workflowId: id,
      workflowVersionId: workflow.versionId,
      workflowName: workflow.name,
      mode: options.mode ?? 'manual',
      status: 'queued',
      finished: false,
      startedAt: nowIso(),
      input: cloneJson(options.input ?? options.triggerData ?? {}),
      events: [],
      approvals: [],
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      ...(options.triggerChainDepth !== undefined
        ? { triggerChainDepth: options.triggerChainDepth }
        : {}),
    };
    await this.saveExecution(pending);
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    const executionPromise = this.runInBackground(workflow, pending, controller).finally(() => {
      this.controllers.delete(runId);
      this.running.delete(runId);
    });
    this.running.set(runId, executionPromise);
    return pending;
  }

  async executeWorkflow(
    id: string,
    options: ExecuteWorkflowOptions = {}
  ): Promise<WorkflowExecution> {
    const pending = await this.startWorkflow(id, options);
    const running = this.running.get(pending.id);
    if (!running) return pending;
    const completed = await running;
    if (completed.status === 'failed' && options.throwOnError !== false) {
      throw new WorkflowApiError(
        completed.error?.message ?? 'Workflow execution failed',
        500,
        completed
      );
    }
    return completed;
  }

  private async runInBackground(
    workflow: WorkflowDefinitionResponse,
    pending: WorkflowExecution,
    controller: AbortController
  ): Promise<WorkflowExecution> {
    const running = { ...pending, status: 'running' as const };
    await this.saveExecution(running);
    try {
      const result = await runSmithersWorkflow({
        tenantId: this.tenantId,
        workflow,
        runId: pending.id,
        mode: pending.mode,
        input: pending.input,
        signal: controller.signal,
        onEvent: (event) => this.recordEvent(running, event),
        generate: async ({ prompt, messages, signal }) => {
          const promptText =
            typeof prompt === 'string' ? prompt : JSON.stringify(prompt ?? messages ?? '');
          return this.runtime.useModel(ModelType.TEXT_LARGE, {
            prompt: promptText,
            signal,
          });
        },
      });
      const completed: WorkflowExecution = {
        ...running,
        status: result.status,
        finished: ['cancelled', 'continued', 'failed', 'finished'].includes(result.status),
        stoppedAt: ['cancelled', 'continued', 'failed', 'finished'].includes(result.status)
          ? nowIso()
          : null,
        events: result.events,
        ...(result.output !== undefined ? { output: result.output } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.nextRunId ? { nextRunId: result.nextRunId } : {}),
      };
      await this.saveExecution(completed);
      return completed;
    } catch (error) {
      // error-policy:J1 child-process failures become explicit failed run state.
      const failed: WorkflowExecution = {
        ...running,
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        finished: true,
        stoppedAt: nowIso(),
        error: {
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        },
      };
      await this.saveExecution(failed);
      return failed;
    }
  }

  private async recordEvent(execution: WorkflowExecution, event: WorkflowRunEvent): Promise<void> {
    execution.events = [...(execution.events ?? []), event];
    if (event.type === 'ApprovalRequested' && event.nodeId && typeof event.iteration === 'number') {
      const prompt = approvalPrompt(event.payload);
      const pending: WorkflowApproval = {
        runId: execution.id,
        workflowId: execution.workflowId,
        nodeId: event.nodeId,
        iteration: event.iteration,
        status: 'pending',
        requestedAt: event.timestamp,
        ...(prompt ? { prompt } : {}),
      };
      execution.approvals = [
        ...(execution.approvals ?? []).filter(
          (approval) => approval.nodeId !== event.nodeId || approval.iteration !== event.iteration
        ),
        pending,
      ];
    }
    await this.saveExecution(execution);
    for (const listener of this.listeners.get(execution.id) ?? []) listener(event);
    await this.runtime.emitEvent(WORKFLOW_RUN_EVENT, {
      runtime: this.runtime,
      event,
      ...(execution.triggerChainDepth !== undefined
        ? { triggerChainDepth: execution.triggerChainDepth }
        : {}),
    } as never);
  }

  subscribe(runId: string, listener: RunListener): () => void {
    const listeners = this.listeners.get(runId) ?? new Set<RunListener>();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(runId);
    };
  }

  async cancelExecution(runId: string): Promise<WorkflowExecution> {
    this.controllers.get(runId)?.abort();
    return this.getExecution(runId);
  }

  async decideApproval(
    runId: string,
    nodeId: string,
    iteration: number,
    approved: boolean,
    options: { note?: string; decidedBy?: string; decision?: unknown } = {}
  ): Promise<WorkflowExecution> {
    const execution = await this.getExecution(runId);
    const pending = (execution.approvals ?? []).find(
      (approval) => approval.nodeId === nodeId && approval.iteration === iteration
    );
    await controlSmithersRun(this.tenantId, execution.workflowId, {
      kind: approved ? 'approve' : 'deny',
      runId,
      nodeId,
      iteration,
      ...options,
    });
    const decidedAt = nowIso();
    execution.approvals = [
      ...(execution.approvals ?? []).filter(
        (approval) => approval.nodeId !== nodeId || approval.iteration !== iteration
      ),
      {
        runId,
        workflowId: execution.workflowId,
        nodeId,
        iteration,
        status: approved ? 'approved' : 'denied',
        requestedAt: pending?.requestedAt ?? decidedAt,
        ...(pending?.prompt ? { prompt: pending.prompt } : {}),
        decidedAt,
        ...(options.decidedBy ? { decidedBy: options.decidedBy } : {}),
        ...(options.decision !== undefined ? { decision: options.decision } : {}),
      },
    ];
    await this.saveExecution(execution);
    await this.resumeExecution(execution);
    return execution;
  }

  async signalExecution(
    runId: string,
    signal: string,
    payload: unknown,
    receivedBy?: string
  ): Promise<WorkflowExecution> {
    if (!signal.trim()) throw new WorkflowApiError('Signal name is required', 400);
    const execution = await this.getExecution(runId);
    await controlSmithersRun(this.tenantId, execution.workflowId, {
      kind: 'signal',
      runId,
      signal,
      payload,
      ...(receivedBy ? { receivedBy } : {}),
    });
    await this.resumeExecution(execution);
    return execution;
  }

  private async saveExecution(execution: WorkflowExecution): Promise<void> {
    const existing = await this.getDb()
      .select({ id: embeddedExecutions.id })
      .from(embeddedExecutions)
      .where(
        and(eq(embeddedExecutions.agentId, this.tenantId), eq(embeddedExecutions.id, execution.id))
      )
      .limit(1);
    const values = {
      status: execution.status,
      mode: execution.mode,
      finished: execution.finished,
      startedAt: execution.startedAt,
      stoppedAt: execution.stoppedAt ?? null,
      execution: cloneJson(execution),
      idempotencyKey: execution.idempotencyKey ?? null,
    };
    if (existing.length > 0) {
      await this.getDb()
        .update(embeddedExecutions)
        .set(values)
        .where(
          and(
            eq(embeddedExecutions.agentId, this.tenantId),
            eq(embeddedExecutions.id, execution.id)
          )
        );
      return;
    }
    await this.getDb()
      .insert(embeddedExecutions)
      .values({
        agentId: this.tenantId,
        id: execution.id,
        workflowId: execution.workflowId,
        ...values,
      });
  }

  async listExecutions(
    params: { workflowId?: string; limit?: number } = {}
  ): Promise<{ data: WorkflowExecution[] }> {
    const rows = await this.getDb()
      .select()
      .from(embeddedExecutions)
      .where(eq(embeddedExecutions.agentId, this.tenantId))
      .orderBy(desc(embeddedExecutions.startedAt));
    const data = rows
      .filter((row) => !params.workflowId || row.workflowId === params.workflowId)
      .map((row) => cloneJson(row.execution));
    return { data: params.limit ? data.slice(0, params.limit) : data };
  }

  async getExecution(id: string): Promise<WorkflowExecution> {
    const rows = await this.getDb()
      .select()
      .from(embeddedExecutions)
      .where(and(eq(embeddedExecutions.agentId, this.tenantId), eq(embeddedExecutions.id, id)))
      .limit(1);
    if (!rows[0]) throw new WorkflowApiError(`Workflow execution not found: ${id}`, 404);
    return cloneJson(rows[0].execution);
  }

  async findExecutionByIdempotencyKey(
    workflowId: string,
    key: string
  ): Promise<WorkflowExecution | null> {
    const rows = await this.getDb()
      .select()
      .from(embeddedExecutions)
      .where(
        and(
          eq(embeddedExecutions.agentId, this.tenantId),
          eq(embeddedExecutions.workflowId, workflowId),
          eq(embeddedExecutions.idempotencyKey, key)
        )
      )
      .orderBy(desc(embeddedExecutions.startedAt))
      .limit(1);
    return rows[0] ? cloneJson(rows[0].execution) : null;
  }

  async listWorkflowRevisions(
    workflowId: string,
    limit = 20
  ): Promise<{ data: WorkflowRevision[] }> {
    const rows = await this.getDb()
      .select()
      .from(workflowRevisions)
      .where(
        and(
          eq(workflowRevisions.agentId, this.tenantId),
          eq(workflowRevisions.workflowId, workflowId)
        )
      )
      .orderBy(desc(workflowRevisions.capturedAt))
      .limit(limit);
    return {
      data: rows.map((row) => ({
        id: row.id,
        workflowId: row.workflowId,
        versionId: row.versionId,
        name: row.name,
        active: row.active,
        workflow: cloneJson(row.workflow),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        capturedAt: row.capturedAt,
        operation: row.operation as WorkflowRevisionOperation,
      })),
    };
  }

  async restoreWorkflowRevision(
    workflowId: string,
    versionId: string
  ): Promise<WorkflowDefinitionResponse> {
    const rows = await this.getDb()
      .select()
      .from(workflowRevisions)
      .where(
        and(
          eq(workflowRevisions.agentId, this.tenantId),
          eq(workflowRevisions.workflowId, workflowId),
          eq(workflowRevisions.versionId, versionId)
        )
      )
      .limit(1);
    if (!rows[0])
      throw new WorkflowApiError(`Workflow revision not found: ${workflowId}/${versionId}`, 404);
    return this.updateWorkflow(workflowId, rows[0].workflow, 'restore');
  }

  async listTags(): Promise<{ data: WorkflowTag[] }> {
    const rows = await this.getDb()
      .select()
      .from(embeddedTags)
      .where(eq(embeddedTags.agentId, this.tenantId))
      .orderBy(embeddedTags.name);
    return { data: rows.map((row) => cloneJson(row)) };
  }

  async createTag(name: string): Promise<WorkflowTag> {
    const tag = { id: randomUUID(), name: name.trim(), createdAt: nowIso(), updatedAt: nowIso() };
    if (!tag.name) throw new WorkflowApiError('Tag name is required', 400);
    await this.getDb()
      .insert(embeddedTags)
      .values({ agentId: this.tenantId, ...tag });
    return tag;
  }

  async updateWorkflowTags(id: string, tagIds: string[]): Promise<WorkflowTag[]> {
    const workflow = await this.getWorkflow(id);
    const all = await this.listTags();
    const tags = tagIds.map((tagId) => {
      const tag = all.data.find((candidate) => candidate.id === tagId);
      if (!tag) throw new WorkflowApiError(`Tag not found: ${tagId}`, 404);
      return tag;
    });
    await this.updateWorkflow(id, { ...workflow, tags });
    return tags;
  }
}
