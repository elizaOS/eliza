/**
 * Drizzle schema for the plugin's Postgres tables, grouped under the `workflow`
 * pgSchema: credential mappings, workflows, workflow revisions, executions,
 * embedded credentials, and tags.
 *
 * Registered on the plugin's `schema` field so the runtime provisions and
 * migrates these tables. EmbeddedWorkflowService reads and writes them directly
 * as both the CRUD store and the execution log; WorkflowCredentialStore owns the
 * agent-scoped (userId, credType) → credential-id mappings table. Every table
 * carries `agent_id`; legacy rows are quarantined under a sentinel tenant.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { WorkflowDefinition, WorkflowExecution } from '../types/index';

export const workflowSchema = pgSchema('workflow');

/**
 * Tenant assigned to rows written before workflow persistence was agent-scoped.
 * It is deliberately not a valid runtime agent id: migrations quarantine legacy
 * rows here instead of letting the first runtime that boots claim their data.
 */
export const LEGACY_UNSCOPED_WORKFLOW_AGENT_ID = '__legacy_unscoped__';

export const credentialMappings = workflowSchema.table(
  'credential_mappings',
  {
    agentId: text('agent_id').notNull().default(LEGACY_UNSCOPED_WORKFLOW_AGENT_ID),
    id: uuid('id').notNull().defaultRandom(),
    userId: text('user_id').notNull(),
    credType: text('cred_type').notNull(),
    workflowCredentialId: text('workflow_credential_id').notNull(),
    createdAt: timestamp('created_at').default(sql`now()`).notNull(),
    updatedAt: timestamp('updated_at').default(sql`now()`).notNull(),
  },
  (table) => ({
    tenantPk: primaryKey({
      name: 'credential_mappings_tenant_pkey',
      columns: [table.agentId, table.id],
    }),
    userCredIdx: uniqueIndex('idx_credential_mappings_agent_user_cred').on(
      table.agentId,
      table.userId,
      table.credType
    ),
  })
);

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

export const embeddedCredentials = workflowSchema.table(
  'embedded_credentials',
  {
    agentId: text('agent_id').notNull().default(LEGACY_UNSCOPED_WORKFLOW_AGENT_ID),
    id: text('id').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    isResolvable: boolean('is_resolvable').default(true).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    tenantPk: primaryKey({
      name: 'embedded_credentials_tenant_pkey',
      columns: [table.agentId, table.id],
    }),
    typeIdx: index('idx_embedded_credentials_agent_type').on(table.agentId, table.type),
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
