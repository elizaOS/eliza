import type { ElizaOS, IAgentRuntime, UUID } from '@elizaos/core';
import { validateUuid, logger, createUniqueUuid } from '@elizaos/core';
import express from 'express';
import { sendError, sendSuccess } from '../shared/response-utils';

/**
 * Agent world management operations
 */
export function createAgentWorldsRouter(elizaOS: ElizaOS): express.Router {
  const router = express.Router();

  // Get all worlds
  router.get('/worlds', async (_req, res) => {
    try {
      const runtime = elizaOS.getAgents()[0];

      if (!runtime) {
        return sendError(res, 404, 'NOT_FOUND', 'No active agents found to get worlds');
      }
      const worlds = await runtime.getAllWorlds();
      sendSuccess(res, { worlds });
    } catch (error) {
      logger.error(
        {
          src: 'http',
          path: '/worlds',
          error: error instanceof Error ? error.message : String(error),
        },
        'Error retrieving worlds'
      );
      sendError(
        res,
        500,
        '500',
        'Error retrieving worlds',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Helper function to create a world
  const createWorldHelper = async (
    runtime: IAgentRuntime,
    req: express.Request,
    res: express.Response
  ) => {
    try {
      const { name, messageServerId, metadata } = req.body;

      if (!name) {
        return sendError(res, 400, 'BAD_REQUEST', 'World name is required');
      }

      const worldId = createUniqueUuid(runtime, `world-${Date.now()}`);

      await runtime.createWorld({
        id: worldId,
        name,
        agentId: runtime.agentId,
        messageServerId: (messageServerId as UUID) || undefined,
        metadata,
      });

      const world = (await runtime.getAllWorlds()).find((w) => w.id === worldId);

      sendSuccess(res, { world }, 201);
    } catch (error) {
      logger.error(
        {
          src: 'http',
          path: req.path,
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error creating world'
      );
      sendError(
        res,
        500,
        '500',
        'Error creating world',
        error instanceof Error ? error.message : String(error)
      );
    }
  };

  // Create new world for specific agent
  router.post('/:agentId/worlds', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const runtime = elizaOS.getAgent(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    await createWorldHelper(runtime, req, res);
  });

  // Update world properties
  router.patch('/:agentId/worlds/:worldId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    const worldId = validateUuid(req.params.worldId);

    if (!agentId || !worldId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID or world ID format');
    }

    const runtime = elizaOS.getAgent(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    try {
      const world = (await runtime.getAllWorlds()).find((w) => w.id === worldId);

      if (!world) {
        return sendError(res, 404, 'NOT_FOUND', 'World not found');
      }

      const { name, metadata } = req.body;

      const updatedWorld = {
        ...world,
        name: name !== undefined ? name : world.name,
        metadata:
          metadata !== undefined
            ? world.metadata
              ? { ...world.metadata, ...metadata }
              : metadata
            : world.metadata,
      };

      await runtime.updateWorld(updatedWorld);
      const refreshedWorld = (await runtime.getAllWorlds()).find((w) => w.id === worldId);
      sendSuccess(res, { world: refreshedWorld });
    } catch (error) {
      logger.error(
        {
          src: 'http',
          path: req.path,
          agentId,
          worldId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error updating world'
      );
      sendError(
        res,
        500,
        '500',
        'Error updating world',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  return router;
}
