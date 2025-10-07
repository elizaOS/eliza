import express from 'express';
// import { createTeeRouter } from './tee';

/**
 * Creates the security router for TEE and security operations
 */
export function teeRouter(): express.Router {
  const router = express.Router();

  // Mount TEE functionality at root level
  // router.use('/', createTeeRouter(agents));

  return router;
}
