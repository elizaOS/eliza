import type { IAgentRuntime, UUID } from '@elizaos/core';
import express from 'express';
import type { AgentServer } from '../../index';
import { createEnvironmentRouter } from './environment';

/**
 * Creates the system router for configuration and environment management
 */
export function systemRouter(
  agents: Map<UUID, IAgentRuntime>,
  serverInstance?: AgentServer
): express.Router {
  const router = express.Router();

  // Mount environment management under /env
  router.use('/env', createEnvironmentRouter());

  return router;
}