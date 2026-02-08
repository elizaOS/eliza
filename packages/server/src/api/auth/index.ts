import express from 'express';
import { logger } from '@elizaos/core';
import type { AgentServer } from '../../index';
import { createAuthCredentialsRouter } from './credentials';

/**
 * Creates the auth router for authentication operations.
 *
 * Only mounts auth endpoints if ENABLE_DATA_ISOLATION=true.
 */
export function authRouter(serverInstance: AgentServer): express.Router {
  const router = express.Router();

  const dataIsolationEnabled = process.env.ENABLE_DATA_ISOLATION === 'true';

  if (!dataIsolationEnabled) {
    return router;
  }

  logger.info({ src: 'http' }, 'Auth endpoints mounted');

  router.use('/', createAuthCredentialsRouter(serverInstance));

  return router;
}
