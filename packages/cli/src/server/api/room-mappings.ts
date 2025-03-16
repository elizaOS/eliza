import type { Entity, IAgentRuntime, UUID } from '@elizaos/core';
import { ChannelType, createUniqueUuid, logger, validateUuid } from '@elizaos/core';
import express from 'express';
import { RoomMappingService } from '../services/RoomMappingService';
import { UserAgentService } from '../services/UserAgentService';

/**
 * Creates an express Router for handling room mapping related routes.
 * These endpoints manage the mappings between conceptual rooms and agent-specific rooms.
 *
 * @param agents - Map of UUID to agent runtime instances.
 * @param database - The application database.
 * @returns An express Router for room mapping routes.
 */
export function roomMappingsRouter(
  agents: Map<UUID, IAgentRuntime>,
  database: any
): express.Router {
  const router = express.Router();

  // Get singleton instances of services
  const roomMappingService = RoomMappingService.getInstance();
  const userAgentService = UserAgentService.getInstance(database);

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
    try {
      const { conceptualRoomId, agentId } = req.params;

      if (!conceptualRoomId || !agentId) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Conceptual room ID and agent ID are required',
          },
        });
      }

      // Get the mapping from the service
      const mapping = await roomMappingService.getRoomMapping(conceptualRoomId, agentId);

      if (!mapping) {
        return res.status(404).json({
          success: false,
          error: {
            message: 'Room mapping not found',
          },
        });
      }

      return res.json({
        success: true,
        data: mapping,
      });
    } catch (error) {
      console.error('[API] Error getting room mapping:', error);
      return res.status(500).json({
        success: false,
        error: {
          message: 'Failed to get room mapping',
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

  // Get all participants in a conceptual room across all agent contexts
  router.get('/participants/:conceptualRoomId', async (req, res) => {
    const conceptualRoomId = validateUuid(req.params.conceptualRoomId);

    if (!conceptualRoomId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'Invalid room ID format',
        },
      });
    }

    try {
      // Get all mappings for this conceptual room
      const mappings = await roomMappingService.getAllMappingsForRoom(conceptualRoomId);

      // Set to track unique participant IDs
      const participantIds = new Set<string>();

      // Get participants from each agent's room
      for (const mapping of mappings) {
        const runtime = agents.get(mapping.agentId);
        if (runtime) {
          const participants = await runtime.getParticipantsForRoom(mapping.agentRoomId);
          participants.forEach((id) => participantIds.add(id as string));
        }
      }

      return res.json({
        success: true,
        data: Array.from(participantIds),
      });
    } catch (error) {
      logger.error(`[RoomMappings] Error getting room participants: ${error.message}`);
      return res.status(500).json({
        success: false,
        error: {
          code: 'SERVER_ERROR',
          message: 'Failed to get room participants',
          details: error.message,
        },
      });
    }
  });

  // Create a direct connection between two agents
  router.post('/direct-connection', async (req, res) => {
    const { agent1Id, agent2Id, roomName, userId } = req.body;

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
      // Get or create a user agent
      let userAgentId: UUID;
      if (userId) {
        userAgentId = await userAgentService.getOrCreateUserAgent(userId, 'User');
      } else {
        // Use a default user ID if none provided (admin user)
        userAgentId = '10000000-0000-0000-0000-000000000000' as UUID;
      }

      // Create a conceptual DM room owned by the user
      const conceptualRoomId = await roomMappingService.createConceptualRoom(
        roomName ||
          `Chat between ${agent1Runtime.character.name} and ${agent2Runtime.character.name}`,
        ChannelType.DM,
        userAgentId
      );

      // Create agent-specific rooms using the enhanced method
      const agent1RoomId = await roomMappingService.createMirroredRoom(
        conceptualRoomId,
        agent1Uuid,
        agent1Runtime
      );

      const agent2RoomId = await roomMappingService.createMirroredRoom(
        conceptualRoomId,
        agent2Uuid,
        agent2Runtime
      );

      // Ensure each agent exists as an entity in the other agent's context
      await ensureEntityExists(agent1Uuid, agent2Uuid, agent2Runtime.character.name);
      await ensureEntityExists(agent2Uuid, agent1Uuid, agent1Runtime.character.name);

      // Add each agent as a participant in the other's room
      await agent1Runtime.addParticipant(agent2Uuid, agent1RoomId);
      await agent2Runtime.addParticipant(agent1Uuid, agent2RoomId);

      // Add each agent to its own room
      await agent1Runtime.addParticipant(agent1Uuid, agent1RoomId);
      await agent2Runtime.addParticipant(agent2Uuid, agent2RoomId);

      // Make sure user agent is added to both rooms
      await agent1Runtime.addParticipant(userAgentId, agent1RoomId);
      await agent2Runtime.addParticipant(userAgentId, agent2RoomId);

      return res.status(201).json({
        success: true,
        data: {
          conceptualRoomId,
          roomName:
            roomName ||
            `Chat between ${agent1Runtime.character.name} and ${agent2Runtime.character.name}`,
          userAgentId,
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

  // Create a conceptual room (now requires a user agent as owner)
  router.post('/conceptual-room', async (req, res) => {
    const { name, type, userAgentId, userId } = req.body;

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
      // Determine the user agent ID
      let ownerAgentId: UUID;

      if (userAgentId) {
        // Use provided user agent ID if given
        ownerAgentId = validateUuid(userAgentId) as UUID;
        if (!ownerAgentId) {
          return res.status(400).json({
            success: false,
            error: {
              code: 'INVALID_ID',
              message: 'Invalid user agent ID format',
            },
          });
        }
      } else if (userId) {
        // Or create a user agent from the user ID
        ownerAgentId = await userAgentService.getOrCreateUserAgent(userId, 'User');
      } else {
        // Default to admin user if neither is provided
        ownerAgentId = '10000000-0000-0000-0000-000000000000' as UUID;
      }

      // Create the conceptual room with the user agent as owner
      const conceptualRoomId = await roomMappingService.createConceptualRoom(
        name,
        roomType,
        ownerAgentId
      );

      return res.status(201).json({
        success: true,
        data: {
          id: conceptualRoomId,
          name,
          type: roomType,
          ownerAgentId,
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

  // Add an agent to a conceptual room
  router.post('/add-agent/:conceptualRoomId/:agentId', async (req, res) => {
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
      // Check if the conceptual room exists
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

      // Get all existing participants in the conceptual room
      const allAgentIds = await roomMappingService.getAgentsInRoom(conceptualRoomId);

      // Check if the agent is already in the room
      if (allAgentIds.includes(agentId)) {
        return res.json({
          success: true,
          data: {
            message: `Agent ${agentId} is already in room ${conceptualRoomId}`,
          },
        });
      }

      // Create a mirrored room for this agent
      const agentRoomId = await roomMappingService.createMirroredRoom(
        conceptualRoomId,
        agentId,
        runtime
      );

      // Ensure the room owner exists in the agent's context
      await ensureEntityExists(agentId, conceptualRoom.ownerAgentId, 'User');

      // Add the room owner to the agent's room
      await runtime.addParticipant(conceptualRoom.ownerAgentId, agentRoomId);
      await runtime.setParticipantUserState(agentRoomId, conceptualRoom.ownerAgentId, 'FOLLOWED');

      // Also add this agent to all other agents' rooms for this conceptual room
      for (const otherAgentId of allAgentIds) {
        const otherRuntime = agents.get(otherAgentId);
        if (otherRuntime) {
          // Get the room ID for this agent
          const mapping = await roomMappingService.getRoomMapping(conceptualRoomId, otherAgentId);
          if (mapping) {
            // Ensure this agent exists in the other agent's context
            await ensureEntityExists(otherAgentId, agentId, runtime.character.name);

            // Add this agent to the other agent's room
            await otherRuntime.addParticipant(agentId, mapping.agentRoomId);

            // And ensure other agent is in this agent's room
            await ensureEntityExists(agentId, otherAgentId, otherRuntime.character.name);
            await runtime.addParticipant(otherAgentId, agentRoomId);
          }
        }
      }

      return res.status(201).json({
        success: true,
        data: {
          conceptualRoomId,
          agentId,
          agentRoomId,
          message: `Agent ${agentId} added to room ${conceptualRoomId}`,
        },
      });
    } catch (error) {
      logger.error(`[RoomMappings] Error adding agent to room: ${error.message}`);
      return res.status(500).json({
        success: false,
        error: {
          code: 'SERVER_ERROR',
          message: 'Failed to add agent to room',
          details: error.message,
        },
      });
    }
  });

  return router;
}
