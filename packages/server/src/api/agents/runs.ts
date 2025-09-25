import type { ElizaOS, UUID, Log } from '@elizaos/core';
import { validateUuid } from '@elizaos/core';
import express from 'express';
import { sendError, sendSuccess } from '../shared/response-utils';

/**
 * Agent runs management
 */
export function createAgentRunsRouter(elizaOS: ElizaOS): express.Router {
  const router = express.Router();

  // List Agent Runs
  router.get('/:agentId/runs', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const runtime = elizaOS.getAgent(agentId);
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
      type RunListItem = {
        runId: string;
        status: 'started' | 'completed' | 'timeout' | 'error';
        startedAt: number | null;
        endedAt: number | null;
        durationMs: number | null;
        messageId?: UUID;
        roomId?: UUID;
        entityId?: UUID;
        metadata?: Record<string, unknown>;
        counts?: { actions: number; modelCalls: number; errors: number; evaluators: number };
      };
      const runMap = new Map<string, RunListItem>();

      for (const log of runEventLogs) {
        const body = log.body as {
          runId?: string;
          status?: 'started' | 'completed' | 'timeout' | 'error';
          messageId?: UUID;
          roomId?: UUID;
          entityId?: UUID;
          metadata?: Record<string, unknown>;
        };
        const runId = body.runId as string;
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
            messageId: body.messageId,
            roomId: body.roomId,
            entityId: body.entityId,
            metadata: body.metadata || ({} as Record<string, unknown>),
          });
        }

        const run = runMap.get(runId)!;
        const eventStatus = body.status;

        if (eventStatus === 'started') {
          run.startedAt = logTime;
        } else if (
          eventStatus === 'completed' ||
          eventStatus === 'timeout' ||
          eventStatus === 'error'
        ) {
          run.status = eventStatus;
          run.endedAt = logTime;
          if (run.startedAt) {
            run.durationMs = logTime - run.startedAt;
          }
        }
      }

      // Filter by status if specified
      let runs: RunListItem[] = Array.from(runMap.values());
      if (status && status !== 'all') {
        runs = runs.filter((run) => run.status === status);
      }

      // Sort by startedAt desc and apply limit
      runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      const limitedRuns: RunListItem[] = runs.slice(0, limitNum);

      // Bulk fetch logs once per type, then aggregate per runId in memory (avoid N+1)
      const runIdSet = new Set<string>(limitedRuns.map((r) => r.runId));

      const [actionLogs, evaluatorLogs, genericLogs]: [Log[], Log[], Log[]] = await Promise.all([
        runtime.getLogs({
          entityId: agentId,
          roomId: roomId ? (roomId as UUID) : undefined,
          type: 'action',
          count: 5000,
        }),
        runtime.getLogs({
          entityId: agentId,
          roomId: roomId ? (roomId as UUID) : undefined,
          type: 'evaluator',
          count: 5000,
        }),
        runtime.getLogs({
          entityId: agentId,
          roomId: roomId ? (roomId as UUID) : undefined,
          count: 5000,
        }),
      ]);

      const countsByRunId: Record<
        string,
        { actions: number; modelCalls: number; errors: number; evaluators: number }
      > = {};
      for (const run of limitedRuns) {
        countsByRunId[run.runId] = { actions: 0, modelCalls: 0, errors: 0, evaluators: 0 };
      }

      // Aggregate action logs
      for (const log of actionLogs) {
        const rid = (log.body as { runId?: string }).runId;
        if (!rid || !runIdSet.has(rid)) continue;
        const entry = countsByRunId[rid];
        if (!entry) continue;
        entry.actions += 1;
        const bodyForAction = log.body as { result?: { success?: boolean }; promptCount?: number };
        if (bodyForAction.result?.success === false) entry.errors += 1;
        const promptCount = Number(bodyForAction.promptCount || 0);
        if (promptCount > 0) entry.modelCalls += promptCount;
      }

      // Aggregate evaluator logs
      for (const log of evaluatorLogs) {
        const rid = (log.body as { runId?: string }).runId;
        if (!rid || !runIdSet.has(rid)) continue;
        const entry = countsByRunId[rid];
        if (!entry) continue;
        entry.evaluators += 1;
      }

      // Aggregate generic logs (useModel:* and embedding_event failures)
      for (const log of genericLogs) {
        const rid = (log.body as { runId?: string; status?: string }).runId;
        if (!rid || !runIdSet.has(rid)) continue;
        const entry = countsByRunId[rid];
        if (!entry) continue;
        if (typeof log.type === 'string' && log.type.startsWith('useModel:')) {
          entry.modelCalls += 1;
        } else if (
          log.type === 'embedding_event' &&
          (log.body as { status?: string }).status === 'failed'
        ) {
          entry.errors += 1;
        }
      }

      // Attach counts
      for (const run of limitedRuns) {
        run.counts = countsByRunId[run.runId] || {
          actions: 0,
          modelCalls: 0,
          errors: 0,
          evaluators: 0,
        };
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
    const { roomId } = req.query;

    if (!agentId || !runId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent or run ID format');
    }
    if (roomId && !validateUuid(roomId as string)) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid room ID format');
    }

    const runtime = elizaOS.getAgent(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    try {
      // Fetch logs and filter by runId
      const logs: Log[] = await runtime.getLogs({
        entityId: agentId,
        roomId: roomId ? (roomId as UUID) : undefined,
        count: 2000,
      });

      const related = logs.filter((l) => (l.body as { runId?: UUID }).runId === runId);

      const runEvents = related
        .filter((l) => l.type === 'run_event')
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      const started = runEvents.find((e) => (e.body as { status?: string }).status === 'started');
      const last = runEvents[runEvents.length - 1];

      const startedAt = started ? new Date(started.createdAt).getTime() : undefined;
      const endedAt =
        last && (last.body as { status?: string }).status !== 'started'
          ? new Date(last.createdAt).getTime()
          : undefined;
      const status = (last?.body as { status?: string })?.status || 'started';
      const durationMs = startedAt && endedAt ? endedAt - startedAt : undefined;

      const actionLogs = related.filter((l) => l.type === 'action');
      const actionEventLogs = related.filter((l) => l.type === 'action_event');
      const evaluatorLogs = related.filter((l) => l.type === 'evaluator');
      const embeddingLogs = related.filter((l) => l.type === 'embedding_event');
      const modelLogs = related.filter(
        (l) => typeof l.type === 'string' && l.type.startsWith('useModel:')
      );

      const counts = {
        actions: actionEventLogs.length || actionLogs.length,
        modelCalls:
          (actionLogs.reduce(
            (sum: number, l: Log) =>
              sum + Number((l.body as { promptCount?: number }).promptCount || 0),
            0
          ) || 0) + modelLogs.length,
        errors:
          actionLogs.filter(
            (l: Log) => (l.body as { result?: { success?: boolean } }).result?.success === false
          ).length +
          embeddingLogs.filter((l: Log) => (l.body as { status?: string }).status === 'failed')
            .length,
        evaluators: evaluatorLogs.length,
      };

      const events: Array<{ type: string; timestamp: number; data: Record<string, unknown> }> = [];

      for (const e of runEvents) {
        const t = new Date(e.createdAt).getTime();
        const body = e.body as {
          status?: string;
          source?: string;
          messageId?: UUID;
          error?: string;
          duration?: number;
        };
        const st = body.status;
        if (st === 'started') {
          events.push({
            type: 'RUN_STARTED',
            timestamp: t,
            data: { source: body.source ?? undefined, messageId: body.messageId },
          });
        } else {
          events.push({
            type: 'RUN_ENDED',
            timestamp: t,
            data: { status: st, error: body.error, durationMs: body.duration },
          });
        }
      }

      for (const e of actionEventLogs) {
        const body = e.body as {
          actionId?: string;
          actionName?: string;
          content?: { actions?: string[] };
          messageId?: UUID;
          planStep?: string;
        };
        events.push({
          type: 'ACTION_STARTED',
          timestamp: new Date(e.createdAt).getTime(),
          data: {
            actionId: body.actionId,
            actionName: body.actionName || body.content?.actions?.[0],
            messageId: body.messageId,
            planStep: body.planStep,
          },
        });
      }

      for (const e of actionLogs) {
        const body = e.body as {
          actionId?: string;
          action?: string;
          result?: { success?: boolean };
          promptCount?: number;
        };
        events.push({
          type: 'ACTION_COMPLETED',
          timestamp: new Date(e.createdAt).getTime(),
          data: {
            actionId: body.actionId,
            actionName: body.action,
            success: body.result?.success !== false,
            result: body.result as Record<string, unknown> | undefined,
            promptCount: body.promptCount,
          },
        });
      }

      for (const e of modelLogs) {
        const body = e.body as {
          modelType?: string;
          provider?: string;
          executionTime?: number;
          actionContext?: string;
        };
        events.push({
          type: 'MODEL_USED',
          timestamp: new Date(e.createdAt).getTime(),
          data: {
            modelType:
              body.modelType ||
              (typeof e.type === 'string' ? e.type.replace('useModel:', '') : undefined),
            provider: body.provider,
            executionTime: body.executionTime,
            actionContext: body.actionContext,
          },
        });
      }

      for (const e of evaluatorLogs) {
        const body = e.body as { evaluator?: string };
        events.push({
          type: 'EVALUATOR_COMPLETED',
          timestamp: new Date(e.createdAt).getTime(),
          data: {
            evaluatorName: body.evaluator,
            success: true,
          },
        });
      }

      for (const e of embeddingLogs) {
        const body = e.body as { status?: string; memoryId?: string; duration?: number };
        events.push({
          type: 'EMBEDDING_EVENT',
          timestamp: new Date(e.createdAt).getTime(),
          data: {
            status: body.status,
            memoryId: body.memoryId,
            durationMs: body.duration,
          },
        });
      }

      events.sort((a, b) => a.timestamp - b.timestamp);

      const firstRunEvent = started || runEvents[0] || related[0];
      const summary = {
        runId,
        status,
        startedAt:
          startedAt || (firstRunEvent ? new Date(firstRunEvent.createdAt).getTime() : undefined),
        endedAt,
        durationMs,
        messageId: firstRunEvent?.body?.messageId,
        roomId: firstRunEvent?.body?.roomId || (roomId as UUID | undefined),
        entityId: firstRunEvent?.body?.entityId || agentId,
        counts,
      } as const;

      sendSuccess(res, { summary, events });
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
