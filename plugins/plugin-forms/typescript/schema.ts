import { relations, sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  index,
  timestamp,
  boolean,
  jsonb,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Forms table - stores form instances and their metadata
 */
export const formsTable = pgTable(
  'forms',
  {
    id: uuid('id').primaryKey(),
    agentId: uuid('agent_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').notNull(), // 'active', 'completed', 'cancelled'
    currentStepIndex: integer('current_step_index').default(0).notNull(),
    steps: jsonb('steps').notNull(), // Array of step definitions
    createdAt: timestamp('created_at')
      .default(sql`now()`)
      .notNull(),
    updatedAt: timestamp('updated_at')
      .default(sql`now()`)
      .notNull(),
    completedAt: timestamp('completed_at'),
    metadata: jsonb('metadata').default('{}').notNull(),
  },
  (table) => ({
    agentIdIndex: index('idx_forms_agent').on(table.agentId),
    statusIndex: index('idx_forms_status').on(table.status),
    createdAtIndex: index('idx_forms_created_at').on(table.createdAt),
    updatedAtIndex: index('idx_forms_updated_at').on(table.updatedAt),
  })
);

/**
 * Form fields table - stores field values separately for better querying
 */
export const formFieldsTable = pgTable(
  'form_fields',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    formId: uuid('form_id')
      .references(() => formsTable.id, {
        onDelete: 'cascade',
      })
      .notNull(),
    stepId: text('step_id').notNull(),
    fieldId: text('field_id').notNull(),
    label: text('label').notNull(),
    type: text('type').notNull(),
    value: text('value'), // Stored as text, parsed based on type
    isSecret: boolean('is_secret').default(false).notNull(),
    isOptional: boolean('is_optional').default(false).notNull(),
    description: text('description'),
    criteria: text('criteria'),
    error: text('error'),
    metadata: jsonb('metadata').default('{}').notNull(),
    createdAt: timestamp('created_at')
      .default(sql`now()`)
      .notNull(),
    updatedAt: timestamp('updated_at')
      .default(sql`now()`)
      .notNull(),
  },
  (table) => ({
    formIdIndex: index('idx_form_fields_form').on(table.formId),
    stepIdIndex: index('idx_form_fields_step').on(table.stepId),
    fieldIdIndex: index('idx_form_fields_field').on(table.fieldId),
    // Composite index for efficient lookups
    formStepFieldIndex: index('idx_form_step_field').on(table.formId, table.stepId, table.fieldId),
  })
);

/**
 * Form templates table - stores reusable form templates
 */
export const formTemplatesTable = pgTable(
  'form_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id'), // Null for global templates
    name: text('name').notNull(),
    description: text('description'),
    steps: jsonb('steps').notNull(), // Template step definitions
    metadata: jsonb('metadata').default('{}').notNull(),
    createdAt: timestamp('created_at')
      .default(sql`now()`)
      .notNull(),
    updatedAt: timestamp('updated_at')
      .default(sql`now()`)
      .notNull(),
  },
  (table) => ({
    nameIndex: index('idx_form_templates_name').on(table.name),
    agentIdIndex: index('idx_form_templates_agent').on(table.agentId),
  })
);

/**
 * Relations
 */
export const formsRelations = relations(formsTable, ({ many }) => ({
  fields: many(formFieldsTable),
}));

export const formFieldsRelations = relations(formFieldsTable, ({ one }) => ({
  form: one(formsTable, {
    fields: [formFieldsTable.formId],
    references: [formsTable.id],
  }),
}));

/**
 * Export the complete schema
 */
export const formsSchema = {
  formsTable,
  formFieldsTable,
  formTemplatesTable,
  // Also include the original structure for compatibility
  tables: {
    forms: formsTable,
    formFields: formFieldsTable,
    formTemplates: formTemplatesTable,
  },
};

export default formsSchema;
