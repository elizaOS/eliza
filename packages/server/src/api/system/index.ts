import express from 'express';
import { createEnvironmentRouter } from './environment';

/**
 * Creates the system router for configuration and environment management
 */
export function systemRouter(): express.Router {
  const router = express.Router();

  // Mount environment management under /env
  router.use('/env', createEnvironmentRouter());

  return router;
}
