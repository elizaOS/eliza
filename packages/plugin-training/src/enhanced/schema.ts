/**
 * Training Data Database Schema
 *
 * This file defines the database schema for storing training data using Drizzle ORM,
 * compatible with both PostgreSQL and PGLite (SQLite).
 */

import { sql } from 'drizzle-orm';
import { pgTable, text, integer, timestamp, jsonb, uuid, index, unique } from 'drizzle-orm/pg-core';

/**
 * Training data records table
 * Stores all training data collected from useModel calls
 */
export const trainingDataTable = pgTable(
  'training_data',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    agentId: uuid('agent_id').notNull(),
    sessionId: text('session_id').notNull(),
    modelType: text('model_type').notNull(),
    provider: text('provider'),

    // Input parameters (stored as JSONB for flexibility)
    inputParams: jsonb('input_params').notNull().default('{}'),

    // Output result
    output: jsonb('output'),

    // Execution metadata
    success: integer('success').notNull().default(0), // 0 = false, 1 = true (SQLite compatible)
    errorMessage: text('error_message'),
    executionTimeMs: integer('execution_time_ms'),

    // Context information
    roomId: uuid('room_id'),
    entityId: uuid('entity_id'),
    messageId: uuid('message_id'),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // Indexes for efficient querying
    agentIdIdx: index('training_data_agent_id_idx').on(table.agentId),
    sessionIdIdx: index('training_data_session_id_idx').on(table.sessionId),
    modelTypeIdx: index('training_data_model_type_idx').on(table.modelType),
    createdAtIdx: index('training_data_created_at_idx').on(table.createdAt),

    // Composite index for common queries
    agentSessionIdx: index('training_data_agent_session_idx').on(table.agentId, table.sessionId),

    // Unique constraint to prevent duplicates (optional)
    // uniqueRecord: unique('training_data_unique').on(table.agentId, table.sessionId, table.createdAt),
  })
);

/**
 * Training sessions table
 * Tracks training sessions with metadata
 */
export const trainingSessionsTable = pgTable(
  'training_sessions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    agentId: uuid('agent_id').notNull(),
    sessionId: text('session_id').notNull(),

    // Session metadata
    status: text('status').notNull().default('active'), // active, completed, failed
    description: text('description'),

    // Statistics
    totalRecords: integer('total_records').notNull().default(0),
    successfulRecords: integer('successful_records').notNull().default(0),
    failedRecords: integer('failed_records').notNull().default(0),

    // Timestamps
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // Indexes
    agentIdIdx: index('training_sessions_agent_id_idx').on(table.agentId),
    sessionIdIdx: index('training_sessions_session_id_idx').on(table.sessionId),
    statusIdx: index('training_sessions_status_idx').on(table.status),

    // Unique constraint
    uniqueSession: unique('training_sessions_unique').on(table.agentId, table.sessionId),
  })
);

/**
 * Export the complete schema for plugin registration
 */
export const trainingSchema = {
  trainingDataTable,
  trainingSessionsTable,
};

/**
 * Type definitions for TypeScript
 */
export type TrainingDataRecord = typeof trainingDataTable.$inferInsert;
export type TrainingDataSelect = typeof trainingDataTable.$inferSelect;
export type TrainingSession = typeof trainingSessionsTable.$inferInsert;
export type TrainingSessionSelect = typeof trainingSessionsTable.$inferSelect;
