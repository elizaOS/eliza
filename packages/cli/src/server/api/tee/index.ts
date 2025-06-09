import type { IAgentRuntime, UUID } from '@elizaos/core';
import express from 'express';
import type { AgentServer } from '../../index';
import { createTeeRouter } from './tee';

/**
 * Creates the security router for TEE and security operations
 */
export function teeRouter(
  agents: Map<UUID, IAgentRuntime>,
  serverInstance: AgentServer
): express.Router {
  const router = express.Router();

  // Mount TEE functionality under /tee
  router.use('/tee', createTeeRouter(agents));

  return router;
}