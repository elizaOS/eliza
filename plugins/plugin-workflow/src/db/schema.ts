/**
 * Drizzle schema for the plugin's Postgres tables, grouped under the `workflow`
 * pgSchema: workflows, workflow revisions, executions, and tags.
 *
 * Registered on the plugin's `schema` field so the runtime provisions and
 * migrates these tables. EmbeddedWorkflowService reads and writes them directly
 * as both the CRUD store and the execution log. Every table carries `agent_id`;
 * legacy rows are quarantined under a sentinel tenant.
 */
import {
  bigint,
  bigserial,
  boolean,
  index,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { WorkflowDefinition, WorkflowExecution } from '../types/index';

export const workflowSchema = pgSchema('workflow');

/**
 * Tenant assigned to rows written before workflow persistence was agent-scoped.
 * It is deliberately not a valid runtime agent id: migrations quarantine legacy
 * rows here instead of letting the first runtime that boots claim their data.
 */
export const LEGACY_UNSCOPED_WORKFLOW_AGENT_ID = '__legacy_unscoped__';

export const embeddedWorkflows = workflowSchema.table(
  'embedded_workflows',
  {
    agentId: text('agent_id').notNull().default(LEGACY_UNSCOPED_WORKFLOW_AGENT_ID),
    id: text('id').notNull(),
    name: text('name').notNull(),
    active: boolean('active').default(false).notNull(),
    workflow: jsonb('workflow').$type<WorkflowDefinition>().notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    versionId: text('version_id').notNull(),
  },
  (table) => ({
    tenantPk: primaryKey({
      name: 'embedded_workflows_tenant_pkey',
      columns: [table.agentId, table.id],
    }),
    activeIdx: index('idx_embedded_workflows_agent_active').on(table.agentId, table.active),
    updatedAtIdx: index('idx_embedded_workflows_agent_updated_at').on(
      table.agentId,
      table.updatedAt
    ),
  })
);

export const workflowRevisions = workflowSchema.table(
  'workflow_revisions',
  {
    agentId: text('agent_id').notNull().default(LEGACY_UNSCOPED_WORKFLOW_AGENT_ID),
    id: text('id').notNull(),
    workflowId: text('workflow_id').notNull(),
    versionId: text('version_id').notNull(),
    name: text('name').notNull(),
    active: boolean('active').default(false).notNull(),
    workflow: jsonb('workflow').$type<WorkflowDefinition>().notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    capturedAt: text('captured_at').notNull(),
    operation: text('operation').notNull(),
  },
  (table) => ({
    tenantPk: primaryKey({
      name: 'workflow_revisions_tenant_pkey',
      columns: [table.agentId, table.id],
    }),
    workflowIdx: index('idx_workflow_revisions_agent_workflow_id').on(
      table.agentId,
      table.workflowId
    ),
    versionIdx: uniqueIndex('idx_workflow_revisions_agent_workflow_version').on(
      table.agentId,
      table.workflowId,
      table.versionId
    ),
    capturedAtIdx: index('idx_workflow_revisions_agent_captured_at').on(
      table.agentId,
      table.capturedAt
    ),
  })
);

export const embeddedExecutions = workflowSchema.table(
  'embedded_executions',
  {
    agentId: text('agent_id').notNull().default(LEGACY_UNSCOPED_WORKFLOW_AGENT_ID),
    id: text('id').notNull(),
    workflowId: text('workflow_id').notNull(),
    status: text('status').notNull(),
    mode: text('mode').notNull(),
    finished: boolean('finished').default(false).notNull(),
    startedAt: text('started_at').notNull(),
    stoppedAt: text('stopped_at'),
    execution: jsonb('execution').$type<WorkflowExecution>().notNull(),
    /**
     * Per-dispatch idempotency key. Scheduled dispatches use
     * `${workflowId}:${minuteBucket}` so re-arms inside the same minute
     * collapse to a single execution. Null for ad-hoc / manual runs.
     */
    idempotencyKey: text('idempotency_key'),
  },
  (table) => ({
    tenantPk: primaryKey({
      name: 'embedded_executions_tenant_pkey',
      columns: [table.agentId, table.id],
    }),
    workflowIdx: index('idx_embedded_executions_agent_workflow_id').on(
      table.agentId,
      table.workflowId
    ),
    statusIdx: index('idx_embedded_executions_agent_status').on(table.agentId, table.status),
    startedAtIdx: index('idx_embedded_executions_agent_started_at').on(
      table.agentId,
      table.startedAt
    ),
    idempotencyKeyIdx: index('idx_embedded_executions_agent_idempotency_key').on(
      table.agentId,
      table.idempotencyKey
    ),
  })
);

export const embeddedTags = workflowSchema.table(
  'embedded_tags',
  {
    agentId: text('agent_id').notNull().default(LEGACY_UNSCOPED_WORKFLOW_AGENT_ID),
    id: text('id').notNull(),
    name: text('name').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    tenantPk: primaryKey({
      name: 'embedded_tags_tenant_pkey',
      columns: [table.agentId, table.id],
    }),
    nameIdx: uniqueIndex('idx_embedded_tags_agent_name').on(table.agentId, table.name),
  })
);

/** New manual submissions only. Legacy scheduled keys are not rewritten. */
export const manualSubmissions = workflowSchema.table(
  'manual_submissions',
  {
    agentId: text('agent_id').notNull(),
    workflowId: text('workflow_id').notNull(),
    submissionId: text('submission_id').notNull(),
    ownerId: text('owner_id').notNull(),
    versionId: text('version_id').notNull(),
    input: jsonb('input').$type<Record<string, unknown>>().notNull(),
    runId: text('run_id').notNull(),
  },
  (table) => ({
    submissionPk: primaryKey({ columns: [table.agentId, table.workflowId, table.submissionId] }),
  })
);

/** Owner-scoped metadata-only edits; immutable receipt survives lost responses. */
export const metadataMutations = workflowSchema.table(
  'metadata_mutations',
  {
    agentId: text('agent_id').notNull(),
    workflowId: text('workflow_id').notNull(),
    mutationId: text('mutation_id').notNull(),
    ownerId: text('owner_id').notNull(),
    expectedVersionId: text('expected_version_id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    receipt: jsonb('receipt')
      .$type<{
        mutationId: string;
        workflowId: string;
        previousVersionId: string;
        versionId: string;
        name: string;
        description: string;
        active: boolean;
        appliedAt: string;
      }>()
      .notNull(),
  },
  (table) => ({
    mutationPk: primaryKey({ columns: [table.agentId, table.workflowId, table.mutationId] }),
  })
);

/** Receipt-preserving remove/restore, separate from workflow execution. */
export const lifecycleMutations = workflowSchema.table(
  'lifecycle_mutations',
  {
    agentId: text('agent_id').notNull(),
    workflowId: text('workflow_id').notNull(),
    mutationId: text('mutation_id').notNull(),
    ownerId: text('owner_id').notNull(),
    expectedVersionId: text('expected_version_id').notNull(),
    operation: text('operation').notNull(),
    receipt: jsonb('receipt')
      .$type<{
        mutationId: string;
        workflowId: string;
        previousVersionId: string;
        versionId: string;
        operation: 'remove' | 'restore';
        appliedAt: string;
      }>()
      .notNull(),
  },
  (table) => ({
    lifecyclePk: primaryKey({ columns: [table.agentId, table.workflowId, table.mutationId] }),
  })
);

/** One immutable owner-scoped receipt for typed creation or full-spec editing. */
export const typedMutations = workflowSchema.table(
  'typed_mutations',
  {
    agentId: text('agent_id').notNull(),
    ownerId: text('owner_id').notNull(),
    mutationId: text('mutation_id').notNull(),
    requestDigest: text('request_digest').notNull(),
    workflowId: text('workflow_id').notNull(),
    receipt: jsonb('receipt')
      .$type<{
        mutationId: string;
        workflowId: string;
        operation: 'create' | 'edit';
        previousVersionId: string | null;
        versionId: string;
        specDigest: string;
        compilerRevision: string;
        appliedAt: string;
      }>()
      .notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.agentId, table.ownerId, table.mutationId] }) })
);

/** Delivery state only. Existing embedded_executions remains execution authority. */
export const hostedSources = workflowSchema.table(
  'hosted_sources',
  {
    agentId: text('agent_id').notNull(),
    ownerId: text('owner_id').notNull(),
    id: text('id').notNull(),
    source: jsonb('source').$type<import('../services/hosted-digest').DigestSource>().notNull(),
    revoked: boolean('revoked').notNull().default(false),
  },
  (t) => ({ pk: primaryKey({ columns: [t.agentId, t.ownerId, t.id] }) })
);
export const hostedResults = workflowSchema.table(
  'hosted_results',
  {
    agentId: text('agent_id').notNull(),
    ownerId: text('owner_id').notNull(),
    runId: text('run_id').notNull(),
    workflowId: text('workflow_id').notNull(),
    sequence: bigserial('sequence', { mode: 'number' }).notNull(),
    result: jsonb('result').$type<Record<string, unknown>>().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.agentId, t.runId] }),
    cursor: index('hosted_results_cursor').on(t.agentId, t.ownerId, t.sequence),
  })
);
export const hostedCursors = workflowSchema.table(
  'hosted_cursors',
  {
    agentId: text('agent_id').notNull(),
    ownerId: text('owner_id').notNull(),
    clientId: text('client_id').notNull(),
    cursor: bigint('cursor', { mode: 'number' }).notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.agentId, t.ownerId, t.clientId] }) })
);
