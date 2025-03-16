import express from 'express';
import { validateUuid, logger, createUniqueUuid, ChannelType } from '@elizaos/core';
import type { UUID, IAgentRuntime } from '@elizaos/core';
import { RoomMappingService } from '../services/RoomMappingService';

export function roomMappingRouter(
  agents: Map<UUID, IAgentRuntime>,
  roomMappingService: RoomMappingService
): express.Router {
  const router = express.Router();

  // Get agent-specific room ID for a conceptual room
  router.get('/:agentId/rooms/:roomId/mapping', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    const conceptualRoomId = validateUuid(req.params.roomId);

    if (!agentId || !conceptualRoomId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_ID', message: 'Invalid agent ID or room ID format' },
      });
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Agent not found' },
      });
    }

    try {
      // Get the mapping
      const mapping = await roomMappingService.getRoomMapping(conceptualRoomId, agentId);

      if (mapping) {
        // Mapping exists
        return res.json({
          success: true,
          data: { agentRoomId: mapping.agentRoomId },
        });
      }

      // No mapping exists, create one
      const roomName = (req.query.roomName as string) || `Room-${conceptualRoomId}`;
      const roomType = (req.query.roomType as ChannelType) || ChannelType.GROUP;

      // Create a unique room ID for this agent
      const agentRoomId = createUniqueUuid(runtime, `room-${conceptualRoomId}`);

      // Create the room in agent's context
      await runtime.ensureRoomExists({
        id: agentRoomId,
        name: roomName,
        source: 'websocket',
        type: roomType,
      });

      // Store the mapping
      await roomMappingService.storeRoomMapping(conceptualRoomId, agentId, agentRoomId);

      res.json({
        success: true,
        data: { agentRoomId },
      });
    } catch (error) {
      logger.error(`[API] Error getting/creating room mapping: ${error.message}`);
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error.message },
      });
    }
  });

  // Get all room mappings for an agent
  router.get('/:agentId/room-mappings', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);

    if (!agentId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_ID', message: 'Invalid agent ID format' },
      });
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Agent not found' },
      });
    }

    try {
      // Get all mappings for this agent
      const mappings = await roomMappingService.getAllMappingsForAgent(agentId);

      res.json({
        success: true,
        data: mappings,
      });
    } catch (error) {
      logger.error(`[API] Error getting room mappings: ${error.message}`);
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error.message },
      });
    }
  });

  // Create a direct connection between two agents
  router.post('/:agentId/connect/:targetAgentId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    const targetAgentId = validateUuid(req.params.targetAgentId);

    if (!agentId || !targetAgentId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_ID', message: 'Invalid agent ID format' },
      });
    }

    const agentRuntime = agents.get(agentId);
    const targetAgentRuntime = agents.get(targetAgentId);

    if (!agentRuntime || !targetAgentRuntime) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'One or both agents not found' },
      });
    }

    try {
      // Create a conceptual DM room between the agents
      const conceptualRoomId = await roomMappingService.createConceptualRoom(
        `DM-${agentId}-${targetAgentId}`,
        ChannelType.DM
      );

      // Create agent-specific rooms for each agent
      const agentRoomId = createUniqueUuid(agentRuntime, `room-${conceptualRoomId}`);
      const targetAgentRoomId = createUniqueUuid(targetAgentRuntime, `room-${conceptualRoomId}`);

      // Create rooms in each agent's context
      await agentRuntime.ensureRoomExists({
        id: agentRoomId,
        name: `Chat with ${targetAgentRuntime.character.name}`,
        source: 'websocket',
        type: ChannelType.DM,
      });

      await targetAgentRuntime.ensureRoomExists({
        id: targetAgentRoomId,
        name: `Chat with ${agentRuntime.character.name}`,
        source: 'websocket',
        type: ChannelType.DM,
      });

      // Ensure each agent knows about the other
      await ensureEntityExists(agentRuntime, targetAgentId, targetAgentRuntime.character.name);
      await ensureEntityExists(targetAgentRuntime, agentId, agentRuntime.character.name);

      // Add participants to rooms
      await agentRuntime.addParticipant(targetAgentId, agentRoomId);
      await targetAgentRuntime.addParticipant(agentId, targetAgentRoomId);

      // Store mappings
      await roomMappingService.storeRoomMapping(conceptualRoomId, agentId, agentRoomId);
      await roomMappingService.storeRoomMapping(conceptualRoomId, targetAgentId, targetAgentRoomId);

      res.json({
        success: true,
        data: {
          conceptualRoomId,
          agentRoomId,
          targetAgentRoomId,
        },
      });
    } catch (error) {
      logger.error(`[API] Error connecting agents: ${error.message}`);
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error.message },
      });
    }
  });

  return router;
}

// Helper to ensure entity exists in agent's context
async function ensureEntityExists(
  agentRuntime: IAgentRuntime,
  entityId: UUID,
  entityName: string
): Promise<void> {
  try {
    // Check if entity already exists
    await agentRuntime.getEntityById(entityId);
  } catch (error) {
    // Entity doesn't exist, create it
    logger.debug(`[API] Creating entity ${entityId} for agent ${agentRuntime.agentId}`);

    await agentRuntime.createEntity({
      id: entityId,
      name: entityName,
      agentId: agentRuntime.agentId,
      metadata: {
        websocket: {
          username: entityName,
          name: entityName,
        },
      },
    });
  }
}
