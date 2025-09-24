import type { ElizaOS } from '@elizaos/core';
import express from 'express';
import type { AgentServer } from '../../index';
import { createHealthRouter } from './health';
import { createLoggingRouter } from './logging';
import { createDebugRouter } from './debug';

/**
 * Creates the runtime router for system operations and health monitoring
 */
export function runtimeRouter(
  elizaOS: ElizaOS,
  serverInstance: AgentServer
): express.Router {
  const router = express.Router();

  // Mount health endpoints at root level
  router.use('/', createHealthRouter(elizaOS, serverInstance));

  // Mount logging endpoints
  router.use('/', createLoggingRouter());

  // Mount debug endpoints under /debug
  router.use('/debug', createDebugRouter(serverInstance));

  return router;
}
