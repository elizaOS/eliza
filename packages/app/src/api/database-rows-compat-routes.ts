/**
 * Mounts GET `/api/database/tables/:name/rows` — the dashboard table browser's
 * raw-row read. Requires OWNER (raw reads can expose secrets/sessions/identity
 * tables), then introspects the table's schema and column list (cached with a
 * short TTL and bounded size), resolving an ambiguous unqualified name to
 * `public` where possible. Returns a paginated, searchable (ILIKE across all
 * columns), sortable page plus an exact `count(*)`; identifiers are sanitized
 * and quoted and literals escaped for the raw SQL. A count that cannot be parsed
 * raises a typed `DB_COUNT_UNAVAILABLE` rather than fabricating zero.
 */
import type http from "node:http";
import { ElizaError } from "@elizaos/core";
import {
  executeRawSql,
  quoteIdent,
  sanitizeIdentifier,
  sqlLiteral,
} from "@elizaos/plugin-sql";
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
  primaryKey: string[];
  expiresAt: number;
}
interface DatabaseRowsCompatRouteDeps {
  ensureOwner?: typeof ensureRouteMinRole;
}
// Resolved schema + column list for a (schema, table) — stable unless a
// migration alters the table. Caching it skips the two information_schema
// lookups on every table-browser request (the count + rows queries still run).
// Short TTL bounds staleness if a table changes at runtime; bounded size.
const runtimeIntrospectionCaches = new WeakMap<
  NonNullable<CompatRuntimeState["current"]>,
  Map<string, TableIntrospection>
>();
const TABLE_INTROSPECTION_TTL_MS = 30000;
const TABLE_INTROSPECTION_CACHE_LIMIT = 256;
/**
 * Parse the untrusted `limit` query. Defaults to 50 and caps canonical
 * positive decimal integers at 500. Prefix-numeric junk must not become a
 * different OWNER page size (`1e2` → 1 via parseInt).
 */
function parseDatabaseRowsLimit(raw: string | null): number | null {
  if (raw === null || raw === "") return 50;
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return null;
  return Math.min(parsed, 500);
}
/**
 * Parse the untrusted `offset` query. Defaults to 0. Reject leading zeros,
 * signs, hex, scientific notation, and other parseInt prefix forms.
 */
function parseDatabaseRowsOffset(raw: string | null): number | null {
  if (raw === null || raw === "") return 0;
  if (!/^(0|[1-9]\d*)$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
}
/** Decode an untrusted database table-name path segment. */
function decodeTableName(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    // error-policy:J3 Malformed URL encoding is invalid path input.
    return null;
  }
}
function rememberTableIntrospection(
  cache: Map<string, TableIntrospection>,
  key: string,
  resolvedSchema: string,
  columns: string[],
  primaryKey: string[],
  nowMs: number,
): void {
  cache.set(key, {
    resolvedSchema,
    columns,
    primaryKey,
    expiresAt: nowMs + TABLE_INTROSPECTION_TTL_MS,
  });
  if (cache.size > TABLE_INTROSPECTION_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (typeof oldest === "string") {
      cache.delete(oldest);
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
  const decoded = decodeTableName(match[1] ?? "");
  if (decoded === null) {
    sendJsonErrorResponse(
      res,
      400,
      "invalid table name: malformed URL encoding",
    );
    return true;
  }
  const runtime = state.current;
  if (!runtime) {
    sendJsonErrorResponse(res, 503, DATABASE_UNAVAILABLE_MESSAGE);
    return true;
  }
  const tableName = sanitizeIdentifier(decoded);
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const schemaName = sanitizeIdentifier(requestUrl.searchParams.get("schema"));
  if (!tableName) {
    sendJsonErrorResponse(res, 400, "Invalid table name");
    return true;
  }
  const limit = parseDatabaseRowsLimit(requestUrl.searchParams.get("limit"));
  const offset = parseDatabaseRowsOffset(requestUrl.searchParams.get("offset"));
  if (limit === null) {
    sendJsonErrorResponse(res, 400, "limit must be a positive integer");
    return true;
  }
  if (offset === null) {
    sendJsonErrorResponse(res, 400, "offset must be a non-negative integer");
    return true;
  }
  const schemaParam = schemaName ?? "";
  const introspectionKey = `${schemaParam}:${tableName}`;
  const nowMs = Date.now();
  let tableIntrospectionCache = runtimeIntrospectionCaches.get(runtime);
  if (!tableIntrospectionCache) {
    tableIntrospectionCache = new Map();
    runtimeIntrospectionCaches.set(runtime, tableIntrospectionCache);
  }
  const cachedIntrospection = tableIntrospectionCache.get(introspectionKey);
  let resolvedSchema: string;
  let columns: string[];
  let primaryKey: string[];
  if (cachedIntrospection && cachedIntrospection.expiresAt > nowMs) {
    recordCacheHit("db-rows-introspection");
    resolvedSchema = cachedIntrospection.resolvedSchema;
    columns = cachedIntrospection.columns;
    primaryKey = cachedIntrospection.primaryKey;
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
      `SELECT c.column_name,
              EXISTS (
                SELECT 1 FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema = kcu.table_schema
                 AND tc.table_name = kcu.table_name
                WHERE tc.constraint_type = 'PRIMARY KEY'
                  AND tc.table_schema = c.table_schema
                  AND tc.table_name = c.table_name
                  AND kcu.column_name = c.column_name
              ) AS is_primary_key
         FROM information_schema.columns c
        WHERE c.table_name = ${sqlLiteral(tableName)}
          AND c.table_schema = ${sqlLiteral(resolvedSchema)}
        ORDER BY c.ordinal_position`,
    );
    columns = columnResult.rows
      .map((row) => row.column_name)
      .filter((value): value is string => typeof value === "string");
    primaryKey = columnResult.rows
      .filter((row) => row.is_primary_key === true)
      .map((row) => String(row.column_name));
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
      tableIntrospectionCache,
      introspectionKey,
      resolvedSchema,
      columns,
      primaryKey,
      nowMs,
    );
  }
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
  // Match the agent rows endpoint: all primary-key columns break sort ties.
  // Without a key, physical row IDs provide total order only while rows stay
  // unchanged; this is not a snapshot across concurrent writes or VACUUM FULL.
  const validSort =
    sortColumn && columns.includes(sortColumn) ? sortColumn : "";
  const tieBreak = primaryKey.length
    ? primaryKey.map(quoteIdent)
    : ["tableoid", "ctid"];
  const orderTerms = [
    ...(validSort ? [quoteIdent(validSort)] : []),
    ...tieBreak.filter((term) => !validSort || term !== quoteIdent(validSort)),
  ].map((term) => `${term} ${order}`);
  const orderBy = `ORDER BY ${orderTerms.join(", ")}`;
  const qualifiedTable = `${quoteIdent(resolvedSchema)}.${quoteIdent(tableName)}`;
  const countResult = await executeRawSql(
    runtime,
    `SELECT count(*)::int AS total FROM ${qualifiedTable} ${whereClause}`,
  );
  const rawTotal = countResult.rows[0]?.total;
  const total =
    typeof rawTotal === "number"
      ? rawTotal
      : typeof rawTotal === "string" && /^(0|[1-9]\d*)$/.test(rawTotal)
        ? Number(rawTotal)
        : Number.NaN;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new ElizaError("Database row count is unavailable.", {
      code: "DB_COUNT_UNAVAILABLE",
      context: { table: qualifiedTable },
      severity: "ephemeral",
    });
  }
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
