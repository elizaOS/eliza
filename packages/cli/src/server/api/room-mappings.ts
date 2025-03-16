import type { Entity, IAgentRuntime, UUID } from '@elizaos/core';
import { ChannelType, createUniqueUuid, logger, validateUuid } from '@elizaos/core';
import express from 'express';
import { RoomMappingService } from '../services/RoomMappingService';

// Singleton instance of the room mapping service
const roomMappingService = new RoomMappingService();

/**
 * Creates an express Router for handling room mapping related routes.
 * These endpoints manage the mappings between conceptual rooms and agent-specific rooms.
 *
 * @param agents - Map of UUID to agent runtime instances.
 * @returns An express Router for room mapping routes.
 */
export function roomMappingsRouter(agents: Map<UUID, IAgentRuntime>): express.Router {
  const router = express.Router();

  /**
   * Helper function to ensure an entity exists in the agent's context
   */
  async function ensureEntityExists(
    agentId: UUID,
    entityId: UUID,
    name = 'User'
  ): Promise<boolean> {
    const runtime = agents.get(agentId);
    if (!runtime) return false;

    try {
      // Check if entity exists
      const entity = await runtime.getEntityById(entityId);
      if (entity) return true;

      // Create entity if it doesn't exist
      const newEntity: Entity = {
        id: entityId,
        names: [name],
        agentId: agentId,
      };

      await runtime.createEntity(newEntity);

      logger.info(`[RoomMappings] Created entity ${entityId} for agent ${agentId}`);
      return true;
    } catch (error) {
      logger.error(`[RoomMappings] Error ensuring entity exists: ${error.message}`);
      return false;
    }
  }

  // Get the agent-specific room ID for a conceptual room
  router.get('/mapping/:conceptualRoomId/:agentId', async (req, res) => {
    const conceptualRoomId = validateUuid(req.params.conceptualRoomId);
    const agentId = validateUuid(req.params.agentId);

    if (!conceptualRoomId || !agentId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid room ID or agent ID format',
        },
      });
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Agent not found',
        },
      });
    }

    try {
      // Check if mapping exists
      const mapping = await roomMappingService.getRoomMapping(conceptualRoomId, agentId);

      if (mapping) {
        return res.json({
          success: true,
          data: mapping,
        });
      }

      // If mapping doesn't exist, we need to create it
      // First check if the conceptual room exists
      const conceptualRoom = await roomMappingService.getConceptualRoom(conceptualRoomId);

      if (!conceptualRoom) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Conceptual room not found',
          },
        });
      }

      // Create a new room in the agent's context
      const agentRoomId = createUniqueUuid(runtime) as UUID;

      await runtime.ensureRoomExists({
        id: agentRoomId,
        name: conceptualRoom.name,
        type: conceptualRoom.type,
        source: 'api',
        worldId: null,
      });

      // Store the mapping
      await roomMappingService.storeRoomMapping(conceptualRoomId, agentId, agentRoomId);

      // Return the new mapping
      return res.json({
        success: true,
        data: {
          conceptualRoomId,
          agentId,
          agentRoomId,
          createdAt: Date.now(),
        },
      });
    } catch (error) {
      logger.error(`[RoomMappings] Error getting room mapping: ${error.message}`);
      return res.status(500).json({
        success: false,
        error: {
          code: 'SERVER_ERROR',
          message: 'Failed to get or create room mapping',
          details: error.message,
        },
      });
    }
  });

  // Get all room mappings for an agent
  router.get('/agent/:agentId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);

    if (!agentId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID format',
        },
      });
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Agent not found',
        },
      });
    }

    try {
      const mappings = await roomMappingService.getAllMappingsForAgent(agentId);

      return res.json({
        success: true,
        data: mappings,
      });
    } catch (error) {
      logger.error(`[RoomMappings] Error getting agent mappings: ${error.message}`);
      return res.status(500).json({
        success: false,
        error: {
          code: 'SERVER_ERROR',
          message: 'Failed to get agent room mappings',
          details: error.message,
        },
      });
    }
  });

  // Create a direct connection between two agents
  router.post('/direct-connection', async (req, res) => {
    const { agent1Id, agent2Id, roomName } = req.body;

    // Validate agent IDs
    const agent1Uuid = validateUuid(agent1Id);
    const agent2Uuid = validateUuid(agent2Id);

    if (!agent1Uuid || !agent2Uuid) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid agent ID format',
        },
      });
    }

    // Validate both agents exist
    const agent1Runtime = agents.get(agent1Uuid);
    const agent2Runtime = agents.get(agent2Uuid);

    if (!agent1Runtime || !agent2Runtime) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'One or both agents not found',
        },
      });
    }

    try {
      // Create a conceptual DM room
      const conceptualRoomId = await roomMappingService.createConceptualRoom(
        roomName || `DM between ${agent1Uuid} and ${agent2Uuid}`,
        ChannelType.DM
      );

      // Create agent-specific rooms
      const agent1RoomId = createUniqueUuid(agent1Runtime) as UUID;
      const agent2RoomId = createUniqueUuid(agent2Runtime) as UUID;

      // Ensure the rooms exist in each agent's context
      await agent1Runtime.ensureRoomExists({
        id: agent1RoomId,
        name: roomName || `Chat with ${agent2Runtime.character.name}`,
        type: ChannelType.DM,
        source: 'api',
        worldId: null,
      });

      await agent2Runtime.ensureRoomExists({
        id: agent2RoomId,
        name: roomName || `Chat with ${agent1Runtime.character.name}`,
        type: ChannelType.DM,
        source: 'api',
        worldId: null,
      });

      // Ensure each agent exists as an entity in the other agent's context
      await ensureEntityExists(agent1Uuid, agent2Uuid, agent2Runtime.character.name);

      await ensureEntityExists(agent2Uuid, agent1Uuid, agent1Runtime.character.name);

      // Add each agent as a participant in the other's room
      await agent1Runtime.addParticipant(agent2Uuid, agent1RoomId);
      await agent2Runtime.addParticipant(agent1Uuid, agent2RoomId);

      // Add each agent to its own room
      await agent1Runtime.addParticipant(agent1Uuid, agent1RoomId);
      await agent2Runtime.addParticipant(agent2Uuid, agent2RoomId);

      // Store the mappings
      await roomMappingService.storeRoomMapping(conceptualRoomId, agent1Uuid, agent1RoomId);

      await roomMappingService.storeRoomMapping(conceptualRoomId, agent2Uuid, agent2RoomId);

      return res.status(201).json({
        success: true,
        data: {
          conceptualRoomId,
          roomName: roomName || `DM between ${agent1Uuid} and ${agent2Uuid}`,
          agent1: {
            agentId: agent1Uuid,
            agentRoomId: agent1RoomId,
          },
          agent2: {
            agentId: agent2Uuid,
            agentRoomId: agent2RoomId,
          },
          createdAt: Date.now(),
        },
      });
    } catch (error) {
      logger.error(`[RoomMappings] Error creating direct connection: ${error.message}`);
      return res.status(500).json({
        success: false,
        error: {
          code: 'SERVER_ERROR',
          message: 'Failed to create direct connection',
          details: error.message,
        },
      });
    }
  });

  // Create a new conceptual room
  router.post('/conceptual-room', async (req, res) => {
    const { name, type } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Room name is required',
        },
      });
    }

    // Validate room type
    const roomType = type || ChannelType.GROUP;
    if (roomType !== ChannelType.DM && roomType !== ChannelType.GROUP) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ROOM_TYPE',
          message: 'Room type must be DM or GROUP',
        },
      });
    }

    try {
      const conceptualRoomId = await roomMappingService.createConceptualRoom(name, roomType);

      return res.status(201).json({
        success: true,
        data: {
          id: conceptualRoomId,
          name,
          type: roomType,
          createdAt: Date.now(),
        },
      });
    } catch (error) {
      logger.error(`[RoomMappings] Error creating conceptual room: ${error.message}`);
      return res.status(500).json({
        success: false,
        error: {
          code: 'SERVER_ERROR',
          message: 'Failed to create conceptual room',
          details: error.message,
        },
      });
    }
  });

  return router;
}
