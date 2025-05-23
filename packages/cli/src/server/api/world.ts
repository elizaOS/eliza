import { UUID, validateUuid } from '@elizaos/core';
import { logger } from '@elizaos/core';
import express from 'express';
import type { AgentServer } from '..';

/**
 * Creates an express Router for handling world-related routes.
 *
 * @param server - Optional AgentServer instance.
 * @returns An express Router for world routes.
 */
export function worldRouter(server?: AgentServer): express.Router {
  const router = express.Router();
  const db = server?.database;

  router.get('/:worldId/rooms', async (req, res) => {
    const worldId = validateUuid(req.params.worldId);
    try {
      const rooms = await db.getRoomsByWorld(worldId);

      const roomDetails = await Promise.all(
        rooms.map(async (roomData) => {
          try {
            if (!roomData || !roomData.name) return null;

            if (worldId && roomData.worldId !== worldId) {
              return null;
            }

            const character = await db.getAgent(roomData.agentId);

            return {
              id: roomData.id,
              name: roomData.name,
              source: roomData.source,
              worldId: roomData.worldId,
              character,
              agentId: roomData.agentId,
              metadata: roomData.metadata,
              serverId: roomData.serverId,
            };
          } catch (error) {
            logger.error(`[ROOMS GET] Error getting details for room ${roomData.id}:`, error);
            return null;
          }
        })
      );

      const validRooms = roomDetails.filter((room) => room !== null);

      res.json({
        success: true,
        data: validRooms,
      });
    } catch (error) {
      logger.error(`[ROOMS GET] Error retrieving rooms for agent`, error);
      res.status(500).json({
        success: false,
        error: {
          code: 'FETCH_ERROR',
          message: 'Failed to retrieve rooms',
          details: error.message,
        },
      });
    }
  });

  router.get('/:worldId/memories', async (req, res) => {
    try {
      const worldId = validateUuid(req.params.worldId);
      const memories = await db.getMemoriesByWorldId({ worldId, count: 50, tableName: 'messages' });

      res.json({
        success: true,
        data: memories,
      });
    } catch (error) {
      logger.error(`[ROOMS GET] Error retrieving memories`, error);
      res.status(500).json({
        success: false,
        error: {
          code: 'FETCH_ERROR',
          message: 'Failed to retrieve memories',
          details: error.message,
        },
      });
    }
  });

  return router;
}
