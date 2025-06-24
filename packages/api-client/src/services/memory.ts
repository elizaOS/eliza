import { UUID } from '@elizaos/core';
import { BaseApiClient } from '../lib/base-client';
import {
  Memory,
  Room,
  MemoryParams,
  MemoryUpdateParams,
  RoomCreateParams,
  WorldCreateParams,
} from '../types/memory';

export class MemoryService extends BaseApiClient {
  /**
   * Get agent memories
   */
  async getAgentMemories(agentId: UUID, params?: MemoryParams): Promise<{ memories: Memory[] }> {
    return this.get<{ memories: Memory[] }>(`/api/memory/${agentId}/memories`, { params });
  }

  /**
   * Get room-specific memories
   */
  async getRoomMemories(
    agentId: UUID,
    roomId: UUID,
    params?: MemoryParams
  ): Promise<{ memories: Memory[] }> {
    return this.get<{ memories: Memory[] }>(`/api/memory/${agentId}/rooms/${roomId}/memories`, {
      params,
    });
  }

  /**
   * Update a memory
   */
  async updateMemory(agentId: UUID, memoryId: UUID, params: MemoryUpdateParams): Promise<Memory> {
    return this.patch<Memory>(`/api/memory/${agentId}/memories/${memoryId}`, params);
  }

  /**
   * Clear all agent memories
   */
  async clearAgentMemories(agentId: UUID): Promise<{ deleted: number }> {
    return this.delete<{ deleted: number }>(`/api/memory/${agentId}/memories`);
  }

  /**
   * Clear room memories
   */
  async clearRoomMemories(agentId: UUID, roomId: UUID): Promise<{ deleted: number }> {
    return this.delete<{ deleted: number }>(`/api/memory/${agentId}/memories/all/${roomId}`);
  }

  /**
   * List agent's rooms
   */
  async listAgentRooms(agentId: UUID): Promise<{ rooms: Room[] }> {
    return this.get<{ rooms: Room[] }>(`/api/memory/${agentId}/rooms`);
  }

  /**
   * Get room details
   */
  async getRoom(agentId: UUID, roomId: UUID): Promise<Room> {
    return this.get<Room>(`/api/memory/${agentId}/rooms/${roomId}`);
  }

  /**
   * Create a room
   */
  async createRoom(agentId: UUID, params: RoomCreateParams): Promise<Room> {
    return this.post<Room>(`/api/memory/${agentId}/rooms`, params);
  }

  /**
   * Create world from server
   */
  async createWorldFromServer(
    serverId: UUID,
    params: WorldCreateParams
  ): Promise<{ worldId: UUID }> {
    return this.post<{ worldId: UUID }>(`/api/memory/groups/${serverId}`, params);
  }

  /**
   * Delete a world
   */
  async deleteWorld(serverId: UUID): Promise<{ success: boolean }> {
    return this.delete<{ success: boolean }>(`/api/memory/groups/${serverId}`);
  }

  /**
   * Clear world memories
   */
  async clearWorldMemories(serverId: UUID): Promise<{ deleted: number }> {
    return this.delete<{ deleted: number }>(`/api/memory/groups/${serverId}/memories`);
  }
}
