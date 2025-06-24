import type { IAgentRuntime, UUID } from '@elizaos/core';
import express from 'express';
import type { AgentServer } from '../../index';
import { createAgentCrudRouter } from './crud';
import { createAgentLifecycleRouter } from './lifecycle';
import { createAgentWorldsRouter } from './worlds';
import { createAgentPanelsRouter } from './panels';
import { createAgentLogsRouter } from './logs';
import { createAgentMemoryRouter } from '../memory/agents';
import { createRoomManagementRouter } from '../memory/rooms';

/**
 * Creates the agents router for agent lifecycle and management operations
 */
export function agentsRouter(
  agents: Map<UUID, IAgentRuntime>,
  serverInstance: AgentServer
): express.Router {
  const router = express.Router();

  // Mount CRUD operations at root level
  router.use('/', createAgentCrudRouter(agents, serverInstance));

  // Mount lifecycle operations
  router.use('/', createAgentLifecycleRouter(agents, serverInstance));

  // Mount world management operations
  router.use('/', createAgentWorldsRouter(agents));

  // Mount panels operations
  router.use('/', createAgentPanelsRouter(agents));

  // Mount logs operations
  router.use('/', createAgentLogsRouter(agents));

  // Mount memory operations
  router.use('/', createAgentMemoryRouter(agents));
  // Mount room management (list rooms and room details) under agents
  router.use('/', createRoomManagementRouter(agents));

  return router;
}
