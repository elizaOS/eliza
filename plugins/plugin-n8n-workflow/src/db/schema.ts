import {
  boolean,
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type {
  N8nExecution,
  N8nWorkflow,
} from '../types/index';

export const n8nWorkflowSchema = pgSchema('n8n_workflow');

export const credentialMappings = n8nWorkflowSchema.table(
  'credential_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    credType: text('cred_type').notNull(),
    n8nCredentialId: text('n8n_credential_id').notNull(),
    createdAt: timestamp('created_at')
      .default(sql`now()`)
      .notNull(),
    updatedAt: timestamp('updated_at')
      .default(sql`now()`)
      .notNull(),
  },
  (table) => ({
    userCredIdx: uniqueIndex('idx_user_cred').on(table.userId, table.credType),
  })
);

export const embeddedWorkflows = n8nWorkflowSchema.table(
  'embedded_workflows',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    active: boolean('active').default(false).notNull(),
    workflow: jsonb('workflow').$type<N8nWorkflow>().notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    versionId: text('version_id').notNull(),
  },
  (table) => ({
    activeIdx: index('idx_embedded_workflows_active').on(table.active),
    updatedAtIdx: index('idx_embedded_workflows_updated_at').on(table.updatedAt),
  })
);

export const embeddedExecutions = n8nWorkflowSchema.table(
  'embedded_executions',
  {
    id: text('id').primaryKey(),
    workflowId: text('workflow_id').notNull(),
    status: text('status').notNull(),
    mode: text('mode').notNull(),
    finished: boolean('finished').default(false).notNull(),
    startedAt: text('started_at').notNull(),
    stoppedAt: text('stopped_at'),
    execution: jsonb('execution').$type<N8nExecution>().notNull(),
  },
  (table) => ({
    workflowIdx: index('idx_embedded_executions_workflow_id').on(table.workflowId),
    statusIdx: index('idx_embedded_executions_status').on(table.status),
    startedAtIdx: index('idx_embedded_executions_started_at').on(table.startedAt),
  })
);

export const embeddedCredentials = n8nWorkflowSchema.table(
  'embedded_credentials',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    isResolvable: boolean('is_resolvable').default(true).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    typeIdx: index('idx_embedded_credentials_type').on(table.type),
  })
);

export const embeddedTags = n8nWorkflowSchema.table(
  'embedded_tags',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    nameIdx: uniqueIndex('idx_embedded_tags_name').on(table.name),
  })
);
