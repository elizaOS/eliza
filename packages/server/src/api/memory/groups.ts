import type { ElizaOS, Room, UUID } from '@elizaos/core';
import { validateUuid, logger, createUniqueUuid, ChannelType } from '@elizaos/core';
import express from 'express';
import type { AgentServer } from '../../index';
import { sendError, getRuntime } from '../shared';

/**
 * Group and world memory management functionality
 */
export function createGroupMemoryRouter(
  elizaOS: ElizaOS,
  serverInstance: AgentServer
): express.Router {
  const router = express.Router();
  const db = serverInstance?.database;

  // Create group memory spaces for multiple agents
  router.post('/groups/:messageServerId', async (req, res) => {
    const messageServerId = validateUuid(req.params.messageServerId);
    const { name, worldId, source, metadata, agentIds = [] } = req.body;

    if (!Array.isArray(agentIds) || agentIds.length === 0) {
      return sendError(res, 400, 'BAD_REQUEST', 'agentIds must be a non-empty array');
    }

    const results: Room[] = [];
    const errors: {
      agentId: UUID;
      code: string;
      message: string;
      details: string;
    }[] = [];

    for (const agentId of agentIds) {
      try {
        const runtime = getRuntime(elizaOS, agentId as UUID);
        const roomId = createUniqueUuid(runtime, messageServerId as string);
        const roomName = name || `Chat ${new Date().toLocaleString()}`;

        await runtime.ensureWorldExists({
          id: worldId,
          name: source,
          agentId: runtime.agentId,
          messageServerId: messageServerId as UUID,
        });

        await runtime.ensureRoomExists({
          id: roomId,
          name: roomName,
          source,
          type: ChannelType.API,
          worldId,
          messageServerId: messageServerId as UUID,
          metadata,
          channelId: roomId,
        });

        await runtime.addParticipant(runtime.agentId, roomId);
        await runtime.ensureParticipantInRoom(runtime.agentId, roomId);
        await runtime.setParticipantUserState(roomId, runtime.agentId, 'FOLLOWED');

        results.push({
          id: roomId,
          name: roomName,
          source: 'client',
          worldId,
          type: ChannelType.API,
        });
      } catch (error) {
        logger.error(
          {
            src: 'http',
            path: req.path,
            agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Error creating room for agent'
        );
        errors.push({
          agentId,
          code:
            error instanceof Error && error.message === 'Agent not found'
              ? 'NOT_FOUND'
              : 'CREATE_ERROR',
          message:
            error instanceof Error && error.message === 'Agent not found'
              ? error.message
              : 'Failed to Create group',
          details: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (results.length === 0 && errors.length > 0) {
      res.status(500).json({
        success: false,
        error: errors.length
          ? errors
          : [{ code: 'UNKNOWN_ERROR', message: 'No rooms were created' }],
      });
      return;
    }

    res.status(errors.length ? 207 : 201).json({
      success: errors.length === 0,
      data: results,
      errors: errors.length ? errors : undefined,
    });
  });

  // Delete group
  router.delete('/groups/:messageServerId', async (req, res) => {
    const worldId = validateUuid(req.params.messageServerId);
    if (!worldId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid messageServerId (worldId) format');
    }
    if (!db) {
      return sendError(res, 500, 'DB_ERROR', 'Database not available');
    }

    try {
      await db.deleteRoomsByWorldId(worldId);
      res.status(204).send();
    } catch (error) {
      logger.error(
        {
          src: 'http',
          path: req.path,
          worldId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error deleting group'
      );
      sendError(
        res,
        500,
        'DELETE_ERROR',
        'Error deleting message server',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Clear group memories
  router.delete('/groups/:messageServerId/memories', async (req, res) => {
    const worldId = validateUuid(req.params.messageServerId);
    if (!worldId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid messageServerId (worldId) format');
    }
    if (!db) {
      return sendError(res, 500, 'DB_ERROR', 'Database not available');
    }

    try {
      const memories = await db.getMemoriesByWorldId({ worldId, tableName: 'messages' });
      const memoryIds = memories.map((memory) => memory.id as UUID);

      if (memoryIds.length > 0) {
        await db.deleteManyMemories(memoryIds);
      }

      res.status(204).send();
    } catch (error) {
      logger.error(
        {
          src: 'http',
          path: req.path,
          worldId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error clearing group memories'
      );
      sendError(
        res,
        500,
        'DELETE_ERROR',
        'Error deleting group memories',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  return router;
}
