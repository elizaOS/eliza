import { ChannelType, type Room, RoomMetadata, type UUID } from '@elizaos/core';
import { and, eq, inArray } from 'drizzle-orm';
import { v4 } from 'uuid';
import { roomTable } from '../schema/index';
import type { DrizzleDatabase } from '../types';
import type { Store, StoreContext } from './types';

export class RoomStore implements Store {
  constructor(public readonly ctx: StoreContext) {}

  private get db(): DrizzleDatabase {
    return this.ctx.getDb();
  }

  async getByIds(roomIds: UUID[]): Promise<Room[] | null> {
    return this.ctx.withRetry(async () => {
      const result = await this.db
        .select({
          id: roomTable.id,
          name: roomTable.name,
          channelId: roomTable.channelId,
          agentId: roomTable.agentId,
          messageServerId: roomTable.messageServerId,
          worldId: roomTable.worldId,
          type: roomTable.type,
          source: roomTable.source,
          metadata: roomTable.metadata,
        })
        .from(roomTable)
        .where(and(inArray(roomTable.id, roomIds), eq(roomTable.agentId, this.ctx.agentId)));

      return result.map((room) => ({
        ...room,
        id: room.id as UUID,
        name: room.name ?? undefined,
        agentId: room.agentId as UUID,
        messageServerId: room.messageServerId as UUID,
        serverId: room.messageServerId as UUID,
        worldId: room.worldId as UUID,
        channelId: room.channelId as UUID,
        type: room.type as ChannelType,
        metadata: room.metadata as RoomMetadata,
      }));
    }, 'RoomStore.getByIds');
  }

  async getByWorld(worldId: UUID): Promise<Room[]> {
    return this.ctx.withRetry(async () => {
      const result = await this.db.select().from(roomTable).where(eq(roomTable.worldId, worldId));

      return result.map((room) => ({
        ...room,
        id: room.id as UUID,
        name: room.name ?? undefined,
        agentId: room.agentId as UUID,
        messageServerId: room.messageServerId as UUID,
        serverId: room.messageServerId as UUID,
        worldId: room.worldId as UUID,
        channelId: room.channelId as UUID,
        type: room.type as ChannelType,
        metadata: room.metadata as RoomMetadata,
      }));
    }, 'RoomStore.getByWorld');
  }

  async update(room: Room): Promise<void> {
    return this.ctx.withRetry(async () => {
      await this.db
        .update(roomTable)
        .set({ ...room, agentId: this.ctx.agentId })
        .where(eq(roomTable.id, room.id));
    }, 'RoomStore.update');
  }

  async create(rooms: Room[]): Promise<UUID[]> {
    return this.ctx.withRetry(async () => {
      const roomsWithIds = rooms.map((room) => ({
        ...room,
        agentId: this.ctx.agentId,
        id: room.id || v4(),
      }));

      await this.db.insert(roomTable).values(roomsWithIds).onConflictDoNothing();

      return roomsWithIds.map((r) => r.id as UUID);
    }, 'RoomStore.create');
  }

  async delete(roomId: UUID): Promise<void> {
    if (!roomId) throw new Error('Room ID is required');
    return this.ctx.withRetry(async () => {
      await this.db.transaction(async (tx) => {
        await tx.delete(roomTable).where(eq(roomTable.id, roomId));
      });
    }, 'RoomStore.delete');
  }

  async deleteByWorld(worldId: UUID): Promise<void> {
    return this.ctx.withRetry(async () => {
      await this.db.delete(roomTable).where(eq(roomTable.worldId, worldId));
    }, 'RoomStore.deleteByWorld');
  }
}
