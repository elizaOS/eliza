import { sql } from 'drizzle-orm';
import { foreignKey, json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { entityTable } from './entity';
import { roomTable } from './room';
import { numberTimestamp } from './types';
import { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import type { Log, UUID } from '@elizaos/core';

/**
 * Definition of a table representing logs in the database.
 *
 * @type {Table}
 */
export const logTable = mysqlTable(
  'logs',
  {
    id: varchar('id', { length: 36 })
      .default(sql`(UUID())`)
      .notNull()
      .primaryKey(),
    createdAt: numberTimestamp('createdAt')
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    entityId: varchar('entityId', { length: 36 })
      .notNull()
      .references(() => entityTable.id),
    body: json('body').$type<{ [key: string]: unknown }>().notNull(),
    type: varchar('type', { length: 50 }).notNull(),
    roomId: varchar('roomId', { length: 36 })
      .notNull()
      .references(() => roomTable.id),
  },
  (table) => [
    foreignKey({
      name: 'fk_log_room',
      columns: [table.roomId],
      foreignColumns: [roomTable.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_logs_entityId',
      columns: [table.entityId],
      foreignColumns: [entityTable.id],
    }).onDelete('cascade'),
  ]
);

// Inferred database model types from the log table schema
export type SelectLog = InferSelectModel<typeof logTable>;
export type InsertLog = InferInsertModel<typeof logTable>;

/**
 * Maps a database log record to the Core Log type
 * @param logRow The database log record
 * @returns The Core Log type
 */
export function mapToLog(logRow: SelectLog): Log {
  return {
    id: logRow.id as UUID,
    entityId: logRow.entityId as UUID,
    roomId: logRow.roomId as UUID,
    body: typeof logRow.body === 'object' && logRow.body !== null ? logRow.body : {},
    type: logRow.type,
    createdAt: new Date(logRow.createdAt),
  };
}

/**
 * Maps a Core Log object to a database log record
 * @param log The Core Log object
 * @returns The database log record
 */
export function mapToLogRow(log: Partial<Log>): InsertLog {
  const result: Partial<InsertLog> = {};

  if (log.id !== undefined) result.id = log.id;
  if (log.entityId !== undefined) result.entityId = log.entityId;
  if (log.roomId !== undefined) result.roomId = log.roomId;
  if (log.body !== undefined) result.body = log.body;
  if (log.type !== undefined) result.type = log.type;
  if (log.createdAt !== undefined) result.createdAt = log.createdAt.getTime();

  return result as InsertLog;
}
