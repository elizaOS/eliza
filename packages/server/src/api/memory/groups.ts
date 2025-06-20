import type { IAgentRuntime, Room, UUID } from '@elizaos/core';
import { validateUuid, logger, createUniqueUuid, ChannelType } from '@elizaos/core';
import express from 'express';
import type { AgentServer } from '../../index';
import { sendError, getRuntime } from '../shared';

/**
 * Group and world memory management functionality
 */
export function createGroupMemoryRouter(
  agents: Map<UUID, IAgentRuntime>,
  serverInstance: AgentServer
): express.Router {
  const router = express.Router();
  const db = serverInstance?.database;

  // Create group memory spaces for multiple agents
  router.post('/groups/:serverId', async (req, res) => {
    const serverId = validateUuid(req.params.serverId);
    const { name, worldId, source, metadata, agentIds = [] } = req.body;

    if (!Array.isArray(agentIds) || agentIds.length === 0) {
      return sendError(res, 400, 'BAD_REQUEST', 'agentIds must be a non-empty array');
    }

    let results: Room[] = [];
    let errors: {
      agentId: UUID;
      code: string;
      message: string;
      details: string;
    }[] = [];

    for (const agentId of agentIds) {
      try {
        const runtime = getRuntime(agents, agentId as UUID);
        const roomId = createUniqueUuid(runtime, serverId as string);
        const roomName = name || `Chat ${new Date().toLocaleString()}`;

        await runtime.ensureWorldExists({
          id: worldId,
          name: source,
          agentId: runtime.agentId,
          serverId: serverId as UUID,
        });

        await runtime.ensureRoomExists({
          id: roomId,
          name: roomName,
          source,
          type: ChannelType.API,
          worldId,
          serverId: serverId as UUID,
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
        logger.error(`[ROOM CREATE] Error creating room for agent ${agentId}:`, error);
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
  router.delete('/groups/:serverId', async (req, res) => {
    const worldId = validateUuid(req.params.serverId);
    if (!worldId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid serverId (worldId) format');
    }
    if (!db) {
      return sendError(res, 500, 'DB_ERROR', 'Database not available');
    }

    try {
      await db.deleteRoomsByWorldId(worldId);
      res.status(204).send();
    } catch (error) {
      logger.error('[GROUP DELETE] Error deleting group:', error);
      sendError(
        res,
        500,
        'DELETE_ERROR',
        'Error deleting group',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Clear group memories
  router.delete('/groups/:serverId/memories', async (req, res) => {
    const worldId = validateUuid(req.params.serverId);
    if (!worldId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid serverId (worldId) format');
    }
    if (!db) {
      return sendError(res, 500, 'DB_ERROR', 'Database not available');
    }

    try {
      const memories = await db.getMemoriesByWorldId({ worldId, tableName: 'messages' });
      const memoryIds = memories.map((memory) => memory.id as UUID);

      if (memoryIds.length > 0) {
        await (db as any).deleteManyMemories(memoryIds);
      }

      res.status(204).send();
    } catch (error) {
      logger.error('[GROUP MEMORIES DELETE] Error clearing memories:', error);
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
