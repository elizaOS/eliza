import type { IAgentRuntime, UUID } from '@elizaos/core';
import { logger } from '@elizaos/core';
import express from 'express';

/**
 * Creates an express Router for handling room-related routes.
 * Note: Current room endpoints are implemented in the agent router,
 * but this provides a separate file for future enhancements.
 *
 * @param agents - Map of UUID to agent runtime instances.
 * @returns An express Router for room routes.
 */
export function roomsRouter(agents: Map<UUID, IAgentRuntime>): express.Router {
  const router = express.Router();

  // Base route for rooms
  router.get('/', (req, res) => {
    logger.info(`[ROOMS] Base rooms route accessed`);
    res.json({
      message: 'Rooms API',
      note: 'Room endpoints are currently part of the agent router at /agents/:agentId/rooms',
    });
  });

  // This router will be used for future enhancements
  // Currently, room endpoints are implemented as part of the agent router
  // Example: GET /agents/:agentId/rooms

  return router;
}
