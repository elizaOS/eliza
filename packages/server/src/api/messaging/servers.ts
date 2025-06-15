import { logger, validateUuid, type UUID } from '@elizaos/core';
import express from 'express';
import internalMessageBus from '../../bus';
import type { AgentServer } from '../../index';

const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000' as UUID;

/**
 * Server management functionality
 */
export function createServersRouter(serverInstance: AgentServer): express.Router {
  const router = express.Router();

  // GET /central-servers
  (router as any).get('/central-servers', async (_req: express.Request, res: express.Response) => {
    try {
      const servers = await serverInstance.getServers();
      res.json({ success: true, data: { servers } });
    } catch (error) {
      logger.error('[Messages Router /central-servers] Error fetching servers:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch servers' });
    }
  });

  // POST /servers - Create a new server
  (router as any).post('/servers', async (req: express.Request, res: express.Response) => {
    const { name, sourceType, sourceId, metadata } = req.body;

    if (!name || !sourceType) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: name, sourceType',
      });
    }

    try {
      const server = await serverInstance.createServer({
        name,
        sourceType,
        sourceId,
        metadata,
      });
      res.status(201).json({ success: true, data: { server } });
    } catch (error) {
      logger.error('[Messages Router /servers] Error creating server:', error);
      res.status(500).json({ success: false, error: 'Failed to create server' });
    }
  });

  // ===============================
  // Server-Agent Association Endpoints
  // ===============================

  // POST /servers/:serverId/agents - Add agent to server
  (router as any).post(
    '/servers/:serverId/agents',
    async (req: express.Request, res: express.Response) => {
      const serverId =
        req.params.serverId === DEFAULT_SERVER_ID
          ? DEFAULT_SERVER_ID
          : validateUuid(req.params.serverId);
      const { agentId } = req.body;

      if (!serverId || !validateUuid(agentId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid serverId or agentId format',
        });
      }

      try {
        // Add agent to server association
        await serverInstance.addAgentToServer(serverId, agentId as UUID);

        // Notify the agent's message bus service to start listening for this server
        const messageForBus = {
          type: 'agent_added_to_server',
          serverId,
          agentId,
        };
        internalMessageBus.emit('server_agent_update', messageForBus);

        res.status(201).json({
          success: true,
          data: {
            serverId,
            agentId,
            message: 'Agent added to server successfully',
          },
        });
      } catch (error) {
        logger.error(
          `[MessagesRouter] Error adding agent ${agentId} to server ${serverId}:`,
          error
        );
        res.status(500).json({ success: false, error: 'Failed to add agent to server' });
      }
    }
  );

  // DELETE /servers/:serverId/agents/:agentId - Remove agent from server
  (router as any).delete(
    '/servers/:serverId/agents/:agentId',
    async (req: express.Request, res: express.Response) => {
      const serverId =
        req.params.serverId === DEFAULT_SERVER_ID
          ? DEFAULT_SERVER_ID
          : validateUuid(req.params.serverId);
      const agentId = validateUuid(req.params.agentId);

      if (!serverId || !agentId) {
        return res.status(400).json({
          success: false,
          error: 'Invalid serverId or agentId format',
        });
      }

      try {
        // Remove agent from server association
        await serverInstance.removeAgentFromServer(serverId, agentId);

        // Notify the agent's message bus service to stop listening for this server
        const messageForBus = {
          type: 'agent_removed_from_server',
          serverId,
          agentId,
        };
        internalMessageBus.emit('server_agent_update', messageForBus);

        res.status(200).json({
          success: true,
          data: {
            serverId,
            agentId,
            message: 'Agent removed from server successfully',
          },
        });
      } catch (error) {
        logger.error(
          `[MessagesRouter] Error removing agent ${agentId} from server ${serverId}:`,
          error
        );
        res.status(500).json({ success: false, error: 'Failed to remove agent from server' });
      }
    }
  );

  // GET /servers/:serverId/agents - List agents in server
  (router as any).get(
    '/servers/:serverId/agents',
    async (req: express.Request, res: express.Response) => {
      const serverId =
        req.params.serverId === DEFAULT_SERVER_ID
          ? DEFAULT_SERVER_ID
          : validateUuid(req.params.serverId);

      if (!serverId) {
        return res.status(400).json({
          success: false,
          error: 'Invalid serverId format',
        });
      }

      try {
        const agents = await serverInstance.getAgentsForServer(serverId);
        res.json({
          success: true,
          data: {
            serverId,
            agents, // Array of agent IDs
          },
        });
      } catch (error) {
        logger.error(`[MessagesRouter] Error fetching agents for server ${serverId}:`, error);
        res.status(500).json({ success: false, error: 'Failed to fetch server agents' });
      }
    }
  );

  // GET /agents/:agentId/servers - List servers agent belongs to
  (router as any).get(
    '/agents/:agentId/servers',
    async (req: express.Request, res: express.Response) => {
      const agentId = validateUuid(req.params.agentId);

      if (!agentId) {
        return res.status(400).json({
          success: false,
          error: 'Invalid agentId format',
        });
      }

      try {
        const servers = await serverInstance.getServersForAgent(agentId);
        res.json({
          success: true,
          data: {
            agentId,
            servers, // Array of server IDs
          },
        });
      } catch (error) {
        logger.error(`[MessagesRouter] Error fetching servers for agent ${agentId}:`, error);
        res.status(500).json({ success: false, error: 'Failed to fetch agent servers' });
      }
    }
  );

  return router;
}
