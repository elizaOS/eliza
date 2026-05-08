/**
 * Polymorphic DATABASE action.
 *
 * Single action that dispatches across the database introspection ops:
 *   - list_tables    : enumerate user tables with row counts and columns.
 *   - get_table      : page rows from a specific table (limit/offset/sort).
 *   - query          : execute raw SQL (read-only by default).
 *   - search_vectors : embed text and return top-k semantic memory matches.
 *
 * All ops talk directly to the in-process runtime adapter (Drizzle ORM via
 * `runtime.adapter.db`) and `runtime.searchMemories` / `runtime.useModel`.
 * No HTTP. The previous LIST_DATABASE_TABLES / GET_TABLE_DATA /
 * EXECUTE_DATABASE_QUERY / SEARCH_VECTORS actions hit /api/database/* — that
 * server route layer is still used by the dashboard UI but is now bypassed
 * for the agent's own tool surface.
 */

import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  SearchCategoryRegistration,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";

// ---------------------------------------------------------------------------
// Op dispatch
// ---------------------------------------------------------------------------

const DATABASE_OPS = [
  "list_tables",
  "get_table",
  "query",
  "search_vectors",
] as const;
type DatabaseOp = (typeof DATABASE_OPS)[number];

interface DatabaseParams {
  op?: DatabaseOp;
  // list_tables
  filter?: string;
  includeEmpty?: boolean;
  // get_table
  tableName?: string;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  // query
  sql?: string;
  allowWrites?: boolean;
  // search_vectors
  query?: string;
  table?: string;
  threshold?: number;
}

function isDatabaseOp(value: unknown): value is DatabaseOp {
  return (
    typeof value === "string" &&
    (DATABASE_OPS as readonly string[]).includes(value)
  );
}

function getParams(options: unknown): DatabaseParams {
  const opts = options as HandlerOptions | undefined;
  return (opts?.parameters as DatabaseParams | undefined) ?? {};
}

// ---------------------------------------------------------------------------
// Drizzle adapter access
// ---------------------------------------------------------------------------

interface DrizzleSqlHelper {
  raw: (query: string) => { queryChunks: unknown[] };
}

interface RawExecuteResult {
  rows: Record<string, unknown>[];
  fields?: Array<{ name: string }>;
}

interface DrizzleDb {
  execute(query: { queryChunks: unknown[] }): Promise<RawExecuteResult>;
}

let cachedSqlHelper: DrizzleSqlHelper | null = null;

async function getDrizzleSql(): Promise<DrizzleSqlHelper> {
  if (cachedSqlHelper) return cachedSqlHelper;
  const drizzle = (await import("drizzle-orm")) as { sql: DrizzleSqlHelper };
  cachedSqlHelper = drizzle.sql;
  return cachedSqlHelper;
}

function isQueryRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function executeRawSql(
  runtime: IAgentRuntime,
  sqlText: string,
): Promise<{ rows: Record<string, unknown>[]; columns: string[] }> {
  const sql = await getDrizzleSql();
  const db = (runtime.adapter as unknown as { db: DrizzleDb }).db;
  const result = await db.execute(sql.raw(sqlText));
  const rows = Array.isArray(result.rows) ? result.rows.filter(isQueryRow) : [];
  const columns =
    result.fields?.map((f) => f.name) ??
    (rows.length > 0 ? Object.keys(rows[0]) : []);
  return { rows, columns };
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// Read-only SQL guard (mirrors the server-side allowlist in api/database.ts).
// Strips comments, dollar-quoted strings, single-/double-quoted strings, then
// looks for mutation keywords or dangerous functions anywhere in the query.
// ---------------------------------------------------------------------------

const MUTATION_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "INTO",
  "COPY",
  "MERGE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "CREATE",
  "COMMENT",
  "GRANT",
  "REVOKE",
  "SET",
  "RESET",
  "LOAD",
  "VACUUM",
  "REINDEX",
  "CLUSTER",
  "REFRESH",
  "DISCARD",
  "CALL",
  "DO",
  "LISTEN",
  "UNLISTEN",
  "NOTIFY",
  "PREPARE",
  "EXECUTE",
  "DEALLOCATE",
  "LOCK",
];

const DANGEROUS_FUNCTIONS = [
  "lo_import",
  "lo_export",
  "lo_unlink",
  "lo_put",
  "lo_from_bytea",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_write_file",
  "pg_stat_file",
  "pg_ls_dir",
  "pg_ls_logdir",
  "pg_ls_waldir",
  "pg_ls_tmpdir",
  "pg_ls_archive_statusdir",
  "nextval",
  "setval",
  "pg_sleep",
  "pg_sleep_for",
  "pg_sleep_until",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "set_config",
  "pg_advisory_lock",
  "pg_advisory_lock_shared",
  "pg_try_advisory_lock",
  "pg_try_advisory_lock_shared",
  "pg_advisory_xact_lock",
  "pg_advisory_xact_lock_shared",
  "pg_advisory_unlock",
  "pg_advisory_unlock_shared",
  "pg_advisory_unlock_all",
];

function checkReadOnly(
  sqlText: string,
): { ok: true } | { ok: false; reason: string } {
  const stripped = sqlText
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "")
    .trim();
  const noLiterals = stripped
    .replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, " ")
    .replace(/'(?:[^']|'')*'/g, " ");
  const noStrings = noLiterals.replace(/"(?:[^"]|"")*"/g, " ");

  const mutation = new RegExp(
    `\\b(${MUTATION_KEYWORDS.join("|")})\\b`,
    "i",
  ).exec(noStrings);
  if (mutation) {
    return {
      ok: false,
      reason: `"${mutation[1].toUpperCase()}" is a mutation keyword. Set allowWrites:true to execute mutations.`,
    };
  }

  const fn = new RegExp(
    `(?:^|[^\\w$])"?(?:${DANGEROUS_FUNCTIONS.join("|")})"?\\s*\\(`,
    "i",
  ).exec(noLiterals);
  if (fn) {
    const name = new RegExp(`(${DANGEROUS_FUNCTIONS.join("|")})`, "i").exec(
      fn[0],
    );
    return {
      ok: false,
      reason: `"${(name?.[1] ?? "UNKNOWN").toUpperCase()}" is a dangerous function. Set allowWrites:true to execute.`,
    };
  }

  if (stripped.replace(/;\s*$/, "").includes(";")) {
    return {
      ok: false,
      reason: "Multi-statement queries are not allowed in read-only mode.",
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Vector search category (kept as a separate runtime registration so the
// unified search surface in web-search.ts can route to vectors).
// ---------------------------------------------------------------------------

const VECTOR_SEARCH_DEFAULT_LIMIT = 10;
const VECTOR_SEARCH_MAX_LIMIT = 100;
const VECTOR_SEARCH_DEFAULT_TABLE = "messages";
const VECTOR_SEARCH_ALLOWED_TABLES = new Set<string>([
  "messages",
  "memories",
  "facts",
  "documents",
  "document_fragments",
]);

const VECTOR_SEARCH_CATEGORY: SearchCategoryRegistration = {
  category: "vectors",
  label: "Vector store",
  description: "Search semantically similar memory/vector rows.",
  contexts: ["admin", "documents"],
  filters: [
    {
      name: "table",
      label: "Table",
      description:
        "Memory table to search. One of: messages, memories, facts, documents, document_fragments.",
      type: "enum",
      options: [...VECTOR_SEARCH_ALLOWED_TABLES].map((value) => ({
        label: value,
        value,
      })),
    },
    {
      name: "threshold",
      label: "Threshold",
      description: "Minimum similarity threshold from 0 to 1.",
      type: "number",
    },
  ],
  resultSchemaSummary:
    "VectorSearchHit[] with id, text, similarity, roomId, entityId, createdAt, and tableName.",
  capabilities: ["semantic", "embeddings", "database"],
  source: "agent:database",
};

function hasSearchCategory(runtime: IAgentRuntime, category: string): boolean {
  try {
    runtime.getSearchCategory(category, { includeDisabled: true });
    return true;
  } catch {
    return false;
  }
}

export function registerVectorSearchCategory(runtime: IAgentRuntime): void {
  if (!hasSearchCategory(runtime, VECTOR_SEARCH_CATEGORY.category)) {
    runtime.registerSearchCategory(VECTOR_SEARCH_CATEGORY);
  }
}

// ---------------------------------------------------------------------------
// Op handlers
// ---------------------------------------------------------------------------

interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
}

interface TableInfo {
  name: string;
  schema: string;
  rowCount: number;
  columns: ColumnInfo[];
}

async function opListTables(
  runtime: IAgentRuntime,
  params: DatabaseParams,
): Promise<ActionResult> {
  const tablesResult = await executeRawSql(
    runtime,
    `SELECT
       t.table_schema AS schema,
       t.table_name AS name,
       COALESCE(s.n_live_tup, 0) AS row_count
     FROM information_schema.tables t
     LEFT JOIN pg_stat_user_tables s
       ON s.schemaname = t.table_schema
       AND s.relname = t.table_name
     WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
       AND t.table_type = 'BASE TABLE'
     ORDER BY t.table_schema, t.table_name`,
  );
  const columnsResult = await executeRawSql(
    runtime,
    `SELECT
       c.table_schema AS schema,
       c.table_name AS table_name,
       c.column_name AS name,
       c.data_type AS type,
       (c.is_nullable = 'YES') AS nullable,
       c.column_default AS default_value,
       COALESCE(
         (SELECT true
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_schema = c.table_schema
            AND tc.table_name = c.table_name
            AND kcu.column_name = c.column_name),
         false
       ) AS is_primary_key
     FROM information_schema.columns c
     WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
     ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
  );

  const columnsByTable = new Map<string, ColumnInfo[]>();
  for (const row of columnsResult.rows) {
    const key = `${String(row.schema)}.${String(row.table_name)}`;
    const cols = columnsByTable.get(key) ?? [];
    cols.push({
      name: String(row.name),
      type: String(row.type),
      nullable: Boolean(row.nullable),
      defaultValue:
        row.default_value != null ? String(row.default_value) : null,
      isPrimaryKey: Boolean(row.is_primary_key),
    });
    columnsByTable.set(key, cols);
  }

  const allTables: TableInfo[] = tablesResult.rows.map((row) => {
    const key = `${String(row.schema)}.${String(row.name)}`;
    return {
      name: String(row.name),
      schema: String(row.schema),
      rowCount: Number(row.row_count ?? 0),
      columns: columnsByTable.get(key) ?? [],
    };
  });

  const filter = params.filter?.trim().toLowerCase() ?? "";
  const includeEmpty = params.includeEmpty ?? true;
  const tables = allTables.filter((table) => {
    if (filter && !table.name.toLowerCase().includes(filter)) return false;
    if (!includeEmpty && table.rowCount === 0) return false;
    return true;
  });

  const lines = tables.map(
    (t) => `- ${t.name} (${t.columns.length} cols, ${t.rowCount} rows)`,
  );
  return {
    success: true,
    text: lines.length
      ? `Found ${tables.length} table(s):\n${lines.join("\n")}`
      : "No tables found.",
    values: { count: tables.length },
    data: { actionName: "DATABASE", op: "list_tables", tables, filter },
  };
}

async function opGetTable(
  runtime: IAgentRuntime,
  params: DatabaseParams,
): Promise<ActionResult> {
  const tableName = params.tableName?.trim();
  if (!tableName) {
    return {
      success: false,
      text: "tableName is required for op:get_table.",
      values: { error: "DATABASE_GET_TABLE_FAILED", reason: "MISSING_TABLE" },
    };
  }

  const safe = tableName.replace(/'/g, "''");
  const exists = await executeRawSql(
    runtime,
    `SELECT 1 FROM information_schema.tables
     WHERE table_name = '${safe}'
       AND table_schema NOT IN ('pg_catalog', 'information_schema')
       AND table_type = 'BASE TABLE'
     LIMIT 1`,
  );
  if (exists.rows.length === 0) {
    return {
      success: false,
      text: `Table "${tableName}" not found.`,
      values: { error: "DATABASE_GET_TABLE_FAILED", reason: "TABLE_NOT_FOUND" },
    };
  }

  const limit = Math.min(500, Math.max(1, Math.floor(params.limit ?? 50)));
  const offset = Math.max(0, Math.floor(params.offset ?? 0));
  const sortDir = params.sortDir === "desc" ? "DESC" : "ASC";

  let validSort = "";
  if (params.sortBy) {
    const cols = await executeRawSql(
      runtime,
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = '${safe}'
         AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
    );
    if (cols.rows.some((r) => String(r.column_name) === params.sortBy)) {
      validSort = params.sortBy;
    }
  }
  const orderClause = validSort
    ? `ORDER BY ${quoteIdent(validSort)} ${sortDir}`
    : "";

  const countResult = await executeRawSql(
    runtime,
    `SELECT count(*) AS total FROM ${quoteIdent(tableName)}`,
  );
  const total = Number(countResult.rows[0]?.total ?? 0);

  const result = await executeRawSql(
    runtime,
    `SELECT * FROM ${quoteIdent(tableName)} ${orderClause} LIMIT ${limit} OFFSET ${offset}`,
  );

  return {
    success: true,
    text: `Returned ${result.rows.length} row(s) from "${tableName}" (total: ${total}).`,
    values: { rowCount: result.rows.length, total },
    data: {
      actionName: "DATABASE",
      op: "get_table",
      tableName,
      rows: result.rows,
      columns: result.columns,
      total,
      offset,
      limit,
    },
  };
}

async function opQuery(
  runtime: IAgentRuntime,
  params: DatabaseParams,
): Promise<ActionResult> {
  const sqlText = params.sql?.trim();
  if (!sqlText) {
    return {
      success: false,
      text: "sql is required for op:query.",
      values: { error: "DATABASE_QUERY_FAILED", reason: "MISSING_SQL" },
    };
  }

  const allowWrites = params.allowWrites === true;
  if (!allowWrites) {
    const guard = checkReadOnly(sqlText);
    if (!guard.ok) {
      const reason = "reason" in guard ? guard.reason : "not read-only";
      return {
        success: false,
        text: `Query rejected: ${reason}`,
        values: { error: "DATABASE_QUERY_FAILED", reason: "MUTATION_BLOCKED" },
        data: { actionName: "DATABASE", op: "query" },
      };
    }
  }

  const start = Date.now();
  const result = await executeRawSql(runtime, sqlText);
  const durationMs = Date.now() - start;

  return {
    success: true,
    text: `Query returned ${result.rows.length} row(s) in ${durationMs}ms.`,
    values: { rowCount: result.rows.length, allowWrites, durationMs },
    data: {
      actionName: "DATABASE",
      op: "query",
      result: {
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rows.length,
        durationMs,
      },
    },
  };
}

interface VectorSearchHit {
  id: string | null;
  text: string;
  similarity: number | null;
  roomId: string | null;
  entityId: string | null;
  createdAt: number | null;
  tableName: string;
}

async function opSearchVectors(
  runtime: IAgentRuntime,
  params: DatabaseParams,
): Promise<ActionResult> {
  registerVectorSearchCategory(runtime);

  const query = params.query?.trim();
  if (!query) {
    return {
      success: false,
      text: "query is required for op:search_vectors.",
      values: {
        error: "DATABASE_SEARCH_VECTORS_FAILED",
        reason: "MISSING_QUERY",
      },
    };
  }

  const table = params.table?.trim() || VECTOR_SEARCH_DEFAULT_TABLE;
  if (!VECTOR_SEARCH_ALLOWED_TABLES.has(table)) {
    return {
      success: false,
      text: `table "${table}" is not searchable. Allowed: ${[...VECTOR_SEARCH_ALLOWED_TABLES].join(", ")}.`,
      values: {
        error: "DATABASE_SEARCH_VECTORS_FAILED",
        reason: "TABLE_NOT_ALLOWED",
      },
    };
  }
  const limit = Math.min(
    VECTOR_SEARCH_MAX_LIMIT,
    Math.max(1, Math.floor(params.limit ?? VECTOR_SEARCH_DEFAULT_LIMIT)),
  );

  const embeddingResult = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
    text: query,
  });
  const embedding = Array.isArray(embeddingResult)
    ? (embeddingResult as number[])
    : ((embeddingResult as { embedding?: number[] } | null)?.embedding ?? null);

  if (!embedding || embedding.length === 0) {
    return {
      success: false,
      text: "Embedding model returned no vector.",
      values: {
        error: "DATABASE_SEARCH_VECTORS_FAILED",
        reason: "NO_EMBEDDING",
      },
    };
  }

  const matches: Memory[] = await runtime.searchMemories({
    embedding,
    query,
    tableName: table,
    limit,
    ...(typeof params.threshold === "number"
      ? { match_threshold: params.threshold }
      : {}),
  });

  const results: VectorSearchHit[] = matches.map((m) => {
    const content = m.content as { text?: string } | undefined;
    return {
      id: m.id ?? null,
      text: content?.text ?? "",
      similarity: (m as { similarity?: number }).similarity ?? null,
      roomId: m.roomId ?? null,
      entityId: m.entityId ?? null,
      createdAt: m.createdAt ?? null,
      tableName: table,
    };
  });

  const lines = results.slice(0, 5).map((hit, i) => {
    const score =
      typeof hit.similarity === "number" ? hit.similarity.toFixed(3) : "n/a";
    const snippet = hit.text.slice(0, 160).replace(/\s+/g, " ");
    return `${i + 1}. [${score}] ${snippet}`;
  });

  return {
    success: true,
    text:
      results.length === 0
        ? `No matches for "${query}" in ${table}.`
        : [`Top ${results.length} match(es) in ${table}:`, ...lines].join("\n"),
    values: { count: results.length, table },
    data: {
      actionName: "DATABASE",
      op: "search_vectors",
      query,
      table,
      limit,
      results,
    },
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

async function databaseHandler(
  runtime: IAgentRuntime,
  options: unknown,
): Promise<ActionResult> {
  const params = getParams(options);
  const op = params.op;

  if (!isDatabaseOp(op)) {
    return {
      success: false,
      text: `op is required and must be one of: ${DATABASE_OPS.join(", ")}.`,
      values: {
        error: "DATABASE_INVALID_OP",
        received: typeof op === "string" ? op : null,
      },
    };
  }

  try {
    switch (op) {
      case "list_tables":
        return await opListTables(runtime, params);
      case "get_table":
        return await opGetTable(runtime, params);
      case "query":
        return await opQuery(runtime, params);
      case "search_vectors":
        return await opSearchVectors(runtime, params);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[DATABASE] op=${op} failed: ${msg}`);
    return {
      success: false,
      text: `DATABASE op "${op}" failed: ${msg}`,
      values: { error: `DATABASE_${op.toUpperCase()}_FAILED` },
    };
  }
}

export const databaseAction: Action = {
  name: "DATABASE",
  contexts: ["admin", "agent_internal", "documents", "memory"],
  roleGate: { minRole: "OWNER" },
  similes: [
    // Old leaf action names (kept so older inbound callers still resolve)
    "LIST_DATABASE_TABLES",
    "GET_TABLE_DATA",
    "EXECUTE_DATABASE_QUERY",
    "SEARCH_VECTORS",
    // Common aliases
    "LIST_TABLES",
    "SHOW_TABLES",
    "DB_TABLES",
    "READ_TABLE",
    "SELECT_TABLE",
    "BROWSE_TABLE",
    "RUN_QUERY",
    "SQL_QUERY",
    "DB_QUERY",
    "VECTOR_SEARCH",
    "EMBEDDING_SEARCH",
    "SIMILARITY_SEARCH",
  ],
  description:
    "Inspect or query the agent's database. Ops: list_tables, get_table, query (read-only by default), search_vectors (semantic memory search).",
  descriptionCompressed:
    "inspect or query agent database; ops list_tables, get_table, query (read-only default), search_vectors",
  validate: async (runtime) => {
    registerVectorSearchCategory(runtime);
    return true;
  },
  handler: async (runtime, _message, _state, options) =>
    databaseHandler(runtime, options),
  parameters: [
    {
      name: "op",
      description: `Op to perform. One of: ${DATABASE_OPS.join(", ")}.`,
      required: true,
      schema: { type: "string" as const, enum: [...DATABASE_OPS] },
    },
    {
      name: "filter",
      description: "list_tables: case-insensitive substring on table name.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "includeEmpty",
      description: "list_tables: include zero-row tables (default true).",
      required: false,
      schema: { type: "boolean" as const, default: true },
    },
    {
      name: "tableName",
      description: "get_table: table name to read.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description:
        "get_table (1-500): page size. search_vectors (1-100): max hits.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "offset",
      description: "get_table: row offset for pagination.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "sortBy",
      description: "get_table: column name to sort by.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "sortDir",
      description: "get_table: sort direction.",
      required: false,
      schema: { type: "string" as const, enum: ["asc", "desc"] },
    },
    {
      name: "sql",
      description: "query: SQL text. Read-only unless allowWrites:true.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "allowWrites",
      description: "query: permit mutations (INSERT/UPDATE/DELETE/DDL).",
      required: false,
      schema: { type: "boolean" as const, default: false },
    },
    {
      name: "query",
      description: "search_vectors: text to embed and search.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "table",
      description:
        "search_vectors: memory table (messages, memories, facts, documents, document_fragments).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "threshold",
      description: "search_vectors: minimum similarity (0-1).",
      required: false,
      schema: { type: "number" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "What tables are in your database?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Found N table(s)...",
          action: "DATABASE",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Run SELECT count(*) FROM memories" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Query returned 1 row(s).",
          action: "DATABASE",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Find memories similar to 'birthday plans'." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Top match(es)...",
          action: "DATABASE",
        },
      },
    ],
  ],
};

// ---------------------------------------------------------------------------
// Legacy aliases.
//
// eliza-plugin.ts and web-search.ts still import the four old per-op exports
// + searchVectorsAction. Each alias points at the same canonical
// `databaseAction`, so there is one action with name "DATABASE" registered.
// Updating the import sites is a follow-up.
// ---------------------------------------------------------------------------

export const listDatabaseTablesAction = databaseAction;
export const getTableDataAction = databaseAction;
export const executeDatabaseQueryAction = databaseAction;
export const searchVectorsAction = databaseAction;
