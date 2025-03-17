import { validateUuid } from '@elizaos/core';
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
      const rooms = await db.getRooms(worldId);

      const roomDetails = await Promise.all(
        rooms.map(async (roomData) => {
          try {
            if (!roomData || !roomData.name) return null;

            if (worldId && roomData.worldId !== worldId) {
              return null;
            }

            const participantsIds = await db.getParticipantsForRoom(roomData.id);
            const participants = await Promise.all(
              participantsIds.map(async (agentId) => await db.getAgent(agentId))
            );

            return {
              id: roomData.id,
              name: roomData.name,
              source: roomData.source,
              worldId: roomData.worldId,
              participants: participants.filter(Boolean),
              agentId: roomData.agentId,
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

  return router;
}
