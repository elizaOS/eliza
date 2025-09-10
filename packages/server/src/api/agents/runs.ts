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

                    // Get generic logs to derive model calls (useModel:*) for this run
                    const genericLogs = await runtime.getLogs({
                        entityId: agentId,
                        roomId: roomId ? (roomId as UUID) : undefined,
                        count: 1000,
                    });

                    // Count logs that match this runId
                    const actionCount = actionLogs.filter(log => log.body?.runId === run.runId).length;
                    // Sum model calls derived from prompts within action logs plus explicit useModel:* entries
                    const modelCallsFromActions = actionLogs
                        .filter(log => log.body?.runId === run.runId && (log.body?.promptCount || 0) > 0)
                        .reduce((sum, log) => sum + (log.body?.promptCount || 0), 0);
                    const modelCallsFromUseModel = genericLogs
                        .filter(log => typeof log.type === 'string' && log.type.startsWith('useModel:') && log.body?.runId === run.runId)
                        .length;
                    const modelCallCount = modelCallsFromActions + modelCallsFromUseModel;
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
        const { roomId } = req.query;

        if (!agentId || !runId) {
            return sendError(res, 400, 'INVALID_ID', 'Invalid agent or run ID format');
        }
        if (roomId && !validateUuid(roomId as string)) {
            return sendError(res, 400, 'INVALID_ID', 'Invalid room ID format');
        }

        const runtime = agents.get(agentId);
        if (!runtime) {
            return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
        }

        try {
            // Fetch logs and filter by runId
            const logs = await runtime.getLogs({
                entityId: agentId,
                roomId: roomId ? (roomId as UUID) : undefined,
                count: 2000,
            });

            const related = logs.filter((l: any) => l?.body?.runId === runId);

            const runEvents = related
                .filter((l: any) => l.type === 'run_event')
                .sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

            const started = runEvents.find((e: any) => e.body?.status === 'started');
            const last = runEvents[runEvents.length - 1];

            const startedAt = started ? new Date(started.createdAt).getTime() : undefined;
            const endedAt = last && last.body?.status !== 'started' ? new Date(last.createdAt).getTime() : undefined;
            const status = last?.body?.status || 'started';
            const durationMs = startedAt && endedAt ? endedAt - startedAt : undefined;

            const actionLogs = related.filter((l: any) => l.type === 'action');
            const actionEventLogs = related.filter((l: any) => l.type === 'action_event');
            const evaluatorLogs = related.filter((l: any) => l.type === 'evaluator');
            const embeddingLogs = related.filter((l: any) => l.type === 'embedding_event');
            const modelLogs = related.filter((l: any) => typeof l.type === 'string' && l.type.startsWith('useModel:'));

            const counts = {
                actions: actionEventLogs.length || actionLogs.length,
                modelCalls: (actionLogs.reduce((sum: number, l: any) => sum + (l.body?.promptCount || 0), 0) || 0) + modelLogs.length,
                errors: actionLogs.filter((l: any) => l.body?.result?.success === false).length + embeddingLogs.filter((l: any) => l.body?.status === 'failed').length,
                evaluators: evaluatorLogs.length,
            };

            const events: Array<{ type: string; timestamp: number; data: Record<string, unknown> }> = [];

            for (const e of runEvents) {
                const t = new Date(e.createdAt).getTime();
                const st = e.body?.status;
                if (st === 'started') {
                    events.push({ type: 'RUN_STARTED', timestamp: t, data: { source: e.body?.source, messageId: e.body?.messageId } });
                } else {
                    events.push({ type: 'RUN_ENDED', timestamp: t, data: { status: st, error: e.body?.error, durationMs: e.body?.duration } });
                }
            }

            for (const e of actionEventLogs) {
                events.push({
                    type: 'ACTION_STARTED',
                    timestamp: new Date(e.createdAt).getTime(),
                    data: {
                        actionId: e.body?.actionId,
                        actionName: e.body?.actionName || e.body?.content?.actions?.[0],
                        messageId: e.body?.messageId,
                        planStep: e.body?.planStep,
                    },
                });
            }

            for (const e of actionLogs) {
                events.push({
                    type: 'ACTION_COMPLETED',
                    timestamp: new Date(e.createdAt).getTime(),
                    data: {
                        actionId: e.body?.actionId,
                        actionName: e.body?.action,
                        success: e.body?.result?.success !== false,
                        result: e.body?.result,
                        promptCount: e.body?.promptCount,
                    },
                });
            }

            for (const e of modelLogs) {
                events.push({
                    type: 'MODEL_USED',
                    timestamp: new Date(e.createdAt).getTime(),
                    data: {
                        modelType: e.body?.modelType || (typeof e.type === 'string' ? e.type.replace('useModel:', '') : undefined),
                        provider: e.body?.provider,
                        executionTime: e.body?.executionTime,
                        actionContext: e.body?.actionContext,
                    },
                });
            }

            for (const e of evaluatorLogs) {
                events.push({
                    type: 'EVALUATOR_COMPLETED',
                    timestamp: new Date(e.createdAt).getTime(),
                    data: {
                        evaluatorName: e.body?.evaluator,
                        success: true,
                    },
                });
            }

            for (const e of embeddingLogs) {
                events.push({
                    type: 'EMBEDDING_EVENT',
                    timestamp: new Date(e.createdAt).getTime(),
                    data: {
                        status: e.body?.status,
                        memoryId: e.body?.memoryId,
                        durationMs: e.body?.duration,
                    },
                });
            }

            events.sort((a, b) => a.timestamp - b.timestamp);

            const firstRunEvent = started || runEvents[0] || related[0];
            const summary = {
                runId,
                status,
                startedAt: startedAt || (firstRunEvent ? new Date(firstRunEvent.createdAt).getTime() : undefined),
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
