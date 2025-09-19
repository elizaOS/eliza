import type { ElizaOS } from '@elizaos/core';
import express from 'express';
import type { AgentServer } from '../../index';
import { createAgentCrudRouter } from './crud';
import { createAgentLifecycleRouter } from './lifecycle';
import { createAgentWorldsRouter } from './worlds';
import { createAgentPanelsRouter } from './panels';
import { createAgentLogsRouter } from './logs';
import { createAgentRunsRouter } from './runs';
import { createAgentMemoryRouter } from '../memory/agents';
import { createRoomManagementRouter } from '../memory/rooms';

/**
 * Creates the agents router for agent lifecycle and management operations
 */
export function agentsRouter(
  elizaOS: ElizaOS,
  serverInstance: AgentServer
): express.Router {
  const router = express.Router();

  // Mount CRUD operations at root level
  router.use('/', createAgentCrudRouter(elizaOS, serverInstance));

  // Mount lifecycle operations
  router.use('/', createAgentLifecycleRouter(elizaOS, serverInstance));

  // Mount world management operations
  router.use('/', createAgentWorldsRouter(elizaOS));

  // Mount panels operations
  router.use('/', createAgentPanelsRouter(elizaOS));

  // Mount logs operations
  router.use('/', createAgentLogsRouter(elizaOS));

  // Mount runs operations
  router.use('/', createAgentRunsRouter(elizaOS));

  // Mount memory operations
  router.use('/', createAgentMemoryRouter(elizaOS));
  // Mount room management (list rooms and room details) under agents
  router.use('/', createRoomManagementRouter(elizaOS));

  return router;
}
