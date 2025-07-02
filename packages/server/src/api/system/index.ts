import express from 'express';
import { createEnvironmentRouter } from './environment';
import { createVersionRouter } from './version.js';

/**
 * Creates the system router for configuration and environment management
 */
export function systemRouter(): express.Router {
  const router = express.Router();

  // Mount environment management under /env
  router.use('/env', createEnvironmentRouter());

  // Mount version information under /version
  router.use('/version', createVersionRouter());

  return router;
}
