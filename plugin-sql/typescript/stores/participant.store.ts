import { sql, inArray } from 'drizzle-orm';
import { participantTable } from '../tables';
import type { UUID, Participant } from '@elizaos/core';
import type { DrizzleDatabase } from '../types';

// Define the RoomState interface with its specific properties
interface RoomState {
  status?: string;
  lastActiveAt?: number;
  attributes?: Record<string, unknown>;
  preferences?: {
    notifications?: boolean;
    theme?: string;
    [key: string]: unknown;
  };
  metadata?: Record<string, unknown>;
}

/**
 * Retrieves participants by their IDs.
 */
export async function getParticipantsByIds(
  db: DrizzleDatabase,
  participantIds: UUID[]
): Promise<Participant[]> {
  if (participantIds.length === 0) return [];

  const result = await db
    .select({
      id: participantTable.id,
      name: participantTable.name,
      roomState: sql`(${participantTable.roomState}::jsonb #>> '{}')::jsonb`,
    })
    .from(participantTable)
    .where(inArray(participantTable.id, participantIds));

  return result.map((participant) => ({
    id: participant.id,
    name: participant.name,
    roomState: participant.roomState as RoomState,
  }));
}
