import { logger, validateUuid, type UUID } from '@elizaos/core';
import express from 'express';
import internalMessageBus from '../../services/message-bus';
import type { AgentServer } from '../../index';

/**
 * Server management functionality
 */
export function createMessageServersRouter(serverInstance: AgentServer): express.Router {
  const router = express.Router();

  // GET /server/current - Get current server's ID (for this running instance)
  // This is the serverId that clients should use when creating channels/messages
  router.get('/message-server/current', async (_req: express.Request, res: express.Response) => {
    try {
      res.json({
        success: true,
        data: {
          messageServerId: serverInstance.messageServerId,
        },
      });
    } catch (error: unknown) {
      logger.error(
        {
          src: 'http',
          path: '/message-server/current',
          error: error instanceof Error ? error.message : String(error),
        },
        'Error fetching current server'
      );
      res.status(500).json({ success: false, error: 'Failed to fetch current server' });
    }
  });

  // GET /message-servers - List all message servers
  router.get('/message-servers', async (_req: express.Request, res: express.Response) => {
    try {
      const messageServers = await serverInstance.getServers();
      res.json({ success: true, data: { messageServers } });
    } catch (error) {
      logger.error(
        '[Messages Router /message-servers] Error fetching message servers:',
        error instanceof Error ? error.message : String(error)
      );
      res.status(500).json({ success: false, error: 'Failed to fetch message servers' });
    }
  });

  // POST /servers - Create a new server
  router.post('/servers', async (req: express.Request, res: express.Response) => {
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
      logger.error(
        {
          src: 'http',
          path: '/servers',
          error: error instanceof Error ? error.message : String(error),
        },
        'Error creating server'
      );
      res.status(500).json({ success: false, error: 'Failed to create server' });
    }
  });

  // ===============================
  // Server-Agent Association Endpoints
  // ===============================

  // POST /servers/:serverId/agents - Add agent to server
  router.post('/servers/:serverId/agents', async (req: express.Request, res: express.Response) => {
    const serverId = validateUuid(req.params.serverId);
    const { agentId } = req.body;

    if (!serverId || !validateUuid(agentId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid serverId or agentId format',
      });
    }

    // RLS security: Only allow modifying agents for current server
    if (serverId !== serverInstance.messageServerId) {
      return res.status(403).json({
        success: false,
        error: 'Cannot modify agents for a different server',
      });
    }

    try {
      // Add agent to message server association
      await serverInstance.addAgentToMessageServer(serverId, agentId as UUID);

      // Notify the agent's message bus service to start listening for this message server
      internalMessageBus.emit('server_agent_update', {
        type: 'agent_added_to_server' as const,
        messageServerId: serverId,
        agentId,
      });

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
        {
          src: 'http',
          path: req.path,
          serverId,
          agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error adding agent to server'
      );
      res.status(500).json({ success: false, error: 'Failed to add agent to server' });
    }
  });

  // DELETE /servers/:serverId/agents/:agentId - Remove agent from server
  router.delete(
    '/servers/:serverId/agents/:agentId',
    async (req: express.Request, res: express.Response) => {
      const serverId = validateUuid(req.params.serverId);
      const agentId = validateUuid(req.params.agentId);

      if (!serverId || !agentId) {
        return res.status(400).json({
          success: false,
          error: 'Invalid serverId or agentId format',
        });
      }

      // RLS security: Only allow modifying agents for current server
      if (serverId !== serverInstance.messageServerId) {
        return res.status(403).json({
          success: false,
          error: 'Cannot modify agents for a different server',
        });
      }

      try {
        // Remove agent from message server association
        await serverInstance.removeAgentFromMessageServer(serverId, agentId);

        // Notify the agent's message bus service to stop listening for this message server
        internalMessageBus.emit('server_agent_update', {
          type: 'agent_removed_from_server' as const,
          messageServerId: serverId,
          agentId,
        });

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
          {
            src: 'http',
            path: req.path,
            serverId,
            agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Error removing agent from server'
        );
        res.status(500).json({ success: false, error: 'Failed to remove agent from server' });
      }
    }
  );

  // GET /servers/:serverId/agents - List agents in server
  router.get('/servers/:serverId/agents', async (req: express.Request, res: express.Response) => {
    const serverId = validateUuid(req.params.serverId);

    if (!serverId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid serverId format',
      });
    }

    // RLS security: Only allow accessing agents for current server
    if (serverId !== serverInstance.messageServerId) {
      return res.status(403).json({
        success: false,
        error: 'Cannot access agents for a different server',
      });
    }

    try {
      const agents = await serverInstance.getAgentsForMessageServer(serverId);
      res.json({
        success: true,
        data: {
          serverId,
          agents, // Array of agent IDs
        },
      });
    } catch (error) {
      logger.error(
        {
          src: 'http',
          path: req.path,
          serverId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error fetching agents for server'
      );
      res.status(500).json({ success: false, error: 'Failed to fetch server agents' });
    }
  });

  // GET /agents/:agentId/message-servers - List message servers agent belongs to
  router.get(
    '/agents/:agentId/message-servers',
    async (req: express.Request, res: express.Response) => {
      const agentId = validateUuid(req.params.agentId);

      if (!agentId) {
        return res.status(400).json({
          success: false,
          error: 'Invalid agentId format',
        });
      }

      try {
        const messageServers = await serverInstance.getMessageServersForAgent(agentId);
        res.json({
          success: true,
          data: {
            agentId,
            messageServers, // Array of message server IDs
          },
        });
      } catch (error) {
        logger.error(
          {
            src: 'http',
            path: req.path,
            agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Error fetching message servers for agent'
        );
        res.status(500).json({ success: false, error: 'Failed to fetch agent message servers' });
      }
    }
  );

  // ============================================================================
  // DEPRECATED ROUTES - For backward compatibility only
  // ============================================================================

  /**
   * @deprecated Use GET /message-servers instead
   * Kept for backward compatibility. Will be removed in future versions.
   */
  router.get('/central-servers', async (_req: express.Request, res: express.Response) => {
    logger.warn(
      '[DEPRECATED] GET /central-servers is deprecated. Use GET /message-servers instead.'
    );

    try {
      const messageServers = await serverInstance.getServers();
      // Return with old key name for backward compatibility
      res.json({ success: true, data: { servers: messageServers } });
    } catch (error) {
      logger.error(
        '[Messages Router /central-servers] Error fetching servers:',
        error instanceof Error ? error.message : String(error)
      );
      res.status(500).json({ success: false, error: 'Failed to fetch servers' });
    }
  });

  return router;
}
