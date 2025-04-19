import { sql } from 'drizzle-orm';
import { foreignKey, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { entityTable } from './entity';
import { numberTimestamp } from './types';

/**
 * Represents a PostgreSQL table for storing OpenTelemetry trace data.
 */
export const traceTable = pgTable(
  'traces',
  {
    id: uuid('id').defaultRandom().notNull(),
    traceId: uuid('traceId').notNull(),
    spanId: text('spanId').notNull(),
    parentSpanId: text('parentSpanId'),
    name: text('name').notNull(),
    startTime: numberTimestamp('startTime').notNull(),
    endTime: numberTimestamp('endTime').notNull(),
    attributes: jsonb('attributes').notNull().default({}),
    events: jsonb('events').notNull().default([]),
    status: jsonb('status').notNull().default({ code: 0 }),
    entityId: uuid('entityId')
      .notNull()
      .references(() => entityTable.id),
    createdAt: numberTimestamp('createdAt')
      .default(sql`now()`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'fk_entity',
      columns: [table.entityId],
      foreignColumns: [entityTable.id],
    }).onDelete('cascade'),
  ]
);
