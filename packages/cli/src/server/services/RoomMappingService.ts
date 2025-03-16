import { v4 as uuidv4 } from 'uuid';
import type { UUID, ChannelType, IAgentRuntime } from '@elizaos/core';
import { logger, createUniqueUuid } from '@elizaos/core';

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
  private static instance: RoomMappingService | null = null;
  // In-memory storage of room mappings
  private roomMappings: RoomMappingEntry[] = [];
  // Conceptual room registry
  private conceptualRooms: Map<
    UUID,
    {
      name: string;
      type: ChannelType;
      createdAt: number;
      ownerAgentId: UUID; // The user agent that created/owns this room
    }
  > = new Map();

  private constructor() {
    logger.info('[RoomMappingService] Initializing room mapping service');
  }

  /**
   * Get the singleton instance of RoomMappingService
   */
  public static getInstance(): RoomMappingService {
    if (!RoomMappingService.instance) {
      RoomMappingService.instance = new RoomMappingService();
    }
    return RoomMappingService.instance;
  }

  /**
   * Creates a new conceptual room
   * @param name The name of the room
   * @param type The type of room (DM, GROUP, etc)
   * @param ownerAgentId The user agent ID that owns this room
   * @returns The ID of the newly created conceptual room
   */
  async createConceptualRoom(name: string, type: ChannelType, ownerAgentId: UUID): Promise<UUID> {
    const roomId = uuidv4() as UUID;

    // Register the conceptual room
    this.conceptualRooms.set(roomId, {
      name,
      type,
      createdAt: Date.now(),
      ownerAgentId,
    });

    logger.info(
      `[RoomMappingService] Created conceptual room ${roomId} (${name}, ${type}, owned by ${ownerAgentId})`
    );

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

  /**
   * Creates a new mirrored room in an agent's context for a conceptual room
   * @param conceptualRoomId The ID of the conceptual room
   * @param targetAgentId The ID of the agent to create a room for
   * @param agentRuntime The runtime for the agent
   * @returns The ID of the newly created agent-specific room
   */
  async createMirroredRoom(
    conceptualRoomId: UUID,
    targetAgentId: UUID,
    agentRuntime: IAgentRuntime
  ): Promise<UUID> {
    // Get the conceptual room details
    const conceptualRoom = await this.getConceptualRoom(conceptualRoomId);
    if (!conceptualRoom) {
      throw new Error(`Conceptual room ${conceptualRoomId} not found`);
    }

    // Create a unique room ID for this agent
    const agentRoomId = createUniqueUuid(agentRuntime, `room-${conceptualRoomId}`) as UUID;

    // Ensure the room exists in the agent's context
    await agentRuntime.ensureRoomExists({
      id: agentRoomId,
      name: conceptualRoom.name,
      type: conceptualRoom.type,
      source: 'mirrored',
      worldId: null,
      metadata: {
        conceptualRoomId, // Store the conceptual room ID for reference
        ownerAgentId: conceptualRoom.ownerAgentId,
      },
    });

    // Store the mapping
    await this.storeRoomMapping(conceptualRoomId, targetAgentId, agentRoomId);

    logger.info(
      `[RoomMappingService] Created mirrored room ${agentRoomId} for agent ${targetAgentId} (conceptual room: ${conceptualRoomId})`
    );

    return agentRoomId;
  }

  /**
   * Gets the conceptual room ID for an agent-specific room
   * @param agentRoomId The ID of the agent-specific room
   * @param agentId The ID of the agent
   * @returns The conceptual room ID or undefined if not found
   */
  async getConceptualRoomId(agentRoomId: UUID, agentId: UUID): Promise<UUID | undefined> {
    const mapping = this.roomMappings.find(
      (mapping) => mapping.agentRoomId === agentRoomId && mapping.agentId === agentId
    );
    return mapping?.conceptualRoomId;
  }

  /**
   * Gets all mirrored rooms for a conceptual room
   * @param conceptualRoomId The ID of the conceptual room
   * @returns Map of agent IDs to their room IDs for this conceptual room
   */
  async getMirroredRooms(conceptualRoomId: UUID): Promise<Map<UUID, UUID>> {
    const mappings = await this.getAllMappingsForRoom(conceptualRoomId);
    const mirroredRooms = new Map<UUID, UUID>();

    for (const mapping of mappings) {
      mirroredRooms.set(mapping.agentId, mapping.agentRoomId);
    }

    return mirroredRooms;
  }

  /**
   * Add a participant to all mirrored rooms for a conceptual room
   * @param conceptualRoomId The ID of the conceptual room
   * @param participantId The ID of the participant to add
   * @param agentRuntimes Map of agent IDs to their runtimes
   */
  async addParticipantToMirroredRooms(
    conceptualRoomId: UUID,
    participantId: UUID,
    agentRuntimes: Map<UUID, IAgentRuntime>
  ): Promise<void> {
    const mirroredRooms = await this.getMirroredRooms(conceptualRoomId);

    for (const [agentId, agentRoomId] of mirroredRooms.entries()) {
      const runtime = agentRuntimes.get(agentId);
      if (runtime) {
        // Ensure the participant entity exists in this agent's context
        try {
          await runtime.getEntityById(participantId);
        } catch (error) {
          // Create a basic entity if it doesn't exist
          await runtime.createEntity({
            id: participantId,
            names: ['User'],
            agentId: runtime.agentId,
          });
        }

        // Add the participant to the room
        await runtime.addParticipant(participantId, agentRoomId);
        await runtime.setParticipantUserState(agentRoomId, participantId, 'FOLLOWED');

        logger.info(
          `[RoomMappingService] Added participant ${participantId} to mirrored room ${agentRoomId} for agent ${agentId}`
        );
      }
    }
  }

  /**
   * Remove a participant from all mirrored rooms for a conceptual room
   * @param conceptualRoomId The ID of the conceptual room
   * @param participantId The ID of the participant to remove
   * @param agentRuntimes Map of agent IDs to their runtimes
   */
  async removeParticipantFromMirroredRooms(
    conceptualRoomId: UUID,
    participantId: UUID,
    agentRuntimes: Map<UUID, IAgentRuntime>
  ): Promise<void> {
    const mirroredRooms = await this.getMirroredRooms(conceptualRoomId);

    for (const [agentId, agentRoomId] of mirroredRooms.entries()) {
      const runtime = agentRuntimes.get(agentId);
      if (runtime) {
        await runtime.removeParticipant(participantId, agentRoomId);

        logger.info(
          `[RoomMappingService] Removed participant ${participantId} from mirrored room ${agentRoomId} for agent ${agentId}`
        );
      }
    }
  }
}
