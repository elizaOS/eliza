import { relations, sql } from 'drizzle-orm';
import { foreignKey, index, mysqlTable, text, unique, varchar } from 'drizzle-orm/mysql-core';
import { type UUID, type Participant } from '@elizaos/core';
import { agentTable } from './agent';
import { entityTable } from './entity';
import { roomTable } from './room';
import { numberTimestamp } from './types';
import { InferSelectModel, InferInsertModel } from 'drizzle-orm';

/**
 * Defines the schema for the "participants" table in the database.
 * Represents a user's participation in a room.
 */
export const participantTable = mysqlTable(
  'participants',
  {
    id: varchar('id', { length: 36 })
      .notNull()
      .primaryKey()
      .default(sql`(UUID())`),
    createdAt: numberTimestamp('createdAt')
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    entityId: varchar('entityId', { length: 36 }).references(() => entityTable.id, {
      onDelete: 'cascade',
    }),
    roomId: varchar('roomId', { length: 36 }).references(() => roomTable.id, {
      onDelete: 'cascade',
    }),
    agentId: varchar('agentId', { length: 36 }).references(() => agentTable.id, {
      onDelete: 'cascade',
    }),
    roomState: text('roomState'),
  },
  (table) => [
    // unique("participants_user_room_agent_unique").on(table.entityId, table.roomId, table.agentId),
    index('idx_participants_user').on(table.entityId),
    index('idx_participants_room').on(table.roomId),
    foreignKey({
      name: 'fk_participant_room',
      columns: [table.roomId],
      foreignColumns: [roomTable.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_participants_entityId',
      columns: [table.entityId],
      foreignColumns: [entityTable.id],
    }).onDelete('cascade'),
  ]
);

// Inferred database model types from the participant table schema
export type SelectParticipant = InferSelectModel<typeof participantTable>;
export type InsertParticipant = InferInsertModel<typeof participantTable>;

/**
 * Maps a Drizzle participant record to the core Participant interface
 */
export function mapToParticipant(participantRow: SelectParticipant, entity?: any): Participant {
  return {
    id: participantRow.id as UUID,
    entity: entity || { id: participantRow.entityId as UUID },
  };
}

/**
 * Maps a core Participant to a Drizzle participant record for database operations
 */
export function mapToParticipantRow(
  participant: Partial<Participant> & {
    roomId?: UUID;
    agentId?: UUID;
    roomState?: 'FOLLOWED' | 'MUTED' | null;
  }
): InsertParticipant {
  const result: Partial<InsertParticipant> = {};

  // Only copy properties that exist in the participant
  if (participant.id !== undefined) result.id = participant.id;
  if (participant.entity?.id !== undefined) result.entityId = participant.entity.id;
  if (participant.roomId !== undefined) result.roomId = participant.roomId;
  if (participant.agentId !== undefined) result.agentId = participant.agentId;
  if (participant.roomState !== undefined) result.roomState = participant.roomState;

  return result as InsertParticipant;
}
