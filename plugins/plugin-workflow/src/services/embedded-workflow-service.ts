/**
 * Tenant-scoped persistence and execution service for native Smithers workflow
 * modules. elizaOS owns definitions, revisions, run summaries, API events, and
 * scheduling; Smithers owns workflow evaluation inside the isolated runner.
 */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
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
import { and, asc, desc, eq, gt, inArray, notInArray, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  embeddedExecutions,
  embeddedTags,
  embeddedWorkflows,
  hostedCursors,
  hostedResults,
  hostedSources,
  LEGACY_UNSCOPED_WORKFLOW_AGENT_ID,
  lifecycleMutations,
  manualSubmissions,
  metadataMutations,
  typedMutations,
  workflowRevisions,
} from '../db/schema';
import type {
  WorkflowApproval,
  WorkflowCancellationResult,
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
  type DigestSource,
  type DigestSpec,
  digestAdmission,
  digestCron,
  digestHash,
  digestId,
  digestKeys,
  digestPhoneSpec,
  digestRecord,
  digestSource,
  digestSourceState,
  digestText,
  HOSTED_SPEC,
  HOSTED_TEMPLATE_VERSION,
  validateDigestSpec,
  writeDigestResult,
} from './hosted-digest';
import {
  assertHostedGoogleSource,
  listHostedGoogleCalendars,
  listHostedGoogleSources,
  readHostedGoogleSource,
  validateHostedGoogleSelection,
} from './hosted-google-source';
import {
  assertHostedNativeSource,
  readHostedNativeSource,
  validateHostedNativeSelection,
} from './hosted-native-source';
import {
  PHONE_COMPILER_KEY,
  PHONE_COMPILER_REVISION,
  PHONE_SPEC_KEY,
  type PhoneWorkflowSpec,
  phoneDraftDefinition,
  phoneSpecDigest,
  validatePhoneSpec,
  verifyPhoneWorkflowSource,
} from './phone-workflow-spec';
import {
  controlSmithersRun,
  runSmithersWorkflow,
  validateSmithersSource,
} from './smithers-runtime';
import { readApprovalReceipts } from './workflow-approval-receipts';
import { cloneJson } from './workflow-json';
import { workerTerminationFromError } from './workflow-worker-termination';

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

const REMOVED = 'elizaPhoneRemovedAt',
  CLEANUP = 'elizaPhoneTriggerCleanup';
export function isWorkflowRemoved(workflow: WorkflowDefinition): boolean {
  return typeof workflow.metadata?.[REMOVED] === 'string';
}
function requireMutable(workflow: WorkflowDefinition) {
  if (isWorkflowRemoved(workflow))
    throw new WorkflowApiError(
      'Workflow removed; restore it explicitly before editing or running',
      409
    );
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
  if (
    snapshot.metadata !== undefined &&
    (!snapshot.metadata ||
      typeof snapshot.metadata !== 'object' ||
      Array.isArray(snapshot.metadata))
  )
    throw new WorkflowApiError('Workflow metadata must be an object', 400);
  if (snapshot.metadata?.[PHONE_SPEC_KEY] !== undefined)
    throw new WorkflowApiError('Typed specifications require the reviewed authoring route', 400);
  if (snapshot.metadata && (REMOVED in snapshot.metadata || CLEANUP in snapshot.metadata))
    throw new WorkflowApiError('Reserved workflow lifecycle fields', 400);
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

  private readonly workerReconciliations = new Map<string, ReturnType<typeof setTimeout>>();
  private reconciliationStopped = false;
  private readonly resumeAdmissions = new Map<string, Promise<void>>();
  private scheduleWorkerReconciliation(execution: WorkflowExecution): void {
    if (this.reconciliationStopped || this.workerReconciliations.has(execution.id)) return;
    const timer = setTimeout(() => {
      this.workerReconciliations.delete(execution.id);
      if (this.reconciliationStopped) return;
      void this.resumeExecution(execution).catch((error) => {
        logger.warn(
          { src: 'plugin:workflow:embedded', runId: execution.id, error },
          'Worker reconciliation unavailable; unfinished state preserved'
        );
      });
    }, 1000);
    timer.unref?.();
    this.workerReconciliations.set(execution.id, timer);
  }

  private readonly cancellationControls = new Map<string, Promise<void>>();
  private readonly scheduleLocks = new Map<string, Promise<void>>();
  private readonly listeners = new Map<string, Set<RunListener>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = new Map<string, Promise<WorkflowExecution>>();

  static async start(runtime: IAgentRuntime): Promise<EmbeddedWorkflowService> {
    const service = new EmbeddedWorkflowService(runtime);
    await service.recoverRemovedSchedules();
    await service.recoverHostedSchedules();
    await service.resumeInterruptedExecutions();
    logger.info({ src: 'plugin:workflow:embedded' }, 'Native Smithers workflow service ready');
    return service;
  }

  override async stop(): Promise<void> {
    this.reconciliationStopped = true;
    for (const timer of this.workerReconciliations.values()) clearTimeout(timer);
    this.workerReconciliations.clear();
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.resumeAdmissions.values());
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

  private resumeExecution(execution: WorkflowExecution): Promise<void> {
    const id = execution.id;
    if (this.reconciliationStopped) return Promise.resolve();
    const pending = this.resumeAdmissions.get(id);
    if (pending) return pending;
    // Reserve synchronously before any database read or worker publication.
    const admission = Promise.resolve()
      .then(async () => {
        if (this.reconciliationStopped || this.running.has(id)) return;
        execution = await this.getExecution(id);
        if (this.reconciliationStopped || execution.finished || this.running.has(id)) return;
        if (execution.cancellationRequestedAt) {
          await this.cancelExecution(id);
          return;
        }
        const workflow = await this.workflowVersionForExecution(execution);
        if (this.reconciliationStopped || this.running.has(id)) return;
        const controller = new AbortController();
        this.controllers.set(id, controller);
        const executionPromise = this.runInBackground(workflow, execution, controller).finally(
          () => {
            if (this.controllers.get(id) === controller) this.controllers.delete(id);
            if (this.running.get(id) === executionPromise) this.running.delete(id);
          }
        );
        this.running.set(id, executionPromise);
      })
      .finally(() => {
        if (this.resumeAdmissions.get(id) === admission) this.resumeAdmissions.delete(id);
      });
    this.resumeAdmissions.set(id, admission);
    return admission;
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
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
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

  private async recoverHostedSchedules() {
    const rows = await this.getDb()
      .select()
      .from(embeddedWorkflows)
      .where(eq(embeddedWorkflows.agentId, this.tenantId));
    for (const row of rows)
      if (row.workflow.metadata?.[HOSTED_SPEC] && !isWorkflowRemoved(row.workflow))
        await this.syncSchedule(responseFromStored(row));
  }
  async listDigestLiveCalendars(ownerId: string, input: unknown) {
    return listHostedGoogleCalendars(this.runtime, ownerId, input);
  }
  async listDigestLiveAccounts(ownerId: string) {
    return listHostedGoogleSources(this.runtime, ownerId);
  }
  async saveDigestSource(ownerId: string, input: unknown) {
    const v = digestRecord(input);
    digestKeys(v, ['id', 'kind', 'label', 'text', 'observedAt', 'expiresAt', 'confirmed', 'live']);
    if (v.confirmed !== true || !['tasks', 'calendar', 'email', 'notes'].includes(String(v.kind)))
      throw new WorkflowApiError('Review and confirm the exact snapshot', 400);
    const live =
      v.live === undefined
        ? undefined
        : digestRecord(v.live).provider === 'native'
          ? validateHostedNativeSelection(v.live)
          : validateHostedGoogleSelection(v.live);
    if (live) {
      if (
        (live.provider === 'native' ? v.kind !== 'tasks' : live.kind !== v.kind) ||
        v.text !== undefined
      )
        throw new WorkflowApiError(
          'Live source must match selected kind and cannot include snapshot text',
          400
        );
    }
    const id = digestId(v.id),
      observedAt = digestText(v.observedAt, 40),
      expiresAt = digestText(v.expiresAt, 40),
      now = Date.now();
    const fields = {
      id,
      kind: v.kind as DigestSource['kind'],
      label: digestText(v.label, 200),
      text: live
        ? 'Fresh selected-account read is resolved only at the scheduled occurrence.'
        : digestText(v.text, 12000),
      ...(live ? { live } : {}),
      observedAt,
      expiresAt,
    };
    if (Buffer.byteLength(JSON.stringify(fields), 'utf8') > 15000)
      throw new WorkflowApiError('Encoded snapshot exceeds the reviewed byte bound', 400);
    const source = { ...fields, revision: digestHash(fields), revoked: false };
    const [prior] = await this.getDb()
      .select()
      .from(hostedSources)
      .where(
        and(
          eq(hostedSources.agentId, this.tenantId),
          eq(hostedSources.ownerId, ownerId),
          eq(hostedSources.id, id)
        )
      );
    if (prior) {
      if (prior.source.revision !== source.revision)
        throw new WorkflowApiError('Snapshot identity conflict', 409);
      return { ...prior.source, revoked: prior.revoked };
    }
    if (live) {
      try {
        if (live.provider === 'native')
          await assertHostedNativeSource(this.runtime, ownerId, live, Date.parse(expiresAt));
        else await assertHostedGoogleSource(this.runtime, ownerId, live, Date.parse(expiresAt));
      } catch {
        throw new WorkflowApiError('Selected source permission changed before saving', 409, {
          code: 'HOSTED_SOURCE_NOT_SAVED',
          mutationId: id,
        });
      }
    }
    const observed = Date.parse(observedAt),
      expires = Date.parse(expiresAt);
    if (
      !Number.isFinite(observed) ||
      !Number.isFinite(expires) ||
      observed > now + 60000 ||
      observed < now - 7 * 86400000 ||
      expires <= now ||
      expires > observed + 7 * 86400000
    )
      throw new WorkflowApiError(
        'Source must have a valid explicit freshness window of at most seven days',
        400,
        { code: 'HOSTED_SOURCE_NOT_SAVED', mutationId: id }
      );

    await this.getDb()
      .insert(hostedSources)
      .values({ agentId: this.tenantId, ownerId, id, source, revoked: false })
      .onConflictDoNothing();
    const saved = await digestSource(this.getDb(), this.tenantId, ownerId, id);
    if (saved.revision !== source.revision)
      throw new WorkflowApiError('Snapshot identity conflict', 409);
    return saved;
  }
  async listDigestSources(ownerId: string) {
    return (
      await this.getDb()
        .select()
        .from(hostedSources)
        .where(and(eq(hostedSources.agentId, this.tenantId), eq(hostedSources.ownerId, ownerId)))
    ).map((row) => {
      const { text: _private, ...metadata } = row.source;
      return { ...metadata, revoked: row.revoked };
    });
  }
  async revokeDigestSource(ownerId: string, id: string) {
    await digestSource(this.getDb(), this.tenantId, ownerId, id);
    await this.getDb()
      .update(hostedSources)
      .set({ revoked: true })
      .where(
        and(
          eq(hostedSources.agentId, this.tenantId),
          eq(hostedSources.ownerId, ownerId),
          eq(hostedSources.id, id)
        )
      );
    return { id, revoked: true };
  }
  async saveHostedDigest(
    ownerId: string,
    mutationId: string,
    value: unknown,
    id?: string,
    expectedVersionId?: string
  ) {
    const spec = validateDigestSpec(value),
      source = await digestSource(this.getDb(), this.tenantId, ownerId, spec.sourceId);
    if (source.revision !== spec.sourceRevision)
      throw new WorkflowApiError('Reviewed snapshot revision changed', 409);
    if (source.live?.provider === 'native' && spec.enabled) {
      if (source.revoked || Date.parse(source.expiresAt) <= Date.now())
        throw new WorkflowApiError('Native source grant expired or revoked', 409);
      const grant = await assertHostedNativeSource(this.runtime, ownerId, source.live);
      if (digestRecord(grant.scope).timeZone !== spec.timeZone)
        throw new WorkflowApiError('Review a native source grant for this schedule time zone', 409);
    }
    if (spec.manualOnly)
      throw new WorkflowApiError('Use explicit dossier execution for manual source reads', 400);
    const receipt = await this.typedMutation(
      ownerId,
      mutationId,
      digestPhoneSpec(spec, source),
      id,
      expectedVersionId,
      spec
    );
    await this.syncSchedule(await this.getWorkflow(receipt.workflowId));
    return receipt;
  }
  async runHostedDossier(
    ownerId: string,
    sourceId: string,
    sourceRevision: string,
    mutationId: string,
    wait = false
  ) {
    const source = await digestSource(this.getDb(), this.tenantId, ownerId, sourceId);
    if (source.revision !== sourceRevision || source.live?.provider !== 'native')
      throw new WorkflowApiError('Dossier source binding changed', 409);
    const definitionKey = digestHash([
      'native-dossier-definition',
      ownerId,
      sourceId,
      sourceRevision,
      HOSTED_TEMPLATE_VERSION,
      PHONE_COMPILER_REVISION,
    ]);
    const existing = await this.typedReceipt(ownerId, definitionKey);
    if (existing) {
      const prior = await this.getManualSubmission(existing.workflowId, mutationId, ownerId);
      if (prior) {
        const running = wait ? this.running.get(prior.id) : undefined;
        return running ?? prior;
      }
    }
    if (
      source.revoked ||
      source.revision !== sourceRevision ||
      Date.parse(source.expiresAt) <= Date.now() ||
      source.live?.provider !== 'native'
    )
      throw new WorkflowApiError('Review a current native source for this dossier', 409);
    const grant = await assertHostedNativeSource(this.runtime, ownerId, source.live);
    const spec: DigestSpec = {
      version: 1,
      template: 'morning',
      sourceId,
      sourceRevision,
      timeZone: String(digestRecord(grant.scope).timeZone),
      localTime: '08:00',
      enabled: false,
      manualOnly: true,
    };
    const receipt = await this.typedMutation(
      ownerId,
      definitionKey,
      digestPhoneSpec(spec, source),
      undefined,
      undefined,
      spec
    );
    const execution = await this.startReviewedWorkflow(
      receipt.workflowId,
      mutationId,
      receipt.versionId,
      {},
      ownerId,
      (workflow) => {
        if (
          workflow.metadata?.elizaOwnerEntityId !== ownerId ||
          !validateDigestSpec(JSON.parse(String(workflow.metadata?.[HOSTED_SPEC]))).manualOnly
        )
          throw new WorkflowApiError('Dossier owner changed', 409);
      },
      { sourceId, sourceRevision }
    );
    if (wait) {
      const running = this.running.get(execution.id);
      if (running) return running;
    }
    return execution;
  }
  async listHostedDigests(ownerId: string) {
    const rows = (
      await this.getDb()
        .select()
        .from(embeddedWorkflows)
        .where(eq(embeddedWorkflows.agentId, this.tenantId))
    ).filter(
      (row) =>
        row.workflow.metadata?.elizaOwnerEntityId === ownerId &&
        row.workflow.metadata?.[HOSTED_SPEC]
    );
    const definitions = rows
      .map((row) => ({
        row,
        spec: validateDigestSpec(JSON.parse(String(row.workflow.metadata?.[HOSTED_SPEC]))),
      }))
      .filter(({ spec }) => !spec.manualOnly);
    if (!definitions.length) return [];
    const sources = await this.getDb()
      .select()
      .from(hostedSources)
      .where(
        and(
          eq(hostedSources.agentId, this.tenantId),
          eq(hostedSources.ownerId, ownerId),
          inArray(hostedSources.id, [...new Set(definitions.map(({ spec }) => spec.sourceId))])
        )
      );
    const states = new Map(
      sources.map((source) => [
        source.id,
        digestSourceState({ ...source.source, revoked: source.revoked }),
      ])
    );
    return definitions.map(({ row, spec }) => ({
      id: row.id,
      versionId: row.versionId,
      name: row.name,
      spec,
      active: row.active,
      removed: isWorkflowRemoved(row.workflow),
      sourceState: states.get(spec.sourceId) ?? 'revoked',
    }));
  }
  async digestResults(ownerId: string, clientId: string) {
    const where = and(
      eq(hostedCursors.agentId, this.tenantId),
      eq(hostedCursors.ownerId, ownerId),
      eq(hostedCursors.clientId, clientId)
    );
    const [cursor] = await this.getDb().select().from(hostedCursors).where(where);
    const entries = await this.getDb()
      .select()
      .from(hostedResults)
      .where(
        and(
          eq(hostedResults.agentId, this.tenantId),
          eq(hostedResults.ownerId, ownerId),
          gt(hostedResults.sequence, cursor?.cursor ?? 0)
        )
      )
      .orderBy(asc(hostedResults.sequence))
      .limit(50);
    const page: Array<Record<string, unknown>> = [];
    let bytes = 100;
    for (const row of entries) {
      const entry = { cursor: row.sequence, ...row.result };
      const size = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
      if (page.length && bytes + size > 1000000) break;
      page.push(entry);
      bytes += size;
    }
    return { acknowledged: cursor?.cursor ?? 0, entries: page };
  }
  async acknowledgeDigest(ownerId: string, clientId: string, cursor: number, runId: string) {
    if (!Number.isSafeInteger(cursor) || cursor < 1)
      throw new WorkflowApiError('Invalid result cursor', 400);
    return this.getDb().transaction(async (tx) => {
      const [result] = await tx
        .select()
        .from(hostedResults)
        .where(
          and(
            eq(hostedResults.agentId, this.tenantId),
            eq(hostedResults.ownerId, ownerId),
            eq(hostedResults.sequence, cursor),
            eq(hostedResults.runId, runId)
          )
        );
      if (!result) throw new WorkflowApiError('Result not found', 404);
      await tx
        .insert(hostedCursors)
        .values({ agentId: this.tenantId, ownerId, clientId, cursor: 0 })
        .onConflictDoNothing();
      const where = and(
        eq(hostedCursors.agentId, this.tenantId),
        eq(hostedCursors.ownerId, ownerId),
        eq(hostedCursors.clientId, clientId)
      );
      const [previous] = await tx.select().from(hostedCursors).where(where).for('update');
      const acknowledged = Math.max(previous.cursor, cursor);
      await tx.update(hostedCursors).set({ cursor: acknowledged }).where(where);
      return { acknowledged };
    });
  }

  async typedMutation(
    ownerId: string,
    mutationId: string,
    spec: PhoneWorkflowSpec,
    id?: string,
    expectedVersionId?: string,
    hosted?: DigestSpec
  ) {
    const operation = id ? ('edit' as const) : ('create' as const);
    const requestDigest = createHash('sha256')
      .update(
        JSON.stringify({
          operation,
          id: id ?? null,
          expectedVersionId: expectedVersionId ?? null,
          spec,
          ...(hosted ? { hosted } : {}),
          compilerRevision: PHONE_COMPILER_REVISION,
        })
      )
      .digest('hex');
    return this.getDb().transaction(async (tx) => {
      const identity = and(
        eq(typedMutations.agentId, this.tenantId),
        eq(typedMutations.ownerId, ownerId),
        eq(typedMutations.mutationId, mutationId)
      );
      const [prior] = await tx.select().from(typedMutations).where(identity);
      if (prior) {
        if (prior.requestDigest !== requestDigest)
          throw new WorkflowApiError('Typed mutation identity conflict', 409);
        return prior.receipt;
      }
      let current: StoredWorkflow | undefined;
      if (id) {
        const [row] = await tx
          .select()
          .from(embeddedWorkflows)
          .where(and(eq(embeddedWorkflows.agentId, this.tenantId), eq(embeddedWorkflows.id, id)))
          .for('update');
        if (!row || row.workflow.metadata?.elizaOwnerEntityId !== ownerId)
          throw new WorkflowApiError('Workflow not found', 404);
        current = row;
        // A simultaneous identical edit may have committed while this caller waited.
        const [committed] = await tx.select().from(typedMutations).where(identity);
        if (committed) {
          if (committed.requestDigest !== requestDigest)
            throw new WorkflowApiError('Typed mutation identity conflict', 409);
          return committed.receipt;
        }
        requireMutable(responseFromStored(row));
        if (Boolean(row.workflow.metadata?.[HOSTED_SPEC]) !== Boolean(hosted))
          throw new WorkflowApiError('Use the matching reviewed editor', 409);
        if (!row.workflow.metadata?.[PHONE_SPEC_KEY])
          throw new WorkflowApiError('Legacy workflow has no typed specification', 409);
        if (row.versionId !== expectedVersionId)
          throw new WorkflowApiError('Typed workflow changed before editing', 409, {
            code: 'WORKFLOW_TYPED_NOT_APPLIED',
            workflowId: id,
            mutationId,
            expectedVersionId,
          });
      }
      if (hosted) {
        const source = await digestSource(tx, this.tenantId, ownerId, hosted.sourceId);
        if (
          source.revision !== hosted.sourceRevision ||
          (hosted.enabled && (source.revoked || Date.parse(source.expiresAt) <= Date.now()))
        )
          throw new WorkflowApiError('Reviewed snapshot unavailable', 409);
      }
      const workflowId = id ?? randomUUID(),
        versionId = randomUUID(),
        appliedAt = nowIso();
      const receipt = {
        mutationId,
        workflowId,
        operation,
        previousVersionId: expectedVersionId ?? null,
        versionId,
        specDigest: phoneSpecDigest(spec),
        compilerRevision: PHONE_COMPILER_REVISION,
        appliedAt,
      };
      const inserted = await tx
        .insert(typedMutations)
        .values({
          agentId: this.tenantId,
          ownerId,
          mutationId,
          requestDigest,
          workflowId,
          receipt,
        })
        .onConflictDoNothing()
        .returning();
      if (!inserted.length) {
        const [same] = await tx.select().from(typedMutations).where(identity);
        if (!same || same.requestDigest !== requestDigest)
          throw new WorkflowApiError('Typed mutation identity conflict', 409);
        return same.receipt;
      }
      const compiled = phoneDraftDefinition(spec),
        workflow = {
          ...compiled,
          id: workflowId,
          metadata: {
            ...compiled.metadata,
            elizaOwnerEntityId: ownerId,
            ...(hosted ? { [HOSTED_SPEC]: JSON.stringify(hosted) } : {}),
          },
          ...(hosted && !hosted.manualOnly
            ? {
                active: hosted.enabled,
                schedule: {
                  cron: digestCron(hosted),
                  timezone: hosted.timeZone,
                  enabled: hosted.enabled,
                },
              }
            : {}),
        };
      if (current) {
        await tx
          .insert(workflowRevisions)
          .values(this.revisionValues(workflowId, current, 'update'));
        await tx
          .update(embeddedWorkflows)
          .set({
            workflow,
            name: spec.name,
            active: hosted?.enabled ?? false,
            versionId,
            updatedAt: appliedAt,
          })
          .where(
            and(eq(embeddedWorkflows.agentId, this.tenantId), eq(embeddedWorkflows.id, workflowId))
          );
      } else
        await tx.insert(embeddedWorkflows).values({
          agentId: this.tenantId,
          id: workflowId,
          name: spec.name,
          active: hosted?.enabled ?? false,
          workflow,
          versionId,
          createdAt: appliedAt,
          updatedAt: appliedAt,
        });
      return receipt;
    });
  }
  async typedReceipt(ownerId: string, mutationId: string) {
    const [row] = await this.getDb()
      .select()
      .from(typedMutations)
      .where(
        and(
          eq(typedMutations.agentId, this.tenantId),
          eq(typedMutations.ownerId, ownerId),
          eq(typedMutations.mutationId, mutationId)
        )
      );
    return row?.receipt ?? null;
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

  async metadataReceipt(id: string, mutationId: string, ownerId: string) {
    const [row] = await this.getDb()
      .select()
      .from(metadataMutations)
      .where(
        and(
          eq(metadataMutations.agentId, this.tenantId),
          eq(metadataMutations.workflowId, id),
          eq(metadataMutations.mutationId, mutationId),
          eq(metadataMutations.ownerId, ownerId)
        )
      )
      .limit(1);
    return row?.receipt ?? null;
  }
  async changeMetadata(
    id: string,
    mutationId: string,
    expectedVersionId: string,
    name: string,
    description: string,
    ownerId: string,
    authorize: (workflow: WorkflowDefinitionResponse) => void
  ) {
    return this.getDb().transaction(async (tx) => {
      const where = and(eq(embeddedWorkflows.agentId, this.tenantId), eq(embeddedWorkflows.id, id));
      const [row] = await tx.select().from(embeddedWorkflows).where(where).for('update');
      if (!row) throw new WorkflowApiError('Workflow not found', 404);
      const current = responseFromStored(row);
      authorize(current);
      requireMutable(current);
      if (current.metadata?.[PHONE_SPEC_KEY])
        throw new WorkflowApiError('Use the typed full-spec editor', 409);
      const [prior] = await tx
        .select()
        .from(metadataMutations)
        .where(
          and(
            eq(metadataMutations.agentId, this.tenantId),
            eq(metadataMutations.workflowId, id),
            eq(metadataMutations.mutationId, mutationId)
          )
        )
        .limit(1);
      if (prior) {
        if (prior.ownerId !== ownerId) throw new WorkflowApiError('Mutation not found', 404);
        if (
          prior.expectedVersionId !== expectedVersionId ||
          prior.name !== name ||
          prior.description !== description
        )
          throw new WorkflowApiError('Mutation identity already bound', 409);
        return prior.receipt;
      }
      if (current.versionId !== expectedVersionId)
        throw new WorkflowApiError('Workflow changed; review again', 409, {
          code: 'WORKFLOW_METADATA_NOT_APPLIED',
          workflowId: id,
          mutationId,
          expectedVersionId,
        });
      const versionId = randomUUID(),
        appliedAt = nowIso(),
        workflow = { ...cloneJson(row.workflow), name, description };
      await tx.insert(workflowRevisions).values(this.revisionValues(id, row, 'update'));
      await tx
        .update(embeddedWorkflows)
        .set({ name, workflow, versionId, updatedAt: appliedAt })
        .where(where);
      const receipt = {
        mutationId,
        workflowId: id,
        previousVersionId: expectedVersionId,
        versionId,
        name,
        description,
        active: row.active,
        appliedAt,
      };
      await tx.insert(metadataMutations).values({
        agentId: this.tenantId,
        workflowId: id,
        mutationId,
        ownerId,
        expectedVersionId,
        name,
        description,
        receipt,
      });
      return receipt;
    });
  }

  async lifecycleReceipt(id: string, mutationId: string, ownerId: string) {
    const [row] = await this.getDb()
      .select()
      .from(lifecycleMutations)
      .where(
        and(
          eq(lifecycleMutations.agentId, this.tenantId),
          eq(lifecycleMutations.workflowId, id),
          eq(lifecycleMutations.mutationId, mutationId),
          eq(lifecycleMutations.ownerId, ownerId)
        )
      )
      .limit(1);
    return row?.receipt ?? null;
  }
  async changeLifecycle(
    id: string,
    mutationId: string,
    expectedVersionId: string,
    operation: 'remove' | 'restore',
    ownerId: string,
    authorize: (workflow: WorkflowDefinitionResponse) => void
  ) {
    const outcome = await this.getDb().transaction(async (tx) => {
      const where = and(eq(embeddedWorkflows.agentId, this.tenantId), eq(embeddedWorkflows.id, id));
      const [row] = await tx.select().from(embeddedWorkflows).where(where).for('update');
      if (!row) throw new WorkflowApiError('Workflow not found', 404);
      const current = responseFromStored(row);
      authorize(current);
      const [prior] = await tx
        .select()
        .from(lifecycleMutations)
        .where(
          and(
            eq(lifecycleMutations.agentId, this.tenantId),
            eq(lifecycleMutations.workflowId, id),
            eq(lifecycleMutations.mutationId, mutationId)
          )
        )
        .limit(1);
      if (prior) {
        if (prior.ownerId !== ownerId) throw new WorkflowApiError('Mutation not found', 404);
        if (prior.operation !== operation || prior.expectedVersionId !== expectedVersionId)
          throw new WorkflowApiError('Lifecycle mutation identity conflict', 409);
        return { receipt: prior.receipt, applied: false };
      }
      if (current.versionId !== expectedVersionId)
        throw new WorkflowApiError('Workflow changed; review again', 409, {
          code: 'WORKFLOW_LIFECYCLE_NOT_APPLIED',
          workflowId: id,
          mutationId,
          expectedVersionId,
        });
      if ((operation === 'remove') === isWorkflowRemoved(current))
        throw new WorkflowApiError('Workflow lifecycle already changed; refresh', 409);
      const unfinished = await tx
        .select({ id: embeddedExecutions.id })
        .from(embeddedExecutions)
        .where(
          and(
            eq(embeddedExecutions.agentId, this.tenantId),
            eq(embeddedExecutions.workflowId, id),
            or(
              eq(embeddedExecutions.finished, false),
              notInArray(embeddedExecutions.status, [
                'cancelled',
                'continued',
                'failed',
                'finished',
              ])
            )
          )
        )
        .limit(1);
      if (unfinished.length)
        throw new WorkflowApiError(
          'Workflow has ongoing executions; cancel each execution explicitly first',
          409,
          {
            code: 'WORKFLOW_LIFECYCLE_NOT_APPLIED',
            workflowId: id,
            mutationId,
            expectedVersionId,
          }
        );
      if (operation === 'restore' && current.metadata?.[CLEANUP] !== 'complete')
        throw new WorkflowApiError('Trigger cleanup is not yet confirmed', 409, {
          code: 'WORKFLOW_LIFECYCLE_NOT_APPLIED',
          workflowId: id,
          mutationId,
          expectedVersionId,
        });
      const appliedAt = nowIso(),
        versionId = randomUUID(),
        metadata = { ...row.workflow.metadata };
      if (operation === 'remove') {
        metadata[REMOVED] = appliedAt;
        metadata[CLEANUP] = 'pending';
      } else {
        delete metadata[REMOVED];
        delete metadata[CLEANUP];
      }
      const workflow = { ...cloneJson(row.workflow), active: false, metadata };
      await tx
        .insert(workflowRevisions)
        .values(this.revisionValues(id, row, operation === 'remove' ? 'delete' : 'restore'));
      await tx
        .update(embeddedWorkflows)
        .set({ workflow, active: false, versionId, updatedAt: appliedAt })
        .where(where);
      const receipt = {
        mutationId,
        workflowId: id,
        previousVersionId: expectedVersionId,
        versionId,
        operation,
        appliedAt,
      };
      await tx.insert(lifecycleMutations).values({
        agentId: this.tenantId,
        workflowId: id,
        mutationId,
        ownerId,
        expectedVersionId,
        operation,
        receipt,
      });
      return { receipt, applied: true };
    });
    if (!outcome.applied) return outcome.receipt;
    // Failed trigger cleanup leaves the durable removal in place; startup repairs it.
    try {
      await this.syncSchedule(await this.getWorkflow(id));
    } catch {
      logger.warn(
        { src: 'plugin:workflow:lifecycle', workflowId: id },
        'Lifecycle trigger cleanup pending'
      );
    }
    return outcome.receipt;
  }
  async lifecycleState(id: string) {
    const row = await this.getStoredWorkflow(id);
    return {
      removed: isWorkflowRemoved(row.workflow),
      cleanup: row.workflow.metadata?.[CLEANUP] === 'pending' ? 'pending' : 'complete',
      versionId: row.versionId,
    };
  }
  private async recoverRemovedSchedules() {
    const rows = await this.getDb()
      .select()
      .from(embeddedWorkflows)
      .where(eq(embeddedWorkflows.agentId, this.tenantId));
    for (const row of rows) {
      if (isWorkflowRemoved(row.workflow)) {
        try {
          await this.syncSchedule(responseFromStored(row));
        } catch {
          logger.warn(
            { src: 'plugin:workflow:lifecycle', workflowId: row.id },
            'Removed workflow trigger cleanup remains pending'
          );
        }
      }
    }
  }

  async updateWorkflow(
    id: string,
    workflow: WorkflowDefinition,
    revisionOperation: WorkflowRevisionOperation = 'update'
  ): Promise<WorkflowDefinitionResponse> {
    const response = await this.getDb().transaction(async (tx) => {
      const where = and(eq(embeddedWorkflows.agentId, this.tenantId), eq(embeddedWorkflows.id, id));
      const [current] = await tx.select().from(embeddedWorkflows).where(where).for('update');
      if (!current) throw new WorkflowApiError('Workflow not found', 404);
      if (current.workflow.metadata?.[PHONE_SPEC_KEY])
        throw new WorkflowApiError('Use the typed full-spec editor', 409);
      requireMutable(current.workflow);
      const updatedAt = nowIso(),
        versionId = randomUUID(),
        normalized = normalizeWorkflow(workflow, id, current.workflow.active === true);
      await tx
        .insert(workflowRevisions)
        .values(this.revisionValues(id, current, revisionOperation));
      await tx
        .update(embeddedWorkflows)
        .set({
          name: normalized.name,
          active: normalized.active === true,
          workflow: normalized,
          updatedAt,
          versionId,
        })
        .where(where);
      return responseFromStored({
        workflow: normalized,
        createdAt: current.createdAt,
        updatedAt,
        versionId,
      });
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
    return {
      data: params?.limit === undefined ? workflows : workflows.slice(0, Math.max(0, params.limit)),
    };
  }

  async getWorkflow(id: string): Promise<WorkflowDefinitionResponse> {
    return responseFromStored(await this.getStoredWorkflow(id));
  }

  async deleteWorkflow(_id: string): Promise<void> {
    throw new WorkflowApiError('Use reviewed receipt-preserving removal', 409);
  }

  async activateWorkflow(id: string): Promise<WorkflowDefinitionResponse> {
    return this.setActive(id, true);
  }

  async deactivateWorkflow(id: string): Promise<WorkflowDefinitionResponse> {
    return this.setActive(id, false);
  }

  private async setActive(id: string, active: boolean): Promise<WorkflowDefinitionResponse> {
    const response = await this.getDb().transaction(async (tx) => {
      const where = and(eq(embeddedWorkflows.agentId, this.tenantId), eq(embeddedWorkflows.id, id));
      const [current] = await tx.select().from(embeddedWorkflows).where(where).for('update');
      if (!current) throw new WorkflowApiError('Workflow not found', 404);
      if (active && current.workflow.metadata?.[PHONE_SPEC_KEY])
        throw new WorkflowApiError(
          'Manual typed workflows require explicit runs; timed admission is unavailable',
          409
        );
      requireMutable(current.workflow);
      await tx
        .insert(workflowRevisions)
        .values(this.revisionValues(id, current, active ? 'activate' : 'deactivate'));
      const workflow = { ...current.workflow, active },
        updatedAt = nowIso(),
        versionId = randomUUID();
      await tx
        .update(embeddedWorkflows)
        .set({ active, workflow, updatedAt, versionId })
        .where(where);
      return responseFromStored({
        workflow,
        updatedAt,
        versionId,
        createdAt: current.createdAt,
      });
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

  private async syncSchedule(requested: WorkflowDefinitionResponse): Promise<void> {
    const prior = this.scheduleLocks.get(requested.id) ?? Promise.resolve();
    const work = prior
      .catch(() => {})
      .then(async () => {
        const workflow = await this.getWorkflow(requested.id);
        if (isWorkflowRemoved(workflow)) {
          await this.removeWorkflowTriggers(workflow.id);
          await this.getDb().transaction(async (tx) => {
            const where = and(
              eq(embeddedWorkflows.agentId, this.tenantId),
              eq(embeddedWorkflows.id, workflow.id)
            );
            const [row] = await tx.select().from(embeddedWorkflows).where(where).for('update');
            if (row && isWorkflowRemoved(row.workflow))
              await tx
                .update(embeddedWorkflows)
                .set({
                  workflow: {
                    ...row.workflow,
                    metadata: {
                      ...row.workflow.metadata,
                      [CLEANUP]: 'complete',
                    },
                  },
                })
                .where(where);
          });
          return;
        }
        await this.syncActiveSchedule(workflow);
      });
    this.scheduleLocks.set(requested.id, work);
    try {
      await work;
    } finally {
      if (this.scheduleLocks.get(requested.id) === work) this.scheduleLocks.delete(requested.id);
    }
  }
  /** True when a scheduled digest's reviewed source is revoked or expired. */
  private async hostedSourceLapsed(workflow: WorkflowDefinitionResponse): Promise<boolean> {
    if (!workflow.metadata?.[HOSTED_SPEC]) return false;
    const spec = validateDigestSpec(JSON.parse(String(workflow.metadata[HOSTED_SPEC])));
    if (spec.manualOnly) return false;
    const [row] = await this.getDb()
      .select()
      .from(hostedSources)
      .where(
        and(
          eq(hostedSources.agentId, this.tenantId),
          eq(hostedSources.ownerId, String(workflow.metadata.elizaOwnerEntityId || '')),
          eq(hostedSources.id, spec.sourceId)
        )
      );
    return !row || digestSourceState({ ...row.source, revoked: row.revoked }) !== 'current';
  }
  private async syncActiveSchedule(workflow: WorkflowDefinitionResponse): Promise<void> {
    if (workflow.metadata?.[HOSTED_SPEC] && workflow.active && workflow.schedule?.enabled) {
      // Renewal saves a new reviewed version and re-arms this schedule.
      if (await this.hostedSourceLapsed(workflow)) {
        await this.removeSchedule(workflow.id);
        return;
      }
      const tasks = await this.runtime.getTasks({
        agentIds: [this.runtime.agentId],
        tags: [...WORKFLOW_TRIGGER_TAGS],
      });
      if (
        tasks.some(
          (task) =>
            task.metadata?.hostedVersionId === workflow.versionId &&
            (task.metadata?.trigger as { workflowId?: string } | undefined)?.workflowId ===
              workflow.id
        )
      )
        return;
    }
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
    const createdTaskId = await this.runtime.createTask({
      name: WORKFLOW_TRIGGER_TASK_NAME,
      description: trigger.displayName,
      tags: [...WORKFLOW_TRIGGER_TAGS],
      metadata: {
        blocking: true,
        updatedAt: now,
        updateInterval: Math.max(1, nextRunAtMs - now),
        ...(workflow.metadata?.[HOSTED_SPEC]
          ? {
              hostedVersionId: workflow.versionId,
              idempotencyKey: `${workflow.id}:${Math.floor(nextRunAtMs / 60000)}`,
            }
          : {}),
        trigger,
      },
    });
    // Another host may remove/pause/update while its task store call is in flight.
    // Delete only this stale task; admission independently checks the durable row.
    const current = await this.getWorkflow(workflow.id);
    if (isWorkflowRemoved(current) || !current.active || current.versionId !== workflow.versionId) {
      await this.runtime.deleteTask(createdTaskId);
    }
  }

  async getManualSubmission(
    id: string,
    submissionId: string,
    ownerId: string
  ): Promise<WorkflowExecution | null> {
    const [row] = await this.getDb()
      .select()
      .from(manualSubmissions)
      .where(
        and(
          eq(manualSubmissions.agentId, this.tenantId),
          eq(manualSubmissions.workflowId, id),
          eq(manualSubmissions.submissionId, submissionId),
          eq(manualSubmissions.ownerId, ownerId)
        )
      )
      .limit(1);
    return row ? this.getExecution(row.runId) : null;
  }

  /** Admission is committed before worker startup; recovery already resumes persisted executions. */
  async startReviewedWorkflow(
    id: string,
    submissionId: string,
    versionId: string,
    input: Record<string, unknown>,
    ownerId: string,
    authorize: (workflow: WorkflowDefinitionResponse) => void,
    dossier?: { sourceId: string; sourceRevision: string }
  ): Promise<WorkflowExecution> {
    let snapshot = cloneJson(input);
    if (dossier && Object.keys(snapshot).length)
      throw new WorkflowApiError('Dossier occurrence is server-owned', 400);
    const accepted = await this.getDb().transaction(async (tx) => {
      if (dossier)
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['native-dossier-request', this.tenantId, ownerId, submissionId])},0))`
        );
      const [row] = await tx
        .select()
        .from(embeddedWorkflows)
        .where(and(eq(embeddedWorkflows.agentId, this.tenantId), eq(embeddedWorkflows.id, id)))
        .for('update');
      if (!row) throw new WorkflowApiError('Workflow not found', 404);
      const workflow = responseFromStored(row);
      authorize(workflow);
      if (workflow.metadata?.[HOSTED_SPEC]) {
        const spec = validateDigestSpec(JSON.parse(String(workflow.metadata[HOSTED_SPEC])));
        if (
          !dossier ||
          !spec.manualOnly ||
          spec.sourceId !== dossier.sourceId ||
          spec.sourceRevision !== dossier.sourceRevision
        )
          throw new WorkflowApiError('Hosted digests require their reviewed admission path', 409);
      } else if (dossier) throw new WorkflowApiError('Dossier definition unavailable', 409);
      requireMutable(workflow);
      const [prior] = await tx
        .select()
        .from(manualSubmissions)
        .where(
          and(
            eq(manualSubmissions.agentId, this.tenantId),
            ...(dossier
              ? [eq(manualSubmissions.ownerId, ownerId)]
              : [eq(manualSubmissions.workflowId, id)]),
            eq(manualSubmissions.submissionId, submissionId)
          )
        )
        .limit(1);
      if (prior) {
        if (prior.ownerId !== ownerId) throw new WorkflowApiError('Submission not found', 404);
        if (
          prior.workflowId !== id ||
          prior.versionId !== versionId ||
          (!dossier && !isDeepStrictEqual(prior.input, snapshot))
        )
          throw new WorkflowApiError('Submission key already bound to another request', 409);
        return { runId: prior.runId, fresh: false, workflow };
      }
      if (workflow.versionId !== versionId)
        throw new WorkflowApiError('Workflow changed; review again', 409, {
          code: 'WORKFLOW_VERSION_NOT_ADMITTED',
          workflowId: id,
          submissionId,
          expectedVersionId: versionId,
        });
      if (dossier) {
        const occurrence = Date.now();
        snapshot = {
          hostedDigest: await digestAdmission(
            tx,
            this.tenantId,
            workflow,
            occurrence,
            occurrence,
            false
          ),
        };
      }
      const pending: WorkflowExecution = {
        id: randomUUID(),
        workflowId: id,
        workflowVersionId: versionId,
        workflowName: workflow.name,
        mode: 'manual',
        status: 'queued',
        finished: false,
        startedAt: nowIso(),
        input: snapshot,
        events: [],
        approvals: [],
      };
      await tx.insert(embeddedExecutions).values({
        agentId: this.tenantId,
        id: pending.id,
        workflowId: id,
        status: pending.status,
        mode: pending.mode,
        finished: false,
        startedAt: pending.startedAt,
        execution: pending,
      });
      await tx.insert(manualSubmissions).values({
        agentId: this.tenantId,
        workflowId: id,
        submissionId,
        ownerId,
        versionId,
        input: snapshot,
        runId: pending.id,
      });
      return { runId: pending.id, fresh: true, workflow, pending };
    });
    if (accepted.fresh && accepted.pending) {
      const controller = new AbortController();
      this.controllers.set(accepted.runId, controller);
      const running = this.runInBackground(accepted.workflow, accepted.pending, controller).finally(
        () => {
          this.controllers.delete(accepted.runId);
          this.running.delete(accepted.runId);
        }
      );
      this.running.set(accepted.runId, running);
      return accepted.pending;
    }
    return this.getExecution(accepted.runId);
  }

  async startWorkflow(
    id: string,
    options: ExecuteWorkflowOptions = {}
  ): Promise<WorkflowExecution> {
    const accepted = await this.getDb().transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(embeddedWorkflows)
        .where(and(eq(embeddedWorkflows.agentId, this.tenantId), eq(embeddedWorkflows.id, id)))
        .for('update');
      if (!row) throw new WorkflowApiError('Workflow not found', 404);
      const workflow = responseFromStored(row);
      let hosted: Record<string, unknown> | undefined;
      if (workflow.metadata?.[HOSTED_SPEC]) {
        if (validateDigestSpec(JSON.parse(String(workflow.metadata[HOSTED_SPEC]))).manualOnly)
          throw new WorkflowApiError('Dossiers require explicit owner submission', 409);
        const context = digestRecord(options.triggerData ?? options.input),
          scheduledAt = context.scheduledAtMs;
        if (
          options.mode !== 'trigger' ||
          typeof scheduledAt !== 'number' ||
          !Number.isSafeInteger(scheduledAt) ||
          scheduledAt > Date.now() + 1000 ||
          context.workflowVersionId !== workflow.versionId
        )
          throw new WorkflowApiError('Digest requires its exact current scheduled occurrence', 409);
        options = {
          ...options,
          idempotencyKey: `hosted:${workflow.id}:${workflow.versionId}:${scheduledAt}`,
        };
      }
      if (options.idempotencyKey) {
        const [prior] = await tx
          .select()
          .from(embeddedExecutions)
          .where(
            and(
              eq(embeddedExecutions.agentId, this.tenantId),
              eq(embeddedExecutions.workflowId, id),
              eq(embeddedExecutions.idempotencyKey, options.idempotencyKey)
            )
          )
          .limit(1);
        if (prior)
          return {
            workflow,
            pending: cloneJson(prior.execution),
            fresh: false,
          };
      }
      requireMutable(workflow);
      if ((options.mode === 'trigger' || options.mode === 'schedule') && !workflow.active)
        throw new WorkflowApiError('Workflow is paused', 409);
      if (workflow.metadata?.[HOSTED_SPEC]) {
        const scheduledAt = Number((options.triggerData ?? options.input)?.scheduledAtMs);
        hosted = await digestAdmission(tx, this.tenantId, workflow, Date.now(), scheduledAt);
        const [active] = await tx
          .select()
          .from(embeddedExecutions)
          .where(
            and(
              eq(embeddedExecutions.agentId, this.tenantId),
              eq(embeddedExecutions.workflowId, id),
              eq(embeddedExecutions.finished, false)
            )
          )
          .limit(1);
        if (active && hosted.status === 'ready')
          hosted = {
            ...hosted,
            status: 'overlap',
            text: 'An earlier occurrence is still active. This occurrence did not run.',
          };
      }
      const pending: WorkflowExecution = {
        id: randomUUID(),
        workflowId: id,
        workflowVersionId: workflow.versionId,
        workflowName: workflow.name,
        mode: options.mode ?? 'manual',
        status: hosted && hosted.status !== 'ready' ? 'finished' : 'queued',
        finished: !!hosted && hosted.status !== 'ready',
        ...(hosted && hosted.status !== 'ready' ? { stoppedAt: nowIso(), output: hosted } : {}),
        startedAt: nowIso(),
        input: cloneJson(
          hosted
            ? { ...options.input, ...options.triggerData, hostedDigest: hosted }
            : (options.input ?? options.triggerData ?? {})
        ),
        events: [],
        approvals: [],
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        ...(options.triggerChainDepth !== undefined
          ? { triggerChainDepth: options.triggerChainDepth }
          : {}),
      };
      await tx.insert(embeddedExecutions).values({
        agentId: this.tenantId,
        id: pending.id,
        workflowId: id,
        status: pending.status,
        mode: pending.mode,
        finished: pending.finished,
        stoppedAt: pending.stoppedAt ?? null,
        startedAt: pending.startedAt,
        execution: pending,
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      });
      if (pending.finished) await writeDigestResult(tx, this.tenantId, workflow, pending);
      return { workflow, pending, fresh: true };
    });
    if (
      accepted.fresh &&
      accepted.pending.finished &&
      (accepted.pending.output as Record<string, unknown> | undefined)?.paused === true
    )
      await this.syncSchedule(accepted.workflow);
    if (accepted.fresh && !accepted.pending.finished) {
      const controller = new AbortController();
      this.controllers.set(accepted.pending.id, controller);
      const promise = this.runInBackground(accepted.workflow, accepted.pending, controller).finally(
        () => {
          this.controllers.delete(accepted.pending.id);
          this.running.delete(accepted.pending.id);
        }
      );
      this.running.set(accepted.pending.id, promise);
    }
    return accepted.pending;
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
    const running: WorkflowExecution = { ...pending, status: 'running' };
    await this.saveExecution(running);
    if (running.cancellationRequestedAt || controller.signal.aborted) {
      const cancelled = {
        ...running,
        status: 'cancelled' as const,
        finished: true,
        stoppedAt: nowIso(),
      };
      await this.saveExecution(cancelled);
      return cancelled;
    }
    try {
      let executionWorkflow = workflow;
      const assertLiveGrant = async () => {
        if (!workflow.metadata?.[HOSTED_SPEC]) return;
        const spec = validateDigestSpec(JSON.parse(String(workflow.metadata[HOSTED_SPEC])));
        const owner = String(workflow.metadata.elizaOwnerEntityId || '');
        const source = await digestSource(this.getDb(), this.tenantId, owner, spec.sourceId);
        if (
          source.revoked ||
          source.revision !== spec.sourceRevision ||
          Date.parse(source.expiresAt) <= Date.now()
        )
          throw new WorkflowApiError('Hosted source grant expired or was revoked', 409);
        if (source.live?.provider === 'native')
          await assertHostedNativeSource(this.runtime, owner, source.live);
        else if (source.live) await assertHostedGoogleSource(this.runtime, owner, source.live);
      };
      if (workflow.metadata?.[HOSTED_SPEC]) {
        const context = digestRecord(pending.input.hostedDigest),
          admission = await digestAdmission(
            this.getDb(),
            this.tenantId,
            workflow,
            Date.now(),
            Date.parse(String(context.scheduledAt)),
            false
          );
        if (admission.status !== 'ready') {
          const unavailable: WorkflowExecution = {
            ...running,
            status: 'finished',
            finished: true,
            stoppedAt: nowIso(),
            output: admission,
          };
          await this.saveExecution(unavailable);
          if ((admission as Record<string, unknown>).paused === true)
            await this.syncSchedule(workflow);
          return unavailable;
        }
        const spec = validateDigestSpec(JSON.parse(String(workflow.metadata[HOSTED_SPEC])));
        const owner = String(workflow.metadata.elizaOwnerEntityId || '');
        const source = await digestSource(this.getDb(), this.tenantId, owner, spec.sourceId);
        if (source.live) {
          const fresh =
            source.live.provider === 'native'
              ? await readHostedNativeSource(
                  this.runtime,
                  owner,
                  source.live,
                  String(context.scheduledAt),
                  controller.signal,
                  spec.template
                )
              : await readHostedGoogleSource(this.runtime, owner, source.live, {
                  signal: controller.signal,
                });
          await assertLiveGrant();
          const compiled = phoneDraftDefinition(
            validatePhoneSpec(digestPhoneSpec(spec, { ...source, ...fresh }))
          );
          executionWorkflow = {
            ...workflow,
            source: compiled.source,
            steps: compiled.steps,
            metadata: { ...workflow.metadata, ...compiled.metadata },
          };
          running.input = {
            ...running.input,
            hostedDigest: {
              ...context,
              ...('receipt' in fresh ? { nativeReadReceipt: fresh.receipt } : {}),
              source: {
                ...digestRecord(context.source),
                observedAt: fresh.observedAt,
                type:
                  source.live.provider === 'native'
                    ? 'live_selected_native_read'
                    : 'live_selected_google_read',
              },
            },
          };
          await this.saveExecution(running);
        }
      }
      if (workflow.metadata?.[PHONE_SPEC_KEY]) {
        const spec = validatePhoneSpec(JSON.parse(String(workflow.metadata[PHONE_SPEC_KEY])));
        if (
          !verifyPhoneWorkflowSource(spec, workflow.source, workflow.metadata?.[PHONE_COMPILER_KEY])
        )
          throw new WorkflowApiError('Typed executor integrity mismatch', 409);
      }
      const result = await runSmithersWorkflow({
        tenantId: this.tenantId,
        workflow: executionWorkflow,
        runId: pending.id,
        mode: pending.mode,
        input: pending.input,
        eventSequenceOffset: (pending.events ?? []).reduce(
          (max, event) => Math.max(max, event.sequence),
          0
        ),
        signal: controller.signal,
        onEvent: (event) => this.recordEvent(running, event),
        device: async ({ payload, signal }) => {
          if (!workflow.metadata?.[PHONE_SPEC_KEY])
            throw new WorkflowApiError('Device dispatcher only accepts fixed typed workflows', 409);
          const spec = validatePhoneSpec(JSON.parse(String(workflow.metadata[PHONE_SPEC_KEY])));
          if (
            !spec.device ||
            !verifyPhoneWorkflowSource(
              spec,
              workflow.source,
              workflow.metadata?.[PHONE_COMPILER_KEY]
            )
          )
            throw new WorkflowApiError('Typed device authority unavailable', 409);
          if (!payload || typeof payload !== 'object' || Array.isArray(payload))
            throw new WorkflowApiError('Invalid device request', 400);
          const value = payload as Record<string, unknown>;
          if (
            Object.keys(value).some((key) => !['stepId', 'operation'].includes(key)) ||
            typeof value.stepId !== 'string'
          )
            throw new WorkflowApiError('Invalid device step request', 400);
          const bridge = this.runtime.getService('workflow_device_bridge') as unknown as {
            dispatch(owner: string, request: unknown, signal: AbortSignal): Promise<unknown>;
          } | null;
          if (!bridge) throw new WorkflowApiError('Workflow device bridge unavailable', 503);
          const owner = workflow.metadata.elizaOwnerEntityId;
          if (typeof owner !== 'string')
            throw new WorkflowApiError('Workflow owner unavailable', 409);
          running.status = 'waiting-approval';
          await this.saveExecution(running);
          try {
            return await bridge.dispatch(
              owner,
              {
                binding: {
                  workflowId: workflow.id,
                  versionId: workflow.versionId,
                  runId: pending.id,
                  stepId: value.stepId,
                  specDigest: phoneSpecDigest(spec),
                },
                target: spec.device,
                operation: value.operation,
              },
              signal
            );
          } finally {
            running.status = 'running';
            await this.saveExecution(running);
          }
        },
        generate: async ({ prompt, messages, signal }) => {
          await assertLiveGrant();
          const promptText =
            typeof prompt === 'string' ? prompt : JSON.stringify(prompt ?? messages ?? '');
          return this.runtime.useModel(ModelType.TEXT_LARGE, {
            prompt: promptText,
            signal,
          });
        },
      });
      await assertLiveGrant();
      const completed: WorkflowExecution = {
        ...running,
        status: result.status,
        reconciliation: undefined,
        error: undefined,
        finished: ['cancelled', 'continued', 'failed', 'finished'].includes(result.status),
        stoppedAt: ['cancelled', 'continued', 'failed', 'finished'].includes(result.status)
          ? nowIso()
          : null,
        // recordEvent already appended this invocation's events to the
        // persisted history. result.events contains only this new batch.
        ...(result.output !== undefined ? { output: result.output } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.nextRunId ? { nextRunId: result.nextRunId } : {}),
      };
      await this.saveExecution(completed);
      return completed;
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        [
          'WORKFLOW_WORKER_RUNNING',
          'WORKFLOW_WORKER_OUTCOME_UNKNOWN',
          'WORKFLOW_WORKER_UNRESOLVED',
        ].includes(String(error.code))
      ) {
        const message = error instanceof Error ? error.message : String(error);
        const unresolved: WorkflowExecution = {
          ...running,
          finished: false,
          stoppedAt: null,
          reconciliation: {
            state: error.code === 'WORKFLOW_WORKER_RUNNING' ? 'worker-running' : 'outcome-unknown',
            message,
          },
          error: { message },
        };
        await this.saveExecution(unresolved);
        if (unresolved.reconciliation?.state === 'worker-running') {
          this.scheduleWorkerReconciliation(unresolved);
        } else {
          const pendingTimer = this.workerReconciliations.get(unresolved.id);
          if (pendingTimer) clearTimeout(pendingTimer);
          this.workerReconciliations.delete(unresolved.id);
        }
        return unresolved;
      }
      // error-policy:J1 child-process failures become explicit failed run state.
      const workerTermination = workerTerminationFromError(error);
      const failed: WorkflowExecution = {
        ...running,
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        finished: true,
        stoppedAt: nowIso(),
        error: {
          ...(workerTermination ? { workerTermination } : {}),
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
    return (await this.cancelExecutionWithReceipt(runId)).execution;
  }

  async cancelExecutionWithReceipt(runId: string): Promise<WorkflowCancellationResult> {
    const requested = await this.getDb().transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(embeddedExecutions)
        .where(and(eq(embeddedExecutions.agentId, this.tenantId), eq(embeddedExecutions.id, runId)))
        .for('update');
      if (!row) throw new WorkflowApiError('Workflow execution not found', 404);
      if (row.execution.finished)
        return {
          execution: cloneJson(row.execution),
          request: row.execution.cancellationRequestedAt
            ? {
                requestedAt: row.execution.cancellationRequestedAt,
                replayed: true,
              }
            : null,
        };
      const execution = {
        ...row.execution,
        cancellationRequestedAt: row.execution.cancellationRequestedAt ?? nowIso(),
      };
      await tx
        .update(embeddedExecutions)
        .set({ execution })
        .where(
          and(eq(embeddedExecutions.agentId, this.tenantId), eq(embeddedExecutions.id, runId))
        );
      return {
        execution,
        request: {
          requestedAt: execution.cancellationRequestedAt,
          replayed: Boolean(row.execution.cancellationRequestedAt),
        },
      };
    });
    const execution = requested.execution;
    const outcome = (value: WorkflowExecution): WorkflowCancellationResult => ({
      execution: value,
      request: requested.request,
    });
    if (execution.finished && execution.status !== 'cancelled') return outcome(execution);
    // Admission/provenance above remains transactional and concurrent. Native
    // control workers open one Smithers store per workflow; serialize their
    // cancellation commands to avoid racing SQLite schema initialization.
    const key = execution.workflowId;
    const previous = this.cancellationControls.get(key) ?? Promise.resolve();
    const completion = previous
      .catch(() => undefined)
      .then(async () => {
        const controller = this.controllers.get(runId);
        const running = this.running.get(runId);
        controller?.abort();
        // Preserve active-worker teardown, then use the same durable cancellation
        // policy for a parked run whose worker/controller has already exited.
        if (running) await running;
        const receipt = await controlSmithersRun(this.tenantId, execution.workflowId, {
          kind: 'cancel',
          runId,
        });
        const current = await this.getExecution(runId);
        // A captured terminal winner committed during teardown remains authoritative.
        if (current.finished && current.status !== 'cancelled') return outcome(current);
        // An aborted queued worker may never create its native run row. Its
        // persisted terminal cancellation remains idempotent on later requests.
        if (receipt.status === null && current.finished && current.status === 'cancelled')
          return outcome(current);
        if (receipt.status === null) {
          // No native row means cancellation won before worker admission. Never evaluate source.
          await this.saveExecution({
            ...current,
            status: 'cancelled',
            finished: true,
            stoppedAt: current.stoppedAt ?? nowIso(),
          });
          return outcome(await this.getExecution(runId));
        }
        if (current.finished && current.status === receipt.status) return outcome(current);
        if (receipt.status !== 'cancelled') {
          // The native commit can precede emission of its result. Without that
          // matching receipt, status alone cannot recover output/error/nextRunId.
          const message = `Native workflow ${receipt.status}, but its terminal result was not captured; the workflow was not resumed.`;
          await this.saveExecution(
            {
              ...current,
              status: 'failed',
              finished: true,
              stoppedAt: current.stoppedAt ?? nowIso(),
              error: { message },
            },
            current
          );
          throw new WorkflowApiError(message, 409, {
            code: 'WORKFLOW_TERMINAL_RESULT_UNAVAILABLE',
            nativeStatus: receipt.status,
            executionId: runId,
          });
        }
        await this.saveExecution(
          {
            ...current,
            status: receipt.status,
            finished: true,
            stoppedAt: current.stoppedAt ?? nowIso(),
          },
          current
        );

        return outcome(await this.getExecution(runId));
      });
    const pending = completion.then(
      () => undefined,
      () => undefined
    );
    this.cancellationControls.set(key, pending);
    try {
      return await completion;
    } finally {
      if (this.cancellationControls.get(key) === pending) this.cancellationControls.delete(key);
    }
  }

  async approvalReceipts(runId: string) {
    const execution = await this.getExecution(runId);
    return {
      runId,
      workflowId: execution.workflowId,
      workflowVersionId: execution.workflowVersionId,
      cancellationRequested: !!execution.cancellationRequestedAt,
      finished: execution.finished,
      approvals: await readApprovalReceipts(this.tenantId, execution),
    };
  }

  async decideReviewedApproval(
    runId: string,
    nodeId: string,
    iteration: number,
    approved: boolean,
    expectedVersionId: string,
    requestDigest: string,
    ownerId: string
  ) {
    await this.getDb().transaction(async (tx) => {
      const where = and(
        eq(embeddedExecutions.agentId, this.tenantId),
        eq(embeddedExecutions.id, runId)
      );
      const [row] = await tx.select().from(embeddedExecutions).where(where).for('update');
      if (!row) throw new WorkflowApiError('Execution not found', 404);
      const execution = cloneJson(row.execution);
      if (execution.workflowVersionId !== expectedVersionId)
        throw new WorkflowApiError('Approval run version changed', 409);
      const receipts = await readApprovalReceipts(this.tenantId, execution);
      const receipt = receipts.find(
        (item) => item.nodeId === nodeId && item.iteration === iteration
      );
      if (!receipt || receipt.requestDigest !== requestDigest)
        throw new WorkflowApiError('Approval request changed or unavailable', 409);
      const decision = approved ? 'approved' : 'denied';
      if (receipt.status !== 'pending') {
        if (receipt.status !== decision || receipt.decidedBy !== ownerId)
          throw new WorkflowApiError('Approval already decided', 409);
        return; // Canonical readback, not another engine command.
      }
      if (execution.finished || execution.cancellationRequestedAt)
        throw new WorkflowApiError('Execution cannot accept decisions', 409);
      if (approved && !receipt.supported)
        throw new WorkflowApiError('Approval requires unsupported review fields', 422);
      try {
        await controlSmithersRun(this.tenantId, execution.workflowId, {
          kind: approved ? 'approve' : 'deny',
          runId,
          nodeId,
          iteration,
          decidedBy: ownerId,
        });
      } catch (error) {
        const after = await readApprovalReceipts(this.tenantId, execution);
        const committed = after.find(
          (item) => item.nodeId === nodeId && item.iteration === iteration
        );
        if (
          committed?.status !== decision ||
          committed.requestDigest !== requestDigest ||
          committed.decidedBy !== ownerId
        )
          throw error;
      }
      const canonical = (await readApprovalReceipts(this.tenantId, execution)).find(
        (item) => item.nodeId === nodeId && item.iteration === iteration
      );
      if (!canonical || canonical.status !== decision || canonical.requestDigest !== requestDigest)
        throw new WorkflowApiError('Approval outcome unknown; refresh its receipt', 503);
      execution.approvals = [
        ...(execution.approvals ?? []).filter(
          (item) => item.nodeId !== nodeId || item.iteration !== iteration
        ),
        {
          runId,
          workflowId: execution.workflowId,
          nodeId,
          iteration,
          status: decision,
          requestedAt: receipt.decidedAt ?? nowIso(),
          decidedAt: canonical.decidedAt,
          decidedBy: ownerId,
          prompt: receipt.summary,
        },
      ];
      await tx.update(embeddedExecutions).set({ execution }).where(where);
    });
    await this.resumeExecution(await this.getExecution(runId));
    return this.approvalReceipts(runId);
  }

  async decideApproval(
    runId: string,
    nodeId: string,
    iteration: number,
    approved: boolean,
    options: { note?: string; decidedBy?: string; decision?: unknown } = {}
  ): Promise<WorkflowExecution> {
    const execution = await this.getExecution(runId);
    if (execution.finished || execution.cancellationRequestedAt)
      throw new WorkflowApiError('Workflow execution cannot accept decisions', 409);
    if (approved) {
      const receipt = (await readApprovalReceipts(this.tenantId, execution)).find(
        (item) => item.nodeId === nodeId && item.iteration === iteration
      );
      if (!receipt?.supported)
        throw new WorkflowApiError('Approval requires unsupported review fields', 422);
    }
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
    return this.getExecution(runId);
  }

  async signalExecution(
    runId: string,
    signal: string,
    payload: unknown,
    receivedBy?: string
  ): Promise<WorkflowExecution> {
    if (!signal.trim()) throw new WorkflowApiError('Signal name is required', 400);
    const execution = await this.getExecution(runId);
    if (execution.finished)
      throw new WorkflowApiError('Workflow execution is already terminal', 409);
    await controlSmithersRun(this.tenantId, execution.workflowId, {
      kind: 'signal',
      runId,
      signal,
      payload,
      ...(receivedBy ? { receivedBy } : {}),
    });
    await this.resumeExecution(execution);
    return this.getExecution(runId);
  }

  private async saveExecution(
    execution: WorkflowExecution,
    reconcileDurableTerminal?: WorkflowExecution
  ): Promise<void> {
    const hostedWorkflow =
      execution.finished && execution.input.hostedDigest
        ? await this.workflowVersionForExecution(execution)
        : null;
    await this.getDb().transaction(async (tx) => {
      const where = and(
        eq(embeddedExecutions.agentId, this.tenantId),
        eq(embeddedExecutions.id, execution.id)
      );
      const [existing] = await tx.select().from(embeddedExecutions).where(where).for('update');
      // Late event snapshots cannot erase a durable cancellation request or resurrect a terminal run.
      if (existing?.execution.cancellationRequestedAt)
        execution.cancellationRequestedAt = existing.execution.cancellationRequestedAt;
      const reconcilesCancellation =
        existing?.execution.finished &&
        existing.execution.status === 'cancelled' &&
        execution.finished &&
        execution.status === 'failed' &&
        reconcileDurableTerminal !== undefined &&
        isDeepStrictEqual(existing.execution, reconcileDurableTerminal);
      if (existing?.execution.finished && !reconcilesCancellation) return;
      const values = {
        status: execution.status,
        mode: execution.mode,
        finished: execution.finished,
        startedAt: execution.startedAt,
        stoppedAt: execution.stoppedAt ?? null,
        execution: cloneJson(execution),
        idempotencyKey: execution.idempotencyKey ?? null,
      };
      if (existing) await tx.update(embeddedExecutions).set(values).where(where);
      else
        await tx.insert(embeddedExecutions).values({
          agentId: this.tenantId,
          id: execution.id,
          workflowId: execution.workflowId,
          ...values,
        });
      if (hostedWorkflow) {
        // Replace only the reconciled provisional cancellation, atomically with its host row.
        if (reconcilesCancellation)
          await tx
            .delete(hostedResults)
            .where(
              and(eq(hostedResults.agentId, this.tenantId), eq(hostedResults.runId, execution.id))
            );
        await writeDigestResult(tx, this.tenantId, hostedWorkflow, execution);
      }
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
    return {
      data: params.limit === undefined ? data : data.slice(0, Math.max(0, params.limit)),
    };
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

  async pinnedWorkflowDefinition(
    workflowId: string,
    versionId: string
  ): Promise<WorkflowDefinition> {
    const current = await this.getWorkflow(workflowId);
    if (current.versionId === versionId) return current;
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
    if (!rows[0]) throw new WorkflowApiError('Pinned workflow definition unavailable', 404);
    return cloneJson(rows[0].workflow);
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
    const tag = {
      id: randomUUID(),
      name: name.trim(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    if (!tag.name) throw new WorkflowApiError('Tag name is required', 400);
    await this.getDb()
      .insert(embeddedTags)
      .values({ agentId: this.tenantId, ...tag });
    return tag;
  }

  async getOrCreateTag(name: string): Promise<WorkflowTag> {
    const normalizedName = name.trim();
    if (!normalizedName) throw new WorkflowApiError('Tag name is required', 400);
    const timestamp = nowIso();
    await this.getDb()
      .insert(embeddedTags)
      .values({
        agentId: this.tenantId,
        id: randomUUID(),
        name: normalizedName,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoNothing({
        target: [embeddedTags.agentId, embeddedTags.name],
      });
    const rows = await this.getDb()
      .select()
      .from(embeddedTags)
      .where(and(eq(embeddedTags.agentId, this.tenantId), eq(embeddedTags.name, normalizedName)))
      .limit(1);
    const tag = rows[0];
    if (!tag) {
      throw new WorkflowApiError(`Tag could not be read after creation: ${normalizedName}`, 500);
    }
    return cloneJson(tag);
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
