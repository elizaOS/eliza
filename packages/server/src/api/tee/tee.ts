import type { IAgentRuntime } from '@elizaos/core';
import { ServiceType, logger } from '@elizaos/core';
import express from 'express';

// Local type definitions until these are added to core
interface TeeLogQuery {
  agentId?: string;
  roomId?: string;
  entityId?: string;
  type?: string;
  containsContent?: string;
  startTimestamp?: number;
  endTimestamp?: number;
}

/**
 * TEE (Trusted Execution Environment) security functionality
 */
export function createTeeRouter(agents: Map<string, IAgentRuntime>): express.Router {
  const router = express.Router();

  // Get all TEE agents
  // @ts-ignore - Express type issue with async handlers
  router.get('/agents', async (_req, res) => {
    try {
      const allAgents = [];

      for (const agentRuntime of agents.values()) {
        const teeLogService = agentRuntime.getService(ServiceType.TEE);

        const agents = await (teeLogService as any).getAllAgents();
        allAgents.push(...agents);
      }

      const runtime: IAgentRuntime = agents.values().next().value;
      const teeLogService = runtime.getService(ServiceType.TEE);
      const attestation = await (teeLogService as any).generateAttestation(
        JSON.stringify(allAgents)
      );
      res.json({ agents: allAgents, attestation: attestation });
    } catch (error) {
      logger.error('Failed to get TEE agents:', error);
      res.status(500).json({
        error: 'Failed to get TEE agents',
      });
    }
  });

  // Get specific TEE agent
  // @ts-ignore - Express type issue with async handlers
  router.get('/agents/:agentId', async (req, res) => {
    try {
      const agentId = req.params.agentId;
      const agentRuntime = agents.get(agentId);
      if (!agentRuntime) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      const teeLogService = agentRuntime.getService(ServiceType.TEE);

      const teeAgent = await (teeLogService as any).getAgent(agentId);
      const attestation = await (teeLogService as any).generateAttestation(
        JSON.stringify(teeAgent)
      );
      res.json({ agent: teeAgent, attestation: attestation });
    } catch (error) {
      logger.error('Failed to get TEE agent:', error);
      res.status(500).json({
        error: 'Failed to get TEE agent',
      });
    }
  });

  // Query TEE logs
  // @ts-ignore - Express type issue with async handlers
  router.post('/logs', async (req: express.Request, res: express.Response) => {
    try {
      const query = req.body.query || {};
      const page = Number.parseInt(req.body.page) || 1;
      const pageSize = Number.parseInt(req.body.pageSize) || 10;

      const teeLogQuery: TeeLogQuery = {
        agentId: query.agentId || '',
        roomId: query.roomId || '',
        entityId: query.entityId || '',
        type: query.type || '',
        containsContent: query.containsContent || '',
        startTimestamp: query.startTimestamp || undefined,
        endTimestamp: query.endTimestamp || undefined,
      };
      const agentRuntime: IAgentRuntime = agents.values().next().value;
      const teeLogService = agentRuntime.getService(ServiceType.TEE);
      const pageQuery = await (teeLogService as any).getLogs(teeLogQuery, page, pageSize);
      const attestation = await (teeLogService as any).generateAttestation(
        JSON.stringify(pageQuery)
      );
      res.json({
        logs: pageQuery,
        attestation: attestation,
      });
    } catch (error) {
      logger.error('Failed to get TEE logs:', error);
      res.status(500).json({
        error: 'Failed to get TEE logs',
      });
    }
  });

  return router;
}
