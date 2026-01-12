import type {
  ElizaOS,
  UUID,
  Log,
  IDatabaseAdapter,
  IAgentRuntime,
  RunStatus,
  ActionLogBody,
  ModelLogBody,
  EvaluatorLogBody,
  EmbeddingLogBody,
} from '@elizaos/core';
import { validateUuid } from '@elizaos/core';
import express from 'express';
import { sendError, sendSuccess } from '../shared/response-utils';

/**
 * Agent runs management
 */
export function createAgentRunsRouter(elizaOS: ElizaOS): express.Router {
  const router = express.Router();

  const RUNS_CACHE_TTL = 15_000; // 15 seconds to smooth polling bursts
  const runsCache = new Map<
    string,
    { expiresAt: number; payload: { runs: unknown[]; total: number; hasMore: boolean } }
  >();

  const buildCacheKey = (
    agentId: UUID,
    query: {
      roomId?: unknown;
      status?: unknown;
      limit?: unknown;
      from?: unknown;
      to?: unknown;
      entityId?: unknown;
    }
  ) =>
    JSON.stringify({
      agentId,
      roomId: query.roomId || null,
      status: query.status || null,
      limit: query.limit || null,
      from: query.from || null,
      to: query.to || null,
      entityId: query.entityId || null,
    });

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

      // Get entityId from X-Entity-Id header for RLS context
      const entityId = validateUuid(req.headers['x-entity-id'] as string) || undefined;

      // Try cache for the common polling path (no explicit time filters)
      // Include entityId in cache key since results are user-specific with RLS
      const cacheKey =
        !fromTime && !toTime
          ? buildCacheKey(agentId, { roomId, status, limit: limitNum, entityId })
          : null;
      if (cacheKey) {
        const cached = runsCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
          return sendSuccess(res, cached.payload);
        }
      }

      // Runtime has an internal adapter property for database operations
      const adapter =
        (runtime as IAgentRuntime & { adapter?: IDatabaseAdapter }).adapter ?? runtime;
      const allowedStatuses: Array<RunStatus | 'all'> = [
        'started',
        'completed',
        'timeout',
        'error',
        'all',
      ];
      const statusFilter =
        typeof status === 'string' && allowedStatuses.includes(status as RunStatus | 'all')
          ? (status as RunStatus | 'all')
          : undefined;

      if (adapter?.getAgentRunSummaries) {
        try {
          const fastResult = await adapter.getAgentRunSummaries({
            limit: limitNum,
            roomId: roomId ? (roomId as UUID) : undefined,
            status: statusFilter,
            from: fromTime,
            to: toTime,
            entityId,
          });

          if (cacheKey) {
            runsCache.set(cacheKey, {
              payload: fastResult,
              expiresAt: Date.now() + RUNS_CACHE_TTL,
            });
          }

          return sendSuccess(res, fastResult);
        } catch (error) {
          runtime.logger?.warn?.(
            `Optimized run summary query failed, falling back to log aggregation: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }

      // 1) Fetch run events
      // With RLS (entityId present): get only that entity's run_events
      // Without RLS (entityId absent): get all run_events in the room
      const directRunEvents = await runtime
        .getLogs({
          entityId,
          roomId: roomId ? (roomId as UUID) : undefined,
          type: 'run_event',
          count: 1000,
        })
        .catch(() => []);

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

      const ingestRunEvents = (logs: Log[]) => {
        for (const log of logs) {
          const body = log.body;
          const runId = typeof body.runId === 'string' ? body.runId : undefined;
          if (!runId) {
            continue;
          }

          const logTime = new Date(log.createdAt).getTime();
          if (fromTime && logTime < fromTime) {
            continue;
          }
          if (toTime && logTime > toTime) {
            continue;
          }

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
      };

      ingestRunEvents(directRunEvents);

      const needsMoreRuns = () => runMap.size < limitNum;

      // 2) Recent message authors (only if more runs needed)
      if (needsMoreRuns()) {
        try {
          const recentMessages = await runtime.getMemories({
            tableName: 'messages',
            roomId: roomId ? (roomId as UUID) : undefined,
            count: 200,
            entityId,
          });
          const authorIds = Array.from(
            new Set(
              recentMessages
                .map((m) => m.entityId)
                .filter((eid): eid is UUID => Boolean(eid) && (eid as UUID) !== agentId)
            )
          ).slice(0, 10); // cap to avoid huge fan-out

          const authorRunEvents = entityId
            ? []
            : await Promise.all(
                authorIds.map(() =>
                  runtime
                    .getLogs({
                      roomId: roomId ? (roomId as UUID) : undefined,
                      type: 'run_event',
                      count: 500,
                    })
                    .catch(() => [])
                )
              );

          for (const logs of authorRunEvents) {
            ingestRunEvents(logs);
            if (!needsMoreRuns()) {
              break;
            }
          }
        } catch {
          // swallow
        }
      }

      // 3) Broader room scan (only if still not enough and no explicit room filter)
      // Optimized: single query instead of N+1 (worlds→rooms loop)
      if (!roomId && !entityId && needsMoreRuns()) {
        try {
          const allRoomIds = await runtime.getRoomsForParticipant(agentId);
          const limitedRoomIds = allRoomIds.slice(0, 20); // guardrail

          // Fetch logs for each room in parallel (no redundant participant loop)
          const logsPerRoom = await Promise.all(
            limitedRoomIds.map((rId) =>
              runtime.getLogs({ roomId: rId, type: 'run_event', count: 300 }).catch(() => [])
            )
          );

          for (const logs of logsPerRoom) {
            ingestRunEvents(logs);
            if (!needsMoreRuns()) {
              break;
            }
          }
        } catch {
          // ignore
        }
      }

      // Filter by status if specified
      let runs: RunListItem[] = Array.from(runMap.values());
      if (statusFilter && statusFilter !== 'all') {
        runs = runs.filter((run) => run.status === statusFilter);
      }

      // Sort by startedAt desc and apply limit
      runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      const limitedRuns: RunListItem[] = runs.slice(0, limitNum);

      // Bulk fetch logs once per type, then aggregate per runId in memory (avoid N+1)
      const runIdSet = new Set<string>(limitedRuns.map((r) => r.runId));

      let actionLogs: Log[] = [];
      let evaluatorLogs: Log[] = [];
      let genericLogs: Log[] = [];

      if (runIdSet.size > 0) {
        const logFetchCount = Math.max(200, limitNum * 50);

        // Fetch logs with entityId for RLS filtering (user sees only their run's logs)
        const [action, evaluator, generic] = await Promise.all([
          runtime
            .getLogs({
              entityId,
              roomId: roomId ? (roomId as UUID) : undefined,
              type: 'action',
              count: logFetchCount,
            })
            .catch(() => []),
          runtime
            .getLogs({
              entityId,
              roomId: roomId ? (roomId as UUID) : undefined,
              type: 'evaluator',
              count: logFetchCount,
            })
            .catch(() => []),
          runtime
            .getLogs({
              entityId,
              roomId: roomId ? (roomId as UUID) : undefined,
              count: logFetchCount,
            })
            .catch(() => []),
        ]);

        actionLogs = action;
        evaluatorLogs = evaluator;
        genericLogs = generic;
      }

      const countsByRunId: Record<
        string,
        { actions: number; modelCalls: number; errors: number; evaluators: number }
      > = {};
      for (const run of limitedRuns) {
        countsByRunId[run.runId] = { actions: 0, modelCalls: 0, errors: 0, evaluators: 0 };
      }

      // Aggregate action logs
      for (const log of actionLogs) {
        const rid = typeof log.body.runId === 'string' ? log.body.runId : undefined;
        if (!rid || !runIdSet.has(rid)) {
          continue;
        }
        const entry = countsByRunId[rid];
        if (!entry) {
          continue;
        }
        entry.actions += 1;
        const bodyForAction = log.body as ActionLogBody;
        if (bodyForAction.result?.success === false) {
          entry.errors += 1;
        }
        const promptCount = Number(bodyForAction.promptCount || 0);
        if (promptCount > 0) {
          entry.modelCalls += promptCount;
        }
      }

      // Aggregate evaluator logs
      for (const log of evaluatorLogs) {
        const rid = typeof log.body.runId === 'string' ? log.body.runId : undefined;
        if (!rid || !runIdSet.has(rid)) {
          continue;
        }
        const entry = countsByRunId[rid];
        if (!entry) {
          continue;
        }
        entry.evaluators += 1;
      }

      // Aggregate generic logs (useModel:* and embedding_event failures)
      for (const log of genericLogs) {
        const rid = typeof log.body.runId === 'string' ? log.body.runId : undefined;
        if (!rid || !runIdSet.has(rid)) {
          continue;
        }
        const entry = countsByRunId[rid];
        if (!entry) {
          continue;
        }
        if (typeof log.type === 'string' && log.type.startsWith('useModel:')) {
          entry.modelCalls += 1;
        } else if (log.type === 'embedding_event' && log.body.status === 'failed') {
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

      if (cacheKey) {
        runsCache.set(cacheKey, {
          payload: response,
          expiresAt: Date.now() + RUNS_CACHE_TTL,
        });
      }

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
      // Get entityId from X-Entity-Id header for RLS context
      const entityId = validateUuid(req.headers['x-entity-id'] as string) || undefined;

      const logs: Log[] = await runtime.getLogs({
        entityId,
        roomId: roomId ? (roomId as UUID) : undefined,
        count: 5000,
      });

      // Include logs that have this runId OR have this runId as parentRunId (for actions)
      const directlyRelated = logs.filter((l) => {
        const body = l.body;
        return body.runId === runId || body.parentRunId === runId;
      });

      // Get all action runIds from matched action logs
      const actionRunIds = new Set(
        directlyRelated
          .filter((l) => l.type === 'action')
          .map((l) => {
            const runId = l.body.runId;
            return typeof runId === 'string' ? (runId as UUID) : undefined;
          })
          .filter((id): id is UUID => !!id)
      );

      // Also include action_event logs that share runId with matched actions
      // (action_event logs have the action's runId but no parentRunId)
      const related = logs.filter((l) => {
        const body = l.body;
        // Include if directly related to the main run
        if (body.runId === runId || body.parentRunId === runId) {
          return true;
        }
        // Also include action_event logs that match action runIds
        if (l.type === 'action_event' && body.runId && actionRunIds.has(body.runId as UUID)) {
          return true;
        }
        return false;
      });

      const runEvents = related
        .filter((l) => l.type === 'run_event')
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      const started = runEvents.find((e) => e.body.status === 'started');
      const last = runEvents[runEvents.length - 1];

      const startedAt = started ? new Date(started.createdAt).getTime() : undefined;
      const endedAt =
        last && last.body.status !== 'started' ? new Date(last.createdAt).getTime() : undefined;
      const status = last?.body.status || 'started';
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
          (actionLogs.reduce((sum: number, l: Log) => {
            const body = l.body as ActionLogBody;
            return sum + Number(body.promptCount || 0);
          }, 0) || 0) + modelLogs.length,
        errors:
          actionLogs.filter((l: Log) => {
            const body = l.body as ActionLogBody;
            return body.result?.success === false;
          }).length +
          embeddingLogs.filter((l: Log) => {
            const body = l.body as EmbeddingLogBody;
            return body.status === 'failed';
          }).length,
        evaluators: evaluatorLogs.length,
      };

      const events: Array<{ type: string; timestamp: number; data: Record<string, unknown> }> = [];

      for (const e of runEvents) {
        const t = new Date(e.createdAt).getTime();
        const body = e.body;
        const st = body.status;
        if (st === 'started') {
          events.push({
            type: 'RUN_STARTED',
            timestamp: t,
            data: { source: body.source as string | undefined, messageId: body.messageId },
          });
        } else {
          events.push({
            type: 'RUN_ENDED',
            timestamp: t,
            data: {
              status: st,
              error: body.error as string | undefined,
              durationMs: body.duration as number | undefined,
            },
          });
        }
      }

      for (const e of actionEventLogs) {
        const body = e.body as ActionLogBody;
        const content = body.content;
        events.push({
          type: 'ACTION_STARTED',
          timestamp: new Date(e.createdAt).getTime(),
          data: {
            actionId: typeof body.actionId === 'string' ? body.actionId : undefined,
            actionName: (body.actionName as string | undefined) || content?.actions?.[0],
            messageId: body.messageId,
            planStep: body.planStep as string | undefined,
          },
        });
      }

      for (const e of actionLogs) {
        const body = e.body as ActionLogBody;
        events.push({
          type: 'ACTION_COMPLETED',
          timestamp: new Date(e.createdAt).getTime(),
          data: {
            actionId: body.actionId as string | undefined,
            actionName: body.action,
            success: body.result?.success !== false,
            result: body.result as Record<string, unknown> | undefined,
            promptCount: body.promptCount,
            prompts: body.prompts,
            params: body.params as Record<string, unknown> | undefined,
            response: body.response,
          },
        });
      }

      for (const e of modelLogs) {
        const body = e.body as ModelLogBody;
        events.push({
          type: 'MODEL_USED',
          timestamp: new Date(e.createdAt).getTime(),
          data: {
            modelType:
              body.modelType ||
              (typeof e.type === 'string' ? e.type.replace('useModel:', '') : undefined),
            provider: body.provider,
            executionTime: body.executionTime,
            actionContext: body.actionContext as string | undefined,
            params: body.params as Record<string, unknown> | undefined,
            response: body.response,
            usage: body.usage as Record<string, unknown> | undefined,
            prompts: body.prompts as Array<{ prompt?: string; modelType?: string }> | undefined,
            prompt: body.prompt as string | undefined,
            inputTokens: body.inputTokens as number | undefined,
            outputTokens: body.outputTokens as number | undefined,
            cost: body.cost as number | undefined,
          },
        });
      }

      for (const e of evaluatorLogs) {
        const body = e.body as EvaluatorLogBody;
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
        const body = e.body as EmbeddingLogBody;
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
