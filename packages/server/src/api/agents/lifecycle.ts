import type { ElizaOS } from '@elizaos/core';
import { validateUuid, logger } from '@elizaos/core';
import express from 'express';
import type { AgentServer } from '../../index';
import { sendError, sendSuccess } from '../shared/response-utils';

/**
 * Agent lifecycle operations (start, stop, status)
 */
export function createAgentLifecycleRouter(
  elizaOS: ElizaOS,
  serverInstance: AgentServer
): express.Router {
  const router = express.Router();
  const db = serverInstance.database;

  // Start an existing agent
  router.post('/:agentId/start', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }
    if (!db) {
      return sendError(res, 500, 'DB_ERROR', 'Database not available');
    }

    try {
      const agent = await db.getAgent(agentId);

      if (!agent) {
        logger.debug({ src: 'http', agentId }, 'Agent not found');
        return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      }

      const isActive = !!elizaOS.getAgent(agentId);

      if (isActive) {
        logger.debug({ src: 'http', agentId }, 'Agent is already running');
        return sendSuccess(res, {
          id: agentId,
          name: agent.name,
          status: 'active',
        });
      }

      // Use batch method even for single agent
      await serverInstance.startAgents([{ character: agent }]);

      const runtime = elizaOS.getAgent(agentId);
      if (!runtime) {
        throw new Error('Failed to start agent');
      }

      logger.debug({ src: 'http', agentId, agentName: agent.name }, 'Agent started');
      sendSuccess(res, {
        id: agentId,
        name: agent.name,
        status: 'active',
      });
    } catch (error) {
      logger.error(
        { src: 'http', agentId, error: error instanceof Error ? error.message : String(error) },
        'Error starting agent'
      );
      sendError(
        res,
        500,
        'START_ERROR',
        'Error starting agent',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Stop an existing agent
  router.post('/:agentId/stop', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      logger.debug({ src: 'http' }, 'Invalid agent ID format');
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const runtime = elizaOS.getAgent(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    await serverInstance?.unregisterAgent(agentId);

    logger.debug({ src: 'http', agentId, agentName: runtime.character.name }, 'Agent stopped');

    sendSuccess(res, {
      message: 'Agent stopped',
    });
  });

  return router;
}
