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
   * Create world from message server
   */
  async createWorldFromMessageServer(
    messageServerId: UUID,
    params: WorldCreateParams
  ): Promise<{ worldId: UUID }> {
    return this.post<{ worldId: UUID }>(`/api/memory/groups/${messageServerId}`, params);
  }

  /**
   * Delete a world
   */
  async deleteWorld(messageServerId: UUID): Promise<{ success: boolean }> {
    return this.delete<{ success: boolean }>(`/api/memory/groups/${messageServerId}`);
  }

  /**
   * Clear world memories
   */
  async clearWorldMemories(messageServerId: UUID): Promise<{ deleted: number }> {
    return this.delete<{ deleted: number }>(`/api/memory/groups/${messageServerId}/memories`);
  }

  /**
   * Delete a specific memory
   */
  async deleteMemory(agentId: UUID, memoryId: UUID): Promise<{ success: boolean }> {
    return this.delete<{ success: boolean }>(`/api/memory/${agentId}/memories/${memoryId}`);
  }

  /**
   * Get agent internal memories
   */
  async getAgentInternalMemories(
    agentId: UUID,
    agentPerspectiveRoomId: UUID,
    includeEmbedding?: boolean
  ): Promise<{ success: boolean; data: Memory[] }> {
    return this.get<{ success: boolean; data: Memory[] }>(
      `/api/memory/${agentId}/rooms/${agentPerspectiveRoomId}/memories`,
      { params: { includeEmbedding } }
    );
  }

  /**
   * Delete agent internal memory
   */
  async deleteAgentInternalMemory(agentId: UUID, memoryId: UUID): Promise<{ success: boolean }> {
    return this.delete<{ success: boolean }>(`/api/memory/${agentId}/memories/${memoryId}`);
  }

  /**
   * Delete all agent internal memories
   */
  async deleteAllAgentInternalMemories(
    agentId: UUID,
    agentPerspectiveRoomId: UUID
  ): Promise<{ success: boolean }> {
    return this.delete<{ success: boolean }>(
      `/api/memory/${agentId}/memories/all/${agentPerspectiveRoomId}`
    );
  }

  /**
   * Update agent internal memory
   */
  async updateAgentInternalMemory(
    agentId: UUID,
    memoryId: UUID,
    memoryData: MemoryUpdateParams
  ): Promise<Memory> {
    return this.patch<Memory>(`/api/memory/${agentId}/memories/${memoryId}`, memoryData);
  }

  /**
   * Delete group memory (implemented via messaging channel message deletion)
   */
  async deleteGroupMemory(messageServerId: UUID, memoryId: UUID): Promise<{ success: boolean }> {
    return this.delete<{ success: boolean }>(
      `/api/messaging/channels/${messageServerId}/messages/${memoryId}`
    );
  }

  /**
   * Clear group chat (implemented via messaging channel history clearing)
   */
  async clearGroupChat(messageServerId: UUID): Promise<{ success: boolean }> {
    return this.delete<{ success: boolean }>(`/api/messaging/channels/${messageServerId}/messages`);
  }
}
