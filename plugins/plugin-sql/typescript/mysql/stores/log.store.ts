import {
  type AgentRunCounts,
  type AgentRunSummary,
  type AgentRunSummaryResult,
  type Log,
  type LogBody,
  logger,
  type RunStatus,
  type UUID,
} from "@elizaos/core";
import { and, desc, eq, gte, inArray, lte, type SQL, sql } from "drizzle-orm";
import { v4 } from "uuid";
import { logTable, roomTable } from "../tables";
import type { DrizzleDatabase } from "../types";

// JSON-serializable value type for metadata
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Sanitizes a JSON object by replacing problematic Unicode escape sequences
 * that could cause errors during JSON serialization/storage.
 *
 * PERF NOTE: This function walks the entire JSON tree, allocating new objects
 * at every level. For high-throughput logging (100+ logs/sec), the allocations
 * can cause GC pressure. Potential optimizations if this becomes a bottleneck:
 *   1. Fast-path: call JSON.stringify() first, then do a single regex pass on
 *      the resulting string. Avoids tree walk entirely for well-formed data.
 *   2. Cache: if the same body is logged repeatedly (e.g. identical action
 *      results), cache the sanitized output keyed by reference identity.
 *   3. Defer: sanitize lazily in the INSERT builder rather than eagerly.
 *
 * @param value - The value to sanitize
 * @param seen - WeakSet to detect circular references
 * @returns The sanitized value
 */
export function sanitizeJsonObject(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    // Handle multiple cases that can cause MySQL JSON parsing errors:
    // 1. Remove null bytes (U+0000) which are not allowed in text fields
    // 2. Escape single backslashes that might be interpreted as escape sequences
    // 3. Fix broken Unicode escape sequences (\u not followed by 4 hex digits)
    //
    // NOTE: Compiling regexes outside the function would avoid re-creation on
    // each call, but V8 already caches literal RegExp in the function scope.
    const nullChar = String.fromCharCode(0);
    const nullCharRegex = new RegExp(nullChar, "g");
    return value
      .replace(nullCharRegex, "") // Remove null bytes
      .replace(/\\(?!["\\/bfnrtu])/g, "\\\\") // Escape single backslashes not part of valid escape sequences
      .replace(/\\u(?![0-9a-fA-F]{4})/g, "\\\\u"); // Fix malformed Unicode escape sequences
  }

  if (typeof value === "object") {
    if (seen.has(value as object)) {
      return null;
    } else {
      seen.add(value as object);
    }

    if (Array.isArray(value)) {
      return value.map((item) => sanitizeJsonObject(item, seen));
    } else {
      const result: Record<string, unknown> = {};
      const nullChar = String.fromCharCode(0);
      const nullCharRegex = new RegExp(nullChar, "g");
      for (const [key, val] of Object.entries(value)) {
        const sanitizedKey =
          typeof key === "string"
            ? key.replace(nullCharRegex, "").replace(/\\u(?![0-9a-fA-F]{4})/g, "\\\\u")
            : key;
        result[sanitizedKey] = sanitizeJsonObject(val, seen);
      }
      return result;
    }
  }

  return value;
}


/**
 * Retrieves logs from the database based on the provided parameters.
 */
export async function getLogs(
  db: DrizzleDatabase,
  params: {
    entityId?: UUID;
    roomId?: UUID;
    type?: string;
    /** @deprecated use limit */
    count?: number;
    limit?: number;
    offset?: number;
  }
): Promise<Log[]> {
  const { entityId, roomId, type, offset } = params;
  const effectiveLimit = params.limit ?? params.count ?? 10;

  // BUG FIX: entityId was accepted but never used as a filter condition.
  const result = await db
    .select()
    .from(logTable)
    .where(
      and(
        entityId ? eq(logTable.entityId, entityId) : undefined,
        roomId ? eq(logTable.roomId, roomId) : undefined,
        type ? eq(logTable.type, type) : undefined
      )
    )
    .orderBy(desc(logTable.createdAt))
    .limit(effectiveLimit)
    .offset(offset ?? 0);

  if (result.length === 0) return [];

  return result.map((log) => ({
    ...log,
    id: log.id as UUID,
    entityId: log.entityId as UUID,
    roomId: log.roomId as UUID,
    type: log.type as string,
    body: log.body as LogBody,
    createdAt: new Date(log.createdAt as string | number | Date),
  }));
}

/**
 * Retrieves agent run summaries from the database.
 * Uses MySQL-specific JSON functions:
 * - JSON_UNQUOTE(JSON_EXTRACT()) instead of ->>
 * - SUM(CASE WHEN ...) instead of COUNT(*) FILTER(WHERE ...)
 * - CAST(... AS SIGNED) for numeric casts
 */
export async function getAgentRunSummaries(
  db: DrizzleDatabase,
  agentId: UUID,
  params: {
    limit?: number;
    roomId?: UUID;
    status?: RunStatus | "all";
    from?: number;
    to?: number;
    entityId?: UUID;
  } = {}
): Promise<AgentRunSummaryResult> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const fromDate = typeof params.from === "number" ? new Date(params.from) : undefined;
  const toDate = typeof params.to === "number" ? new Date(params.to) : undefined;

  const runMap = new Map<string, AgentRunSummary>();

  const conditions: SQL<unknown>[] = [
    eq(logTable.type, "run_event"),
    sql`JSON_CONTAINS_PATH(${logTable.body}, 'one', '$.runId')`,
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

  const runEventRows = await db
    .select({
      runId: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${logTable.body}, '$.runId'))`,
      status: sql<string | null>`JSON_UNQUOTE(JSON_EXTRACT(${logTable.body}, '$.status'))`,
      messageId: sql<string | null>`JSON_UNQUOTE(JSON_EXTRACT(${logTable.body}, '$.messageId'))`,
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
      status: "started",
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
    if (body && typeof body === "object") {
      if (!summary.roomId && typeof body.roomId === "string") {
        summary.roomId = body.roomId as UUID;
      }
      if (!summary.entityId && typeof body.entityId === "string") {
        summary.entityId = body.entityId as UUID;
      }
      if (!summary.messageId && typeof body.messageId === "string") {
        summary.messageId = body.messageId as UUID;
      }
      if (!summary.metadata || Object.keys(summary.metadata).length === 0) {
        const metadata = (body.metadata as Record<string, unknown> | undefined) ?? undefined;
        summary.metadata = metadata ? ({ ...metadata } as Record<string, JsonValue>) : {};
      }
    }

    const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
    const timestamp = createdAt.getTime();
    const bodyStatus = body?.status;
    const eventStatus =
      (row.status as RunStatus | undefined) ?? (bodyStatus as RunStatus | undefined);

    if (eventStatus === "started") {
      const currentStartedAt =
        summary.startedAt === null
          ? null
          : typeof summary.startedAt === "bigint"
            ? Number(summary.startedAt)
            : summary.startedAt;
      summary.startedAt =
        currentStartedAt === null ? timestamp : Math.min(currentStartedAt, timestamp);
    } else if (
      eventStatus === "completed" ||
      eventStatus === "timeout" ||
      eventStatus === "error"
    ) {
      summary.status = eventStatus;
      summary.endedAt = timestamp;
      if (summary.startedAt !== null) {
        const startedAtNum =
          typeof summary.startedAt === "bigint" ? Number(summary.startedAt) : summary.startedAt;
        summary.durationMs = Math.max(timestamp - startedAtNum, 0);
      }
    }

    runMap.set(runId, summary);
  }

  let runs = Array.from(runMap.values());
  if (params.status && params.status !== "all") {
    runs = runs.filter((run) => run.status === params.status);
  }

  runs.sort((a, b) => {
    const aStarted =
      a.startedAt === null
        ? 0
        : typeof a.startedAt === "bigint"
          ? Number(a.startedAt)
          : a.startedAt;
    const bStarted =
      b.startedAt === null
        ? 0
        : typeof b.startedAt === "bigint"
          ? Number(b.startedAt)
          : b.startedAt;
    return bStarted - aStarted;
  });

  const total = runs.length;
  const limitedRuns = runs.slice(0, limit);
  const hasMore = total > limit;

  const runCounts = new Map<string, AgentRunCounts>();
  for (const run of limitedRuns) {
    runCounts.set(run.runId, {
      actions: 0,
      modelCalls: 0,
      errors: 0,
      evaluators: 0,
    });
  }

  const runIds = limitedRuns.map((run) => run.runId).filter(Boolean);

  if (runIds.length > 0) {
    // Merged 3 separate aggregate queries into 1.
    // WHY: the old code ran 3 queries (actions, evaluators, model/embedding)
    // each scanning the log table and grouping by runId. Since they all filter
    // on the same runId set, a single query with SUM(CASE WHEN type=...) does
    // the same work in one pass -- 2 fewer round-trips and 2 fewer table scans.
    const runIdParams = sql.join(runIds.map((id) => sql`${id}`), sql`, `);

    const combinedSummary = await db.execute(sql`
      SELECT
        JSON_UNQUOTE(JSON_EXTRACT(body, '$.runId')) as runId,
        CAST(SUM(CASE WHEN type = 'action' THEN 1 ELSE 0 END) AS SIGNED) as actions,
        CAST(SUM(CASE WHEN type = 'action'
          AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(JSON_EXTRACT(body, '$.result'), '$.success')), 'true') = 'false'
          THEN 1 ELSE 0 END) AS SIGNED) as actionErrors,
        CAST(SUM(CASE WHEN type = 'action'
          THEN COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(body, '$.promptCount')) AS SIGNED), 0)
          ELSE 0 END) AS SIGNED) as actionModelCalls,
        CAST(SUM(CASE WHEN type = 'evaluator' THEN 1 ELSE 0 END) AS SIGNED) as evaluators,
        CAST(SUM(CASE WHEN type LIKE 'useModel:%' THEN 1 ELSE 0 END) AS SIGNED) as modelLogs,
        CAST(SUM(CASE WHEN type = 'embedding_event'
          AND JSON_UNQUOTE(JSON_EXTRACT(body, '$.status')) = 'failed'
          THEN 1 ELSE 0 END) AS SIGNED) as embeddingErrors
      FROM ${logTable}
      WHERE (type = 'action' OR type = 'evaluator' OR type LIKE 'useModel:%' OR type = 'embedding_event')
        AND JSON_UNQUOTE(JSON_EXTRACT(body, '$.runId')) IN (${runIdParams})
      GROUP BY JSON_UNQUOTE(JSON_EXTRACT(body, '$.runId'))
    `);

    const rows = (Array.isArray(combinedSummary) ? combinedSummary[0] : []) as unknown as Array<{
      runId: string;
      actions: number | string;
      actionErrors: number | string;
      actionModelCalls: number | string;
      evaluators: number | string;
      modelLogs: number | string;
      embeddingErrors: number | string;
    }>;

    for (const row of rows) {
      const counts = runCounts.get(row.runId);
      if (!counts) continue;
      counts.actions += Number(row.actions ?? 0);
      counts.errors += Number(row.actionErrors ?? 0) + Number(row.embeddingErrors ?? 0);
      counts.modelCalls += Number(row.actionModelCalls ?? 0) + Number(row.modelLogs ?? 0);
      counts.evaluators += Number(row.evaluators ?? 0);
    }
  }

  for (const run of limitedRuns) {
    const counts = runCounts.get(run.runId) ?? {
      actions: 0,
      modelCalls: 0,
      errors: 0,
      evaluators: 0,
    };
    // Cast through unknown to bridge the core type (without $typeName) to proto type (with $typeName)
    run.counts = counts as unknown as typeof run.counts;
  }

  return {
    runs: limitedRuns as unknown as AgentRunSummary[],
    total,
    hasMore,
  } as AgentRunSummaryResult;
}

// Batch log operations

/**
 * Get logs by their IDs (batch) - MySQL version
 * 
 * WHY: Same rationale as PostgreSQL - batch lookup for debugging/history.
 * 
 * @param {DrizzleDatabase} db - The database instance
 * @param {UUID[]} logIds - Array of log IDs to retrieve
 * @returns {Promise<Log[]>} Array of logs (only found logs returned)
 */
export async function getLogsByIds(db: DrizzleDatabase, logIds: UUID[]): Promise<Log[]> {
  if (logIds.length === 0) return [];

  const result = await db
    .select()
    .from(logTable)
    .where(inArray(logTable.id, logIds));

  return result.map((log) => ({
    ...log,
    id: log.id as UUID,
    entityId: log.entityId as UUID,
    roomId: log.roomId as UUID,
    type: log.type as string,
    body: log.body as LogBody,
    createdAt: new Date(log.createdAt as string | number | Date),
  }));
}

/**
 * Creates multiple log entries in the database.
 */
export async function createLogs(
  db: DrizzleDatabase,
  params: Array<{ body: LogBody; entityId: UUID; roomId: UUID; type: string }>
): Promise<void> {
  if (params.length === 0) return;

  try {
    const values = params.map((param) => {
      const sanitizedBody = sanitizeJsonObject(param.body);
      const jsonString = JSON.stringify(sanitizedBody);
      return {
        body: sql`CAST(${jsonString} AS JSON)`,
        entityId: param.entityId,
        roomId: param.roomId,
        type: param.type,
      };
    });

    await db.insert(logTable).values(values);
  } catch (error) {
    logger.error(
      {
        src: "plugin:sql",
        count: params.length,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to create batch log entries"
    );
    throw error;
  }
}

/**
 * Update logs (batch) - MySQL version
 * 
 * WHY: Same rationale as PostgreSQL - run status updates as runs progress.
 * 
 * WHY CASE expression: MySQL supports batch updates with CASE, similar to PG.
 * 
 * @param {DrizzleDatabase} db - The database instance
 * @param {Array<{ id: UUID; updates: Partial<Log> }>} logs - Array of log updates
 */
export async function updateLogs(
  db: DrizzleDatabase,
  logs: Array<{ id: UUID; updates: Partial<Log> }>
): Promise<void> {
  if (logs.length === 0) return;

  const idArray = logs.map(l => l.id);
  
  const hasBodyUpdates = logs.some(l => l.updates.body !== undefined);
  const hasTypeUpdates = logs.some(l => l.updates.type !== undefined);
  
  const setClauses: SQL<unknown>[] = [];
  
  if (hasBodyUpdates) {
    const bodyCases = logs
      .filter(l => l.updates.body !== undefined)
      .map(l => {
        const sanitizedBody = sanitizeJsonObject(l.updates.body);
        const jsonString = JSON.stringify(sanitizedBody);
        return sql`WHEN ${logTable.id} = ${l.id} THEN CAST(${jsonString} AS JSON)`;
      });
    
    if (bodyCases.length > 0) {
      setClauses.push(sql`body = CASE ${sql.join(bodyCases, sql` `)} ELSE body END`);
    }
  }
  
  if (hasTypeUpdates) {
    const typeCases = logs
      .filter(l => l.updates.type !== undefined)
      .map(l => sql`WHEN ${logTable.id} = ${l.id} THEN ${l.updates.type}`);
    
    if (typeCases.length > 0) {
      setClauses.push(sql`type = CASE ${sql.join(typeCases, sql` `)} ELSE type END`);
    }
  }
  
  if (setClauses.length === 0) return;
  
  await db.execute(sql`
    UPDATE ${logTable}
    SET ${sql.join(setClauses, sql`, `)}
    WHERE ${logTable.id} IN (${sql.join(idArray.map(id => sql`${id}`), sql`, `)})
  `);
}

/**
 * Deletes multiple logs from the database.
 */
export async function deleteLogs(db: DrizzleDatabase, logIds: UUID[]): Promise<void> {
  if (logIds.length === 0) return;

  await db.delete(logTable).where(inArray(logTable.id, logIds));
}
