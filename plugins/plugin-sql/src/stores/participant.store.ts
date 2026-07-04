/**
 * Store for the `participants` join table: room membership per entity,
 * scoped to the current agent, plus a per-(room, entity) follow/mute state
 * (`roomState`).
 */
import { ElizaError, type UUID } from "@elizaos/core";
import { and, eq, inArray } from "drizzle-orm";
import { participantTable, roomTable } from "../schema/index";
import type { DrizzleDatabase } from "../types";
import type { Store, StoreContext } from "./types";

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
    }, "ParticipantStore.getRoomsForEntity");
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
    }, "ParticipantStore.getRoomsForEntities");
  }

  async add(entityId: UUID, roomId: UUID): Promise<boolean> {
    return this.ctx.withRetry(async () => {
      try {
        const existing = await this.db
          .select({ id: participantTable.id })
          .from(participantTable)
          .where(
            and(
              eq(participantTable.entityId, entityId),
              eq(participantTable.roomId, roomId),
              eq(participantTable.agentId, this.ctx.agentId)
            )
          )
          .limit(1);
        if (existing.length === 0) {
          await this.db.insert(participantTable).values({
            entityId,
            roomId,
            agentId: this.ctx.agentId,
          });
        }
        return true;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — insert-if-absent only returns
        // true on success, so false here masked a real write failure.
        throw new ElizaError("ParticipantStore.add failed", {
          code: "DB_INSERT_FAILED",
          cause: error,
          context: { table: "participants", entityId, roomId, agentId: this.ctx.agentId },
        });
      }
    }, "ParticipantStore.add");
  }

  async addMany(entityIds: UUID[], roomId: UUID): Promise<boolean> {
    return this.ctx.withRetry(async () => {
      try {
        for (const id of entityIds) {
          const existing = await this.db
            .select({ id: participantTable.id })
            .from(participantTable)
            .where(
              and(
                eq(participantTable.entityId, id),
                eq(participantTable.roomId, roomId),
                eq(participantTable.agentId, this.ctx.agentId)
              )
            )
            .limit(1);
          if (existing.length === 0) {
            await this.db.insert(participantTable).values({
              entityId: id,
              roomId,
              agentId: this.ctx.agentId,
            });
          }
        }
        return true;
      } catch (error) {
        // error-policy:J2 context-adding rethrow — insert-if-absent only returns
        // true on success, so false here masked a real write failure.
        throw new ElizaError("ParticipantStore.addMany failed", {
          code: "DB_INSERT_FAILED",
          cause: error,
          context: {
            table: "participants",
            roomId,
            agentId: this.ctx.agentId,
            count: entityIds.length,
          },
        });
      }
    }, "ParticipantStore.addMany");
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
        // error-policy:J2 context-adding rethrow — false is the typed "no row
        // matched" signal; a delete failure must not collapse into it.
        throw new ElizaError("ParticipantStore.remove failed", {
          code: "DB_DELETE_FAILED",
          cause: error,
          context: { table: "participants", entityId, roomId },
        });
      }
    }, "ParticipantStore.remove");
  }

  async getForRoom(roomId: UUID): Promise<UUID[]> {
    return this.ctx.withRetry(async () => {
      const result = await this.db
        .select({ entityId: participantTable.entityId })
        .from(participantTable)
        .where(eq(participantTable.roomId, roomId));

      return result.map((row) => row.entityId as UUID);
    }, "ParticipantStore.getForRoom");
  }

  async isParticipant(roomId: UUID, entityId: UUID): Promise<boolean> {
    return this.ctx.withRetry(async () => {
      const result = await this.db
        .select()
        .from(participantTable)
        .where(and(eq(participantTable.roomId, roomId), eq(participantTable.entityId, entityId)))
        .limit(1);

      return result.length > 0;
    }, "ParticipantStore.isParticipant");
  }

  async getUserState(roomId: UUID, entityId: UUID): Promise<"FOLLOWED" | "MUTED" | null> {
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

      return (result[0]?.roomState as "FOLLOWED" | "MUTED" | null) ?? null;
    }, "ParticipantStore.getUserState");
  }

  async setUserState(
    roomId: UUID,
    entityId: UUID,
    state: "FOLLOWED" | "MUTED" | null
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
        // error-policy:J2 context-adding rethrow — attach the participant/state
        // context to the surfaced failure.
        throw new ElizaError("ParticipantStore.setUserState failed", {
          code: "DB_UPDATE_FAILED",
          cause: error,
          context: { table: "participants", roomId, entityId, state },
        });
      }
    }, "ParticipantStore.setUserState");
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
    }, "ParticipantStore.getByEntity");
  }
}
