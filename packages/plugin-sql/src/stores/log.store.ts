import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type {
  Log,
  LogBody,
  UUID,
  AgentRunSummary,
  AgentRunSummaryResult,
  AgentRunCounts,
  RunStatus,
} from '@elizaos/core';
import { logger } from '@elizaos/core';
import { logTable, roomTable } from '../schema';
import type { Store, StoreContext } from './types';
import { sanitizeJsonObject } from '../utils';

// Raw SQL row types for aggregate queries
type ActionSummaryRow = {
  runId: string;
  actions: number | string;
  errors: number | string;
  modelCalls: number | string;
};

type EvaluatorSummaryRow = {
  runId: string;
  evaluators: number | string;
};

type GenericSummaryRow = {
  runId: string;
  modelLogs: number | string;
  embeddingErrors: number | string;
};

export class LogStore implements Store {
  constructor(public readonly ctx: StoreContext) {}

  async create(params: {
    body: { [key: string]: unknown };
    entityId: UUID;
    roomId: UUID;
    type: string;
  }): Promise<void> {
    try {
      const sanitizedBody = sanitizeJsonObject(params.body);
      const jsonString = JSON.stringify(sanitizedBody);

      await this.ctx.withIsolationContext(params.entityId, async (tx) => {
        await tx.insert(logTable).values({
          body: sql`${jsonString}::jsonb`,
          entityId: params.entityId,
          roomId: params.roomId,
          type: params.type,
        });
      });
    } catch (error) {
      logger.error(
        {
          src: 'plugin:sql',
          type: params.type,
          roomId: params.roomId,
          entityId: params.entityId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to create log entry'
      );
      throw error;
    }
  }

  async getMany(params: {
    entityId?: UUID;
    roomId?: UUID;
    type?: string;
    count?: number;
    offset?: number;
  }): Promise<Log[]> {
    const { entityId, roomId, type, count, offset } = params;

    return this.ctx.withIsolationContext(entityId ?? null, async (tx) => {
      const result = await tx
        .select()
        .from(logTable)
        .where(
          and(
            roomId ? eq(logTable.roomId, roomId) : undefined,
            type ? eq(logTable.type, type) : undefined
          )
        )
        .orderBy(desc(logTable.createdAt))
        .limit(count ?? 10)
        .offset(offset ?? 0);

      return result.map((log) => ({
        ...log,
        id: log.id as UUID,
        entityId: log.entityId as UUID,
        roomId: log.roomId as UUID,
        type: log.type as string,
        body: log.body as LogBody,
        createdAt: new Date(log.createdAt as string | number | Date),
      }));
    });
  }

  async getAgentRunSummaries(
    agentId: UUID,
    params: {
      limit?: number;
      roomId?: UUID;
      status?: RunStatus | 'all';
      from?: number;
      to?: number;
      entityId?: UUID;
    } = {}
  ): Promise<AgentRunSummaryResult> {
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
    const fromDate = typeof params.from === 'number' ? new Date(params.from) : undefined;
    const toDate = typeof params.to === 'number' ? new Date(params.to) : undefined;

    return this.ctx.withIsolationContext(params.entityId ?? null, async (tx) => {
      const runMap = new Map<string, AgentRunSummary>();

      const conditions: SQL<unknown>[] = [
        eq(logTable.type, 'run_event'),
        sql`${logTable.body} ? 'runId'`,
        eq(roomTable.agentId, agentId),
      ];

      if (params.roomId) {
        conditions.push(eq(logTable.roomId, params.roomId));
      }
      if (fromDate) {
        conditions.push(gte(logTable.createdAt, fromDate));
      }
      if (toDate) {
        conditions.push(lte(logTable.createdAt, toDate));
      }

      const whereClause = and(...conditions);
      const eventLimit = Math.max(limit * 20, 200);

      const runEventRows = await tx
        .select({
          runId: sql<string>`(${logTable.body} ->> 'runId')`,
          status: sql<string | null>`(${logTable.body} ->> 'status')`,
          messageId: sql<string | null>`(${logTable.body} ->> 'messageId')`,
          rawBody: logTable.body,
          createdAt: logTable.createdAt,
          roomId: logTable.roomId,
          entityId: logTable.entityId,
        })
        .from(logTable)
        .innerJoin(roomTable, eq(roomTable.id, logTable.roomId))
        .where(whereClause)
        .orderBy(desc(logTable.createdAt))
        .limit(eventLimit);

      for (const row of runEventRows) {
        const runId = row.runId;
        if (!runId) continue;

        const summary: AgentRunSummary = runMap.get(runId) ?? {
          runId,
          status: 'started',
          startedAt: null,
          endedAt: null,
          durationMs: null,
          messageId: undefined,
          roomId: undefined,
          entityId: undefined,
          metadata: {},
        };

        if (!summary.messageId && row.messageId) {
          summary.messageId = row.messageId as UUID;
        }
        if (!summary.roomId && row.roomId) {
          summary.roomId = row.roomId as UUID;
        }
        if (!summary.entityId && row.entityId) {
          summary.entityId = row.entityId as UUID;
        }

        const body = row.rawBody as Record<string, unknown> | undefined;
        if (body && typeof body === 'object') {
          if (!summary.roomId && typeof body.roomId === 'string') {
            summary.roomId = body.roomId as UUID;
          }
          if (!summary.entityId && typeof body.entityId === 'string') {
            summary.entityId = body.entityId as UUID;
          }
          if (!summary.messageId && typeof body.messageId === 'string') {
            summary.messageId = body.messageId as UUID;
          }
          if (!summary.metadata || Object.keys(summary.metadata).length === 0) {
            const metadata = (body.metadata as Record<string, unknown> | undefined) ?? undefined;
            summary.metadata = metadata ? { ...metadata } : {};
          }
        }

        const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
        const timestamp = createdAt.getTime();
        const eventStatus =
          (row.status as RunStatus | undefined) ?? (body?.status as RunStatus | undefined);

        if (eventStatus === 'started') {
          summary.startedAt =
            summary.startedAt === null ? timestamp : Math.min(summary.startedAt, timestamp);
        } else if (
          eventStatus === 'completed' ||
          eventStatus === 'timeout' ||
          eventStatus === 'error'
        ) {
          summary.status = eventStatus;
          summary.endedAt = timestamp;
          if (summary.startedAt !== null) {
            summary.durationMs = Math.max(timestamp - summary.startedAt, 0);
          }
        }

        runMap.set(runId, summary);
      }

      let runs = Array.from(runMap.values());
      if (params.status && params.status !== 'all') {
        runs = runs.filter((run) => run.status === params.status);
      }

      runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

      const total = runs.length;
      const limitedRuns = runs.slice(0, limit);
      const hasMore = total > limit;

      const runCounts = new Map<string, AgentRunCounts>();
      for (const run of limitedRuns) {
        runCounts.set(run.runId, { actions: 0, modelCalls: 0, errors: 0, evaluators: 0 });
      }

      const runIds = limitedRuns.map((run) => run.runId).filter(Boolean);

      if (runIds.length > 0) {
        const db = this.ctx.getDb();
        const runIdArray = sql`array[${sql.join(
          runIds.map((id) => sql`${id}`),
          sql`, `
        )}]::text[]`;

        const actionSummary = await db.execute<ActionSummaryRow>(sql`
          SELECT
            body->>'runId' as "runId",
            COUNT(*)::int as "actions",
            SUM(CASE WHEN COALESCE(body->'result'->>'success', 'true') = 'false' THEN 1 ELSE 0 END)::int as "errors",
            SUM(COALESCE((body->>'promptCount')::int, 0))::int as "modelCalls"
          FROM ${logTable}
          WHERE type = 'action'
            AND body->>'runId' = ANY(${runIdArray})
          GROUP BY body->>'runId'
        `);

        const actionRows = actionSummary.rows ?? [];
        for (const row of actionRows) {
          const counts = runCounts.get(row.runId);
          if (!counts) continue;
          counts.actions += Number(row.actions ?? 0);
          counts.errors += Number(row.errors ?? 0);
          counts.modelCalls += Number(row.modelCalls ?? 0);
        }

        const evaluatorSummary = await db.execute<EvaluatorSummaryRow>(sql`
          SELECT
            body->>'runId' as "runId",
            COUNT(*)::int as "evaluators"
          FROM ${logTable}
          WHERE type = 'evaluator'
            AND body->>'runId' = ANY(${runIdArray})
          GROUP BY body->>'runId'
        `);

        const evaluatorRows = evaluatorSummary.rows ?? [];
        for (const row of evaluatorRows) {
          const counts = runCounts.get(row.runId);
          if (!counts) continue;
          counts.evaluators += Number(row.evaluators ?? 0);
        }

        const genericSummary = await db.execute<GenericSummaryRow>(sql`
          SELECT
            body->>'runId' as "runId",
            COUNT(*) FILTER (WHERE type LIKE 'useModel:%')::int as "modelLogs",
            COUNT(*) FILTER (WHERE type = 'embedding_event' AND body->>'status' = 'failed')::int as "embeddingErrors"
          FROM ${logTable}
          WHERE (type LIKE 'useModel:%' OR type = 'embedding_event')
            AND body->>'runId' = ANY(${runIdArray})
          GROUP BY body->>'runId'
        `);

        const genericRows = genericSummary.rows ?? [];
        for (const row of genericRows) {
          const counts = runCounts.get(row.runId);
          if (!counts) continue;
          counts.modelCalls += Number(row.modelLogs ?? 0);
          counts.errors += Number(row.embeddingErrors ?? 0);
        }
      }

      for (const run of limitedRuns) {
        run.counts = runCounts.get(run.runId) ?? {
          actions: 0,
          modelCalls: 0,
          errors: 0,
          evaluators: 0,
        };
      }

      return {
        runs: limitedRuns,
        total,
        hasMore,
      } satisfies AgentRunSummaryResult;
    });
  }

  async delete(logId: UUID): Promise<void> {
    return this.ctx.withRetry(async () => {
      await this.ctx.getDb().delete(logTable).where(eq(logTable.id, logId));
    }, 'LogStore.delete');
  }
}
