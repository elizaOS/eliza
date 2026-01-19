import { logger, type UUID } from '@elizaos/core';
import { and, eq, inArray } from 'drizzle-orm';
import { participantTable, roomTable } from '../schema/index';
import type { DrizzleDatabase } from '../types';
import type { Store, StoreContext } from './types';

export class ParticipantStore implements Store {
  constructor(public readonly ctx: StoreContext) {}

  private get db(): DrizzleDatabase {
    return this.ctx.getDb();
  }

  async getRoomsForEntity(entityId: UUID): Promise<UUID[]> {
    return this.ctx.withRetry(async () => {
      const result = await this.db
        .select({ roomId: participantTable.roomId })
        .from(participantTable)
        .innerJoin(roomTable, eq(participantTable.roomId, roomTable.id))
        .where(
          and(eq(participantTable.entityId, entityId), eq(roomTable.agentId, this.ctx.agentId))
        );

      return result.map((row) => row.roomId as UUID);
    }, 'ParticipantStore.getRoomsForEntity');
  }

  async getRoomsForEntities(entityIds: UUID[]): Promise<UUID[]> {
    return this.ctx.withRetry(async () => {
      const result = await this.db
        .selectDistinct({ roomId: participantTable.roomId })
        .from(participantTable)
        .innerJoin(roomTable, eq(participantTable.roomId, roomTable.id))
        .where(
          and(
            inArray(participantTable.entityId, entityIds),
            eq(roomTable.agentId, this.ctx.agentId)
          )
        );

      return result.map((row) => row.roomId as UUID);
    }, 'ParticipantStore.getRoomsForEntities');
  }

  async add(entityId: UUID, roomId: UUID): Promise<boolean> {
    return this.ctx.withRetry(async () => {
      try {
        await this.db
          .insert(participantTable)
          .values({
            entityId,
            roomId,
            agentId: this.ctx.agentId,
          })
          .onConflictDoNothing();
        return true;
      } catch (error) {
        logger.error(
          {
            src: 'plugin:sql',
            entityId,
            roomId,
            agentId: this.ctx.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to add participant to room'
        );
        return false;
      }
    }, 'ParticipantStore.add');
  }

  async addMany(entityIds: UUID[], roomId: UUID): Promise<boolean> {
    return this.ctx.withRetry(async () => {
      try {
        const values = entityIds.map((id) => ({
          entityId: id,
          roomId,
          agentId: this.ctx.agentId,
        }));
        await this.db.insert(participantTable).values(values).onConflictDoNothing().execute();
        return true;
      } catch (error) {
        logger.error(
          {
            src: 'plugin:sql',
            roomId,
            agentId: this.ctx.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to add participants to room'
        );
        return false;
      }
    }, 'ParticipantStore.addMany');
  }

  async remove(entityId: UUID, roomId: UUID): Promise<boolean> {
    return this.ctx.withRetry(async () => {
      try {
        const result = await this.db.transaction(async (tx) => {
          return await tx
            .delete(participantTable)
            .where(
              and(eq(participantTable.entityId, entityId), eq(participantTable.roomId, roomId))
            )
            .returning();
        });
        return result.length > 0;
      } catch (error) {
        logger.error(
          {
            src: 'plugin:sql',
            entityId,
            roomId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to remove participant from room'
        );
        return false;
      }
    }, 'ParticipantStore.remove');
  }

  async getForRoom(roomId: UUID): Promise<UUID[]> {
    return this.ctx.withRetry(async () => {
      const result = await this.db
        .select({ entityId: participantTable.entityId })
        .from(participantTable)
        .where(eq(participantTable.roomId, roomId));

      return result.map((row) => row.entityId as UUID);
    }, 'ParticipantStore.getForRoom');
  }

  async isParticipant(roomId: UUID, entityId: UUID): Promise<boolean> {
    return this.ctx.withRetry(async () => {
      const result = await this.db
        .select()
        .from(participantTable)
        .where(and(eq(participantTable.roomId, roomId), eq(participantTable.entityId, entityId)))
        .limit(1);

      return result.length > 0;
    }, 'ParticipantStore.isParticipant');
  }

  async getUserState(roomId: UUID, entityId: UUID): Promise<'FOLLOWED' | 'MUTED' | null> {
    return this.ctx.withRetry(async () => {
      const result = await this.db
        .select({ roomState: participantTable.roomState })
        .from(participantTable)
        .where(
          and(
            eq(participantTable.roomId, roomId),
            eq(participantTable.entityId, entityId),
            eq(participantTable.agentId, this.ctx.agentId)
          )
        )
        .limit(1);

      return (result[0]?.roomState as 'FOLLOWED' | 'MUTED' | null) ?? null;
    }, 'ParticipantStore.getUserState');
  }

  async setUserState(
    roomId: UUID,
    entityId: UUID,
    state: 'FOLLOWED' | 'MUTED' | null
  ): Promise<void> {
    return this.ctx.withRetry(async () => {
      try {
        await this.db.transaction(async (tx) => {
          await tx
            .update(participantTable)
            .set({ roomState: state })
            .where(
              and(
                eq(participantTable.roomId, roomId),
                eq(participantTable.entityId, entityId),
                eq(participantTable.agentId, this.ctx.agentId)
              )
            );
        });
      } catch (error) {
        logger.error(
          {
            src: 'plugin:sql',
            roomId,
            entityId,
            state,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to set participant follow state'
        );
        throw error;
      }
    }, 'ParticipantStore.setUserState');
  }

  async getByEntity(entityId: UUID): Promise<Array<{ id: UUID; entityId: UUID; roomId: UUID }>> {
    return this.ctx.withRetry(async () => {
      const result = await this.db
        .select({
          id: participantTable.id,
          entityId: participantTable.entityId,
          roomId: participantTable.roomId,
        })
        .from(participantTable)
        .where(eq(participantTable.entityId, entityId));

      return result.map((row) => ({
        id: row.id as UUID,
        entityId: row.entityId as UUID,
        roomId: row.roomId as UUID,
      }));
    }, 'ParticipantStore.getByEntity');
  }
}
