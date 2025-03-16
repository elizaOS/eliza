import { v4 as uuidv4 } from 'uuid';
import type { UUID, ChannelType } from '@elizaos/core';
import { logger } from '@elizaos/core';

/**
 * Interface representing a room mapping entry
 */
export interface RoomMappingEntry {
  conceptualRoomId: UUID;
  agentId: UUID;
  agentRoomId: UUID;
  createdAt: number;
}

/**
 * Class that manages mappings between conceptual rooms (as seen by users)
 * and agent-specific rooms (as they exist in each agent's context)
 */
export class RoomMappingService {
  // In-memory storage of room mappings
  private roomMappings: RoomMappingEntry[] = [];
  // Conceptual room registry
  private conceptualRooms: Map<UUID, { name: string; type: ChannelType; createdAt: number }> =
    new Map();

  constructor() {
    logger.info('[RoomMappingService] Initializing room mapping service');
  }

  /**
   * Creates a new conceptual room
   * @param name The name of the room
   * @param type The type of room (DM, GROUP, etc)
   * @returns The ID of the newly created conceptual room
   */
  async createConceptualRoom(name: string, type: ChannelType): Promise<UUID> {
    const roomId = uuidv4() as UUID;

    // Register the conceptual room
    this.conceptualRooms.set(roomId, {
      name,
      type,
      createdAt: Date.now(),
    });

    logger.info(`[RoomMappingService] Created conceptual room ${roomId} (${name}, ${type})`);

    return roomId;
  }

  /**
   * Gets a conceptual room's details
   * @param conceptualRoomId The ID of the conceptual room
   * @returns Room details or undefined if not found
   */
  async getConceptualRoom(conceptualRoomId: UUID) {
    return this.conceptualRooms.get(conceptualRoomId);
  }

  /**
   * Stores a mapping between a conceptual room and an agent-specific room
   * @param conceptualRoomId The ID of the conceptual room
   * @param agentId The ID of the agent
   * @param agentRoomId The ID of the agent-specific room
   */
  async storeRoomMapping(conceptualRoomId: UUID, agentId: UUID, agentRoomId: UUID): Promise<void> {
    // Check if mapping already exists
    const existingMapping = this.roomMappings.find(
      (mapping) => mapping.conceptualRoomId === conceptualRoomId && mapping.agentId === agentId
    );

    if (existingMapping) {
      // Update existing mapping
      existingMapping.agentRoomId = agentRoomId;
      logger.debug(
        `[RoomMappingService] Updated mapping for room ${conceptualRoomId} and agent ${agentId}`
      );
      return;
    }

    // Create new mapping
    this.roomMappings.push({
      conceptualRoomId,
      agentId,
      agentRoomId,
      createdAt: Date.now(),
    });

    logger.debug(
      `[RoomMappingService] Created mapping for room ${conceptualRoomId} and agent ${agentId}`
    );
  }

  /**
   * Gets the agent-specific room ID for a conceptual room
   * @param conceptualRoomId The ID of the conceptual room
   * @param agentId The ID of the agent
   * @returns The mapping entry or undefined if not found
   */
  async getRoomMapping(
    conceptualRoomId: UUID,
    agentId: UUID
  ): Promise<RoomMappingEntry | undefined> {
    return this.roomMappings.find(
      (mapping) => mapping.conceptualRoomId === conceptualRoomId && mapping.agentId === agentId
    );
  }

  /**
   * Gets all agent-specific room IDs for a conceptual room
   * @param conceptualRoomId The ID of the conceptual room
   * @returns Array of mapping entries
   */
  async getAllMappingsForRoom(conceptualRoomId: UUID): Promise<RoomMappingEntry[]> {
    return this.roomMappings.filter((mapping) => mapping.conceptualRoomId === conceptualRoomId);
  }

  /**
   * Gets all conceptual room mappings for an agent
   * @param agentId The ID of the agent
   * @returns Array of mapping entries
   */
  async getAllMappingsForAgent(agentId: UUID): Promise<RoomMappingEntry[]> {
    return this.roomMappings.filter((mapping) => mapping.agentId === agentId);
  }

  /**
   * Gets all agents that are part of a conceptual room
   * @param conceptualRoomId The ID of the conceptual room
   * @returns Array of agent IDs
   */
  async getAgentsInRoom(conceptualRoomId: UUID): Promise<UUID[]> {
    const mappings = await this.getAllMappingsForRoom(conceptualRoomId);
    return mappings.map((mapping) => mapping.agentId);
  }
}
