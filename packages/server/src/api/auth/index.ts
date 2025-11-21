import express from 'express';
import { logger } from '@elizaos/core';
import type { AgentServer } from '../../index';
import { createAuthCredentialsRouter } from './credentials';

/**
 * Creates the auth router for authentication operations.
 *
 * Only mounts auth endpoints if ENABLE_DATA_ISOLATION=true.
 * In single-user mode (ENABLE_DATA_ISOLATION=false), auth is not needed.
 */
export function authRouter(serverInstance: AgentServer): express.Router {
  const router = express.Router();

  // Check if data isolation is enabled
  const dataIsolationEnabled = process.env.ENABLE_DATA_ISOLATION === 'true';

  if (!dataIsolationEnabled) {
    // ENABLE_DATA_ISOLATION=false → No auth endpoints needed
    logger.info('[Auth Router] Data isolation disabled - auth endpoints not mounted');
    return router; // Return empty router
  }

  logger.info('[Auth Router] Data isolation enabled - mounting auth endpoints');

  // Mount credentials-based auth (register/login/refresh/me)
  router.use('/', createAuthCredentialsRouter(serverInstance));

  return router;
}