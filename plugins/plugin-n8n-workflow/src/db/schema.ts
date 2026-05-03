import { pgSchema, text, timestamp, uuid, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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
