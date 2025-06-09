import type { IAgentRuntime, UUID } from '@elizaos/core';
import express from 'express';
import type { AgentServer } from '../../index';
import { createAgentMediaRouter } from './agents';
import { createChannelMediaRouter } from './channels';

/**
 * Creates the media router for file uploads and media handling
 */
export function mediaRouter(
  agents: Map<UUID, IAgentRuntime>,
  serverInstance: AgentServer
): express.Router {
  const router = express.Router();

  // Mount agent media uploads under /agents
  router.use('/agents', createAgentMediaRouter(agents, serverInstance));

  // Mount channel media uploads under /channels
  router.use('/channels', createChannelMediaRouter(serverInstance));

  return router;
}