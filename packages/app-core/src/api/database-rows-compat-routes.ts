import type http from "node:http";
import {
  executeRawSql,
  quoteIdent,
  sanitizeIdentifier,
  sqlLiteral,
} from "@elizaos/shared";
import { ensureRouteMinRole } from "./auth.ts";
import {
  type CompatRuntimeState,
  DATABASE_UNAVAILABLE_MESSAGE,
} from "./compat-route-shared";
import { recordCacheHit, recordCacheMiss } from "./perf-instrument";
import {
  sendJsonError as sendJsonErrorResponse,
  sendJson as sendJsonResponse,
} from "./response";

interface TableIntrospection {
  resolvedSchema: string;
  columns: string[];
  expiresAt: number;
}

interface DatabaseRowsCompatRouteDeps {
  ensureOwner?: typeof ensureRouteMinRole;
}

// Resolved schema + column list for a (schema, table) — stable unless a
// migration alters the table. Caching it skips the two information_schema
// lookups on every table-browser request (the count + rows queries still run).
// Short TTL bounds staleness if a table changes at runtime; bounded size.
const tableIntrospectionCache = new Map<string, TableIntrospection>();
const TABLE_INTROSPECTION_TTL_MS = 30_000;
const TABLE_INTROSPECTION_CACHE_LIMIT = 256;

function rememberTableIntrospection(
  key: string,
  resolvedSchema: string,
  columns: string[],
  nowMs: number,
): void {
  tableIntrospectionCache.set(key, {
    resolvedSchema,
    columns,
    expiresAt: nowMs + TABLE_INTROSPECTION_TTL_MS,
  });
  if (tableIntrospectionCache.size > TABLE_INTROSPECTION_CACHE_LIMIT) {
    const oldest = tableIntrospectionCache.keys().next().value;
    if (typeof oldest === "string") {
      tableIntrospectionCache.delete(oldest);
    }
  }
}

export async function handleDatabaseRowsCompatRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
  deps: DatabaseRowsCompatRouteDeps = {},
): Promise<boolean> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const match = /^\/api\/database\/tables\/([^/]+)\/rows$/.exec(pathname);
  if ((req.method ?? "GET").toUpperCase() !== "GET" || !match) {
    return false;
  }

  const ensureOwner = deps.ensureOwner ?? ensureRouteMinRole;
  // Raw table reads expose arbitrary tables (secrets, sessions, identities),
  // so this must require OWNER - matching the sibling `/api/secrets/*` routes -
  // rather than accepting any active session.
  if (!(await ensureOwner(req, res, state, "OWNER"))) {
    return true;
  }

  const runtime = state.current;
  if (!runtime) {
    sendJsonErrorResponse(res, 503, DATABASE_UNAVAILABLE_MESSAGE);
    return true;
  }

  const tableName = sanitizeIdentifier(decodeURIComponent(match[1]));
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const schemaName = sanitizeIdentifier(requestUrl.searchParams.get("schema"));

  if (!tableName) {
    sendJsonErrorResponse(res, 400, "Invalid table name");
    return true;
  }

  const schemaParam = schemaName ?? "";
  const introspectionKey = `${schemaParam}:${tableName}`;
  const nowMs = Date.now();
  const cachedIntrospection = tableIntrospectionCache.get(introspectionKey);

  let resolvedSchema: string;
  let columns: string[];

  if (cachedIntrospection && cachedIntrospection.expiresAt > nowMs) {
    recordCacheHit("db-rows-introspection");
    resolvedSchema = cachedIntrospection.resolvedSchema;
    columns = cachedIntrospection.columns;
  } else {
    recordCacheMiss("db-rows-introspection");
    resolvedSchema = schemaParam;

    if (!resolvedSchema) {
      const { rows } = await executeRawSql(
        runtime,
        `SELECT table_schema AS schema
           FROM information_schema.tables
          WHERE table_name = ${sqlLiteral(tableName)}
            AND table_schema NOT IN ('pg_catalog', 'information_schema')
            AND table_type = 'BASE TABLE'
          ORDER BY CASE WHEN table_schema = 'public' THEN 0 ELSE 1 END,
                   table_schema`,
      );

      const schemas = rows
        .map((row) => row.schema)
        .filter((value): value is string => typeof value === "string");

      if (schemas.length === 0) {
        sendJsonErrorResponse(res, 404, `Unknown table "${tableName}"`);
        return true;
      }

      if (schemas.length > 1 && !schemas.includes("public")) {
        sendJsonErrorResponse(
          res,
          409,
          `Table "${tableName}" exists in multiple schemas; specify ?schema=<name>.`,
        );
        return true;
      }

      resolvedSchema = schemas.includes("public") ? "public" : schemas[0];
    }

    const columnResult = await executeRawSql(
      runtime,
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = ${sqlLiteral(tableName)}
          AND table_schema = ${sqlLiteral(resolvedSchema)}
        ORDER BY ordinal_position`,
    );

    columns = columnResult.rows
      .map((row) => row.column_name)
      .filter((value): value is string => typeof value === "string");

    if (columns.length === 0) {
      sendJsonErrorResponse(
        res,
        404,
        `No readable columns found for ${resolvedSchema}.${tableName}`,
      );
      return true;
    }

    // Only successful introspection is cached (never 404/409) — a table that
    // appears later must not be shadowed by a negative entry.
    rememberTableIntrospection(
      introspectionKey,
      resolvedSchema,
      columns,
      nowMs,
    );
  }

  const limit = Math.max(
    1,
    Math.min(
      500,
      Number.parseInt(requestUrl.searchParams.get("limit") ?? "", 10) || 50,
    ),
  );
  const offset = Math.max(
    0,
    Number.parseInt(requestUrl.searchParams.get("offset") ?? "", 10) || 0,
  );
  const sortColumn = sanitizeIdentifier(requestUrl.searchParams.get("sort"));
  const order =
    requestUrl.searchParams.get("order") === "desc" ? "DESC" : "ASC";
  const search = requestUrl.searchParams.get("search")?.trim();

  const filters: string[] = [];
  if (search) {
    const likeEscaped = search
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
    const searchLiteral = sqlLiteral(`%${likeEscaped}%`);
    filters.push(
      `(${columns
        .map(
          (columnName) =>
            `CAST(${quoteIdent(columnName)} AS TEXT) ILIKE ${searchLiteral}`,
        )
        .join(" OR ")})`,
    );
  }
  const whereClause =
    filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

  const orderBy =
    sortColumn && columns.includes(sortColumn)
      ? `ORDER BY ${quoteIdent(sortColumn)} ${order}`
      : "";
  const qualifiedTable = `${quoteIdent(resolvedSchema)}.${quoteIdent(tableName)}`;

  const countResult = await executeRawSql(
    runtime,
    `SELECT count(*)::int AS total FROM ${qualifiedTable} ${whereClause}`,
  );
  const total =
    typeof countResult.rows[0]?.total === "number"
      ? countResult.rows[0].total
      : Number(countResult.rows[0]?.total ?? 0);

  const rowsResult = await executeRawSql(
    runtime,
    `SELECT * FROM ${qualifiedTable}
      ${whereClause}
      ${orderBy}
      LIMIT ${limit}
     OFFSET ${offset}`,
  );

  sendJsonResponse(res, 200, {
    table: tableName,
    schema: resolvedSchema,
    rows: rowsResult.rows,
    columns,
    total,
    offset,
    limit,
  });
  return true;
}
