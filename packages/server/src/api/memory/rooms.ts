import type { ElizaOS, UUID } from '@elizaos/core';
import { validateUuid, logger, createUniqueUuid, ChannelType } from '@elizaos/core';
import express from 'express';
import { sendError, sendSuccess } from '../shared/response-utils';

interface CustomRequest extends express.Request {
  params: {
    agentId: string;
    roomId?: string;
  };
}

/**
 * Room management functionality for agents
 */
export function createRoomManagementRouter(elizaOS: ElizaOS): express.Router {
  const router = express.Router();

  // Create a new room for an agent
  router.post('/:agentId/rooms', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const runtime = elizaOS.getAgent(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    try {
      const { name, type = ChannelType.DM, source = 'client', worldId, metadata } = req.body;

      if (!name) {
        return sendError(res, 400, 'MISSING_PARAM', 'Room name is required');
      }

      const roomId = createUniqueUuid(runtime, `room-${Date.now()}`);
      const messageServerId = req.body.messageServerId;

      let resolvedWorldId = worldId;
      if (!resolvedWorldId) {
        const worldName = `World for ${name}`;
        resolvedWorldId = createUniqueUuid(runtime, `world-${Date.now()}`);

        await runtime.ensureWorldExists({
          id: resolvedWorldId,
          name: worldName,
          agentId: runtime.agentId,
          messageServerId: messageServerId as UUID,
          metadata,
        });
      }

      await runtime.ensureRoomExists({
        id: roomId,
        name,
        source,
        type,
        channelId: roomId,
        messageServerId: messageServerId as UUID,
        worldId: resolvedWorldId,
        metadata,
      });

      await runtime.addParticipant(runtime.agentId, roomId);
      await runtime.ensureParticipantInRoom(runtime.agentId, roomId);
      await runtime.setParticipantUserState(roomId, runtime.agentId, 'FOLLOWED');

      sendSuccess(
        res,
        {
          id: roomId,
          name,
          agentId,
          createdAt: Date.now(),
          source,
          type,
          worldId: resolvedWorldId,
          messageServerId,
          metadata,
        },
        201
      );
    } catch (error) {
      logger.error(
        {
          src: 'http',
          path: req.path,
          agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error creating room'
      );
      sendError(
        res,
        500,
        'CREATE_ERROR',
        'Failed to create room',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Get all rooms where an agent is a participant
  router.get('/:agentId/rooms', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const runtime = elizaOS.getAgent(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    try {
      // Optimized: 2 queries instead of N+1
      const participantRoomIds = await runtime.getRoomsForParticipant(agentId);
      const agentRooms =
        participantRoomIds.length > 0
          ? ((await runtime.getRoomsByIds(participantRoomIds)) ?? [])
          : [];

      sendSuccess(res, { rooms: agentRooms });
    } catch (error) {
      logger.error(
        {
          src: 'http',
          path: req.path,
          agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error retrieving rooms for agent'
      );
      sendError(
        res,
        500,
        'RETRIEVAL_ERROR',
        'Failed to retrieve agent rooms',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Get room details
  router.get('/:agentId/rooms/:roomId', async (req: CustomRequest, res: express.Response) => {
    const agentId = validateUuid(req.params.agentId);
    const roomId = validateUuid(req.params.roomId);

    if (!agentId || !roomId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID or room ID format');
    }

    // Get runtime
    const runtime = elizaOS.getAgent(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    try {
      const room = await runtime.getRoom(roomId);
      if (!room) {
        return sendError(res, 404, 'NOT_FOUND', 'Room not found');
      }

      // Enrich room data with world name
      let worldName: string | undefined;
      if (room.worldId) {
        const world = await runtime.getWorld(room.worldId);
        worldName = world?.name;
      }

      sendSuccess(res, {
        ...room,
        ...(worldName && { worldName }),
      });
    } catch (error) {
      logger.error(
        {
          src: 'http',
          path: req.path,
          agentId,
          roomId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error retrieving room details'
      );
      sendError(
        res,
        500,
        'RETRIEVAL_ERROR',
        'Failed to retrieve room details',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  return router;
}
