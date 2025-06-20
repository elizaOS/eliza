import type { IAgentRuntime, UUID } from '@elizaos/core';
import express from 'express';
import type { AgentServer } from '../../index';
import { createMessagingCoreRouter } from './core';
import { createServersRouter } from './servers';
import { createChannelsRouter } from './channels';

/**
 * Creates the messaging router for all communication functionality
 */
export function messagingRouter(
  agents: Map<UUID, IAgentRuntime>,
  serverInstance: AgentServer
): express.Router {
  const router = express.Router();

  if (!serverInstance) {
    throw new Error('ServerInstance is required for messaging router');
  }

  // Mount core messaging functionality at root level
  router.use('/', createMessagingCoreRouter(serverInstance));

  // Mount server management functionality
  router.use('/', createServersRouter(serverInstance));

  // Mount channel management functionality
  router.use('/', createChannelsRouter(agents, serverInstance));

  return router;
}
