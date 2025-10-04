import type { ElizaOS } from '@elizaos/core';
import express from 'express';
import type { AgentServer } from '../../index';
import { createAgentMemoryRouter } from './agents';
import { createGroupMemoryRouter } from './groups';
import { createRoomManagementRouter } from './rooms';

/**
 * Creates the memory router for memory and knowledge management
 */
export function memoryRouter(elizaOS: ElizaOS, serverInstance: AgentServer): express.Router {
  const router = express.Router();

  // Mount agent memory management at root level
  router.use('/', createAgentMemoryRouter(elizaOS));

  // Mount group memory management
  router.use('/', createGroupMemoryRouter(elizaOS, serverInstance));

  // Mount room management
  router.use('/', createRoomManagementRouter(elizaOS));

  return router;
}
