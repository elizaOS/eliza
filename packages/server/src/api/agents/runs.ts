import type { IAgentRuntime, UUID } from '@elizaos/core';
import { validateUuid } from '@elizaos/core';
import express from 'express';
import { sendError, sendSuccess } from '../shared/response-utils';

/**
 * Agent runs management
 */
export function createAgentRunsRouter(agents: Map<UUID, IAgentRuntime>): express.Router {
    const router = express.Router();

  // List Agent Runs
  router.get('/:agentId/runs', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    const { roomId, status, limit = 20, from, to } = req.query;

    if (roomId && !validateUuid(roomId as string)) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid room ID format');
    }

    try {
      const limitNum = Math.min(Number(limit) || 20, 100); // Cap at 100
      const fromTime = from ? Number(from) : undefined;
      const toTime = to ? Number(to) : undefined;

      // Get run_event logs to build the runs list
      const runEventLogs = await runtime.getLogs({
        entityId: agentId,
        roomId: roomId ? (roomId as UUID) : undefined,
        type: 'run_event',
        count: limitNum * 3, // Get more to account for multiple events per run
      });

      // Group by runId and build run summaries
      const runMap = new Map<string, any>();

      for (const log of runEventLogs) {
        const runId = log.body?.runId as string;
        if (!runId) continue;

        const logTime = new Date(log.createdAt).getTime();
        
        // Apply time filters
        if (fromTime && logTime < fromTime) continue;
        if (toTime && logTime > toTime) continue;

        if (!runMap.has(runId)) {
          runMap.set(runId, {
            runId,
            status: 'started',
            startedAt: null,
            endedAt: null,
            durationMs: null,
            messageId: log.body?.messageId,
            roomId: log.body?.roomId,
            entityId: log.body?.entityId,
            metadata: log.body?.metadata || {},
          });
        }

        const run = runMap.get(runId);
        const eventStatus = log.body?.status;

        if (eventStatus === 'started') {
          run.startedAt = logTime;
        } else if (eventStatus === 'completed' || eventStatus === 'timeout' || eventStatus === 'error') {
          run.status = eventStatus;
          run.endedAt = logTime;
          if (run.startedAt) {
            run.durationMs = logTime - run.startedAt;
          }
        }
      }

      // Filter by status if specified
      let runs = Array.from(runMap.values());
      if (status && status !== 'all') {
        runs = runs.filter(run => run.status === status);
      }

      // Sort by startedAt desc and apply limit
      runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      const limitedRuns = runs.slice(0, limitNum);

      // Get counts for each run by fetching related logs
      for (const run of limitedRuns) {
        try {
          // Get action logs for this run
          const actionLogs = await runtime.getLogs({
            entityId: agentId,
            roomId: roomId ? (roomId as UUID) : undefined,
            type: 'action',
            count: 1000,
          });

          // Get action_event logs for this run
          const actionEventLogs = await runtime.getLogs({
            entityId: agentId,
            roomId: roomId ? (roomId as UUID) : undefined,
            type: 'action_event',
            count: 1000,
          });

          // Get evaluator logs for this run
          const evaluatorLogs = await runtime.getLogs({
            entityId: agentId,
            roomId: roomId ? (roomId as UUID) : undefined,
            type: 'evaluator',
            count: 1000,
          });

          // Count logs that match this runId
          const actionCount = actionLogs.filter(log => log.body?.runId === run.runId).length;
          const modelCallCount = actionLogs.filter(log => 
            log.body?.runId === run.runId && log.body?.prompts?.length > 0
          ).reduce((sum, log) => sum + (log.body?.promptCount || 0), 0);
          const errorCount = actionLogs.filter(log => 
            log.body?.runId === run.runId && log.body?.result?.success === false
          ).length;
          const evaluatorCount = evaluatorLogs.filter(log => log.body?.runId === run.runId).length;

          run.counts = {
            actions: actionCount,
            modelCalls: modelCallCount,
            errors: errorCount,
            evaluators: evaluatorCount,
          };
        } catch (countError) {
          // If counting fails, use zeros
          run.counts = { actions: 0, modelCalls: 0, errors: 0, evaluators: 0 };
        }
      }

      const response = {
        runs: limitedRuns,
        total: runs.length,
        hasMore: runs.length > limitNum,
      };

      sendSuccess(res, response);
    } catch (error) {
      sendError(
        res,
        500,
        'RUNS_ERROR',
        'Error retrieving agent runs',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

    // Get Specific Run Detail
    router.get('/:agentId/runs/:runId', async (req, res) => {
        const agentId = validateUuid(req.params.agentId);
        const runId = validateUuid(req.params.runId);

        if (!agentId || !runId) {
            return sendError(res, 400, 'INVALID_ID', 'Invalid agent or run ID format');
        }

        const runtime = agents.get(agentId);
        if (!runtime) {
            return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
        }

        try {
            // TODO: Implement run detail aggregation
            const stubResponse = {
                summary: {
                    runId,
                    status: 'completed' as const,
                    startedAt: Date.now(),
                    endedAt: Date.now(),
                    durationMs: 0,
                    messageId: runId, // placeholder
                    roomId: agentId, // placeholder
                    entityId: agentId, // placeholder
                    counts: {
                        actions: 0,
                        modelCalls: 0,
                        errors: 0,
                        evaluators: 0,
                    },
                },
                events: [],
            };

            sendSuccess(res, stubResponse);
        } catch (error) {
            sendError(
                res,
                500,
                'RUN_DETAIL_ERROR',
                'Error retrieving run details',
                error instanceof Error ? error.message : String(error)
            );
        }
    });

    return router;
}
