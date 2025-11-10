import express from 'express';
import type { AgentServer } from '../../index';
import { createAuthCredentialsRouter } from './credentials';

/**
 * Creates the auth router for authentication operations
 */
export function authRouter(serverInstance: AgentServer): express.Router {
  const router = express.Router();

  // Mount credentials-based auth (register/login)
  router.use('/', createAuthCredentialsRouter(serverInstance));

  return router;
}