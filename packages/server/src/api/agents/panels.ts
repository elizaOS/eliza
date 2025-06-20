import type { IAgentRuntime, UUID } from '@elizaos/core';
import { validateUuid, logger } from '@elizaos/core';
import express from 'express';
import { sendError, sendSuccess } from '../shared/response-utils';

/**
 * Agent panels and plugin routes management
 */
export function createAgentPanelsRouter(agents: Map<UUID, IAgentRuntime>): express.Router {
  const router = express.Router();

  // Get Agent Panels (public GET routes)
  router.get('/:agentId/panels', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    try {
      const publicPanels = runtime.plugins
        .flatMap((plugin) => plugin.routes || [])
        .filter((route) => route.public === true && route.type === 'GET' && route.name)
        .map((route) => ({
          name: route.name,
          path: `/api${route.path.startsWith('/') ? route.path : `/${route.path}`}?agentId=${agentId}`,
        }));

      sendSuccess(res, publicPanels);
    } catch (error) {
      logger.error(`[AGENT PANELS] Error retrieving panels for agent ${agentId}:`, error);
      sendError(
        res,
        500,
        'PANEL_ERROR',
        'Error retrieving agent panels',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  return router;
}
