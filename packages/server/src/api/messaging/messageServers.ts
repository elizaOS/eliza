import { logger, validateUuid, type UUID } from '@elizaos/core';
import express from 'express';
import internalMessageBus from '../../services/message-bus';
import type { AgentServer } from '../../index';

/**
 * Server management functionality
 */
export function createMessageServersRouter(serverInstance: AgentServer): express.Router {
  const router = express.Router();

  // ============================================================================
  // CURRENT ROUTES - Canonical endpoints
  // ============================================================================

  // GET /message-server/current - Get current server's ID (for this running instance)
  // This is the messageServerId that clients should use when creating channels/messages
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

  // POST /message-servers - Create a new message server
  router.post('/message-servers', async (req: express.Request, res: express.Response) => {
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
          path: '/message-servers',
          error: error instanceof Error ? error.message : String(error),
        },
        'Error creating message server'
      );
      res.status(500).json({ success: false, error: 'Failed to create message server' });
    }
  });

  // ===============================
  // Message Server-Agent Association Endpoints
  // ===============================

  // GET /message-servers/:messageServerId/agents - List agents in message server
  router.get(
    '/message-servers/:messageServerId/agents',
    async (req: express.Request, res: express.Response) => {
      const messageServerId = validateUuid(req.params.messageServerId);

      if (!messageServerId) {
        return res.status(400).json({
          success: false,
          error: 'Invalid messageServerId format',
        });
      }

      // RLS security: Only allow accessing agents for current server
      if (messageServerId !== serverInstance.messageServerId) {
        return res.status(403).json({
          success: false,
          error: 'Cannot access agents for a different server',
        });
      }

      try {
        const agents = await serverInstance.getAgentsForMessageServer(messageServerId);
        res.json({
          success: true,
          data: {
            messageServerId,
            agents, // Array of agent IDs
          },
        });
      } catch (error) {
        logger.error(
          {
            src: 'http',
            path: req.path,
            messageServerId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Error fetching agents for message server'
        );
        res.status(500).json({ success: false, error: 'Failed to fetch message server agents' });
      }
    }
  );

  // POST /message-servers/:messageServerId/agents - Add agent to message server
  router.post(
    '/message-servers/:messageServerId/agents',
    async (req: express.Request, res: express.Response) => {
      const messageServerId = validateUuid(req.params.messageServerId);
      const { agentId } = req.body;

      if (!messageServerId || !validateUuid(agentId)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid messageServerId or agentId format',
        });
      }

      // RLS security: Only allow modifying agents for current server
      if (messageServerId !== serverInstance.messageServerId) {
        return res.status(403).json({
          success: false,
          error: 'Cannot modify agents for a different server',
        });
      }

      try {
        // Add agent to message server association
        await serverInstance.addAgentToMessageServer(messageServerId, agentId as UUID);

        // Notify the agent's message bus service to start listening for this message server
        internalMessageBus.emit('server_agent_update', {
          type: 'agent_added_to_server' as const,
          messageServerId,
          agentId,
        });

        res.status(201).json({
          success: true,
          data: {
            messageServerId,
            agentId,
            message: 'Agent added to message server successfully',
          },
        });
      } catch (error) {
        logger.error(
          {
            src: 'http',
            path: req.path,
            messageServerId,
            agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Error adding agent to message server'
        );
        res.status(500).json({ success: false, error: 'Failed to add agent to message server' });
      }
    }
  );

  // DELETE /message-servers/:messageServerId/agents/:agentId - Remove agent from message server
  router.delete(
    '/message-servers/:messageServerId/agents/:agentId',
    async (req: express.Request, res: express.Response) => {
      const messageServerId = validateUuid(req.params.messageServerId);
      const agentId = validateUuid(req.params.agentId);

      if (!messageServerId || !agentId) {
        return res.status(400).json({
          success: false,
          error: 'Invalid messageServerId or agentId format',
        });
      }

      // RLS security: Only allow modifying agents for current server
      if (messageServerId !== serverInstance.messageServerId) {
        return res.status(403).json({
          success: false,
          error: 'Cannot modify agents for a different server',
        });
      }

      try {
        // Remove agent from message server association
        await serverInstance.removeAgentFromMessageServer(messageServerId, agentId);

        // Notify the agent's message bus service to stop listening for this message server
        internalMessageBus.emit('server_agent_update', {
          type: 'agent_removed_from_server' as const,
          messageServerId,
          agentId,
        });

        res.status(200).json({
          success: true,
          data: {
            messageServerId,
            agentId,
            message: 'Agent removed from message server successfully',
          },
        });
      } catch (error) {
        logger.error(
          {
            src: 'http',
            path: req.path,
            messageServerId,
            agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Error removing agent from message server'
        );
        res
          .status(500)
          .json({ success: false, error: 'Failed to remove agent from message server' });
      }
    }
  );

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
  // These routes maintain the old naming (/servers, :serverId, /central-servers)
  // and forward to the new endpoints. They will be removed in a future version.
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

  /**
   * @deprecated Use POST /message-servers instead
   * Kept for backward compatibility. Will be removed in future versions.
   */
  router.post(
    '/servers',
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.warn('[DEPRECATED] POST /servers is deprecated. Use POST /message-servers instead.');

      // Forward to new endpoint
      req.url = '/message-servers';
      return (router as express.Router & { handle: express.RequestHandler }).handle(req, res, next);
    }
  );

  /**
   * @deprecated Use GET /message-servers/:messageServerId/agents instead
   * Kept for backward compatibility. Will be removed in future versions.
   */
  router.get(
    '/servers/:serverId/agents',
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.warn(
        '[DEPRECATED] GET /servers/:serverId/agents is deprecated. Use GET /message-servers/:messageServerId/agents instead.'
      );

      // Forward to new endpoint with parameter rename
      req.url = req.url.replace('/servers/', '/message-servers/');
      req.params.messageServerId = req.params.serverId;
      return (router as express.Router & { handle: express.RequestHandler }).handle(req, res, next);
    }
  );

  /**
   * @deprecated Use POST /message-servers/:messageServerId/agents instead
   * Kept for backward compatibility. Will be removed in future versions.
   */
  router.post(
    '/servers/:serverId/agents',
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.warn(
        '[DEPRECATED] POST /servers/:serverId/agents is deprecated. Use POST /message-servers/:messageServerId/agents instead.'
      );

      // Forward to new endpoint with parameter rename
      req.url = req.url.replace('/servers/', '/message-servers/');
      req.params.messageServerId = req.params.serverId;
      return (router as express.Router & { handle: express.RequestHandler }).handle(req, res, next);
    }
  );

  /**
   * @deprecated Use DELETE /message-servers/:messageServerId/agents/:agentId instead
   * Kept for backward compatibility. Will be removed in future versions.
   */
  router.delete(
    '/servers/:serverId/agents/:agentId',
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.warn(
        '[DEPRECATED] DELETE /servers/:serverId/agents/:agentId is deprecated. Use DELETE /message-servers/:messageServerId/agents/:agentId instead.'
      );

      // Forward to new endpoint with parameter rename
      req.url = req.url.replace('/servers/', '/message-servers/');
      req.params.messageServerId = req.params.serverId;
      return (router as express.Router & { handle: express.RequestHandler }).handle(req, res, next);
    }
  );

  return router;
}
