import type { IAgentRuntime, UUID, Log } from '@elizaos/core';
import { validateUuid, logger } from '@elizaos/core';
import express from 'express';
import { sendError, sendSuccess } from '../shared/response-utils';

/**
 * Agent logs management
 */
export function createAgentLogsRouter(agents: Map<UUID, IAgentRuntime>): express.Router {
  const router = express.Router();

  // Get Agent Logs
  router.get('/:agentId/logs', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    const { roomId, type, count, offset, excludeTypes } = req.query;
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    if (roomId) {
      const roomIdValidated = validateUuid(roomId as string);
      if (!roomIdValidated) {
        return sendError(res, 400, 'INVALID_ID', 'Invalid room ID format');
      }
    }

    try {
      const logs: Log[] = await runtime.getLogs({
        entityId: agentId,
        roomId: roomId ? (roomId as UUID) : undefined,
        type: type ? (type as string) : undefined,
        count: count ? Number(count) : undefined,
        offset: offset ? Number(offset) : undefined,
      });

      // Filter out excluded types if specified
      let filteredLogs = logs;
      if (excludeTypes) {
        const excludeTypesArray = Array.isArray(excludeTypes)
          ? (excludeTypes as string[])
          : [excludeTypes as string];

        filteredLogs = logs.filter((log) => {
          // Check the log type
          if (log.type && excludeTypesArray.includes(log.type)) {
            return false;
          }

          // Check the modelType in the log body for model-related operations
          if (log.body && typeof log.body === 'object') {
            const body = log.body as any;
            if (
              body.modelType &&
              excludeTypesArray.some((excludeType) =>
                body.modelType.toLowerCase().includes(excludeType.toLowerCase())
              )
            ) {
              return false;
            }
          }

          return true;
        });
      }

      sendSuccess(res, filteredLogs);
    } catch (error) {
      logger.error(`[AGENT LOGS] Error retrieving logs for agent ${agentId}:`, error);
      sendError(
        res,
        500,
        'LOG_ERROR',
        'Error retrieving agent logs',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Delete specific log
  router.delete('/:agentId/logs/:logId', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    const logId = validateUuid(req.params.logId);
    if (!agentId || !logId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent or log ID format');
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    try {
      await runtime.deleteLog(logId);
      res.status(204).send();
    } catch (error) {
      logger.error(`[LOG DELETE] Error deleting log ${logId} for agent ${agentId}:`, error);
      sendError(
        res,
        500,
        'DELETE_ERROR',
        'Failed to delete log',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  return router;
}
