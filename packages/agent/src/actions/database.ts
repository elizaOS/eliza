/**
 * Database introspection actions.
 *
 * LIST_DATABASE_TABLES   → GET /api/database/tables
 * GET_TABLE_DATA         → GET /api/database/tables/:table/rows
 * EXECUTE_DATABASE_QUERY → POST /api/database/query
 *                          (forces readOnly:true unless allowWrites:true is set)
 * SEARCH_VECTORS         → POST /api/database/vectors/search
 */

import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  SearchCategoryRegistration,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { resolveServerOnlyPort } from "@elizaos/shared";

function getApiBase(): string {
  return `http://localhost:${resolveServerOnlyPort(process.env)}`;
}

interface TableInfoShape {
  name: string;
  rowCount?: number;
  columns?: Array<{ name: string; type?: string }>;
}

interface ListTablesResponse {
  tables: TableInfoShape[];
}

interface ListDatabaseTablesParams {
  filter?: string;
  includeEmpty?: boolean;
}

interface TableRowsResponse {
  rows: Array<Record<string, unknown>>;
  total?: number;
  offset?: number;
  limit?: number;
}

interface QueryResultShape {
  rows?: Array<Record<string, unknown>>;
  rowCount?: number;
  fields?: Array<{ name: string }>;
  error?: string;
}

// ---------------------------------------------------------------------------
// LIST_DATABASE_TABLES
// ---------------------------------------------------------------------------

export const listDatabaseTablesAction: Action = {
  name: "LIST_DATABASE_TABLES",
  contexts: ["admin", "agent_internal", "documents", "memory"],
  roleGate: { minRole: "OWNER" },
  similes: ["LIST_TABLES", "SHOW_TABLES", "DB_TABLES"],
  description:
    "List all tables in the agent's database, with row counts and column metadata when available.",
  descriptionCompressed:
    "list table agent database, w/ row count column metadata available",
  validate: async () => true,
  handler: async (
    _runtime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    try {
      const resp = await fetch(`${getApiBase()}/api/database/tables`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        return {
          success: false,
          text: `Failed to list tables: HTTP ${resp.status}`,
        };
      }
      const data = (await resp.json()) as ListTablesResponse;
      const params = (options as HandlerOptions | undefined)?.parameters as
        | ListDatabaseTablesParams
        | undefined;
      const filter = params?.filter?.trim().toLowerCase() ?? "";
      const includeEmpty = params?.includeEmpty ?? true;
      const tables = (data.tables ?? []).filter((table) => {
        if (filter && !table.name.toLowerCase().includes(filter)) return false;
        if (
          !includeEmpty &&
          typeof table.rowCount === "number" &&
          table.rowCount === 0
        )
          return false;
        return true;
      });
      const lines = tables.map((table) => {
        const cols = table.columns?.length ?? 0;
        const rows = table.rowCount ?? "?";
        return `- ${table.name} (${cols} cols, ${rows} rows)`;
      });
      return {
        success: true,
        text: lines.length
          ? `Found ${tables.length} table(s):\n${lines.join("\n")}`
          : "No tables found.",
        values: { count: tables.length },
        data: { actionName: "LIST_DATABASE_TABLES", tables, filter },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[list-database-tables] failed: ${msg}`);
      return { success: false, text: `Failed to list tables: ${msg}` };
    }
  },
  parameters: [
    {
      name: "filter",
      description: "Optional case-insensitive substring to match table names.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "includeEmpty",
      description:
        "When false, omit tables with zero rows when row counts are available.",
      required: false,
      schema: { type: "boolean" as const, default: true },
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
          action: "LIST_DATABASE_TABLES",
        },
      },
    ],
  ],
};

// ---------------------------------------------------------------------------
// GET_TABLE_DATA
// ---------------------------------------------------------------------------

interface GetTableDataParams {
  tableName?: string;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
}

export const getTableDataAction: Action = {
  name: "GET_TABLE_DATA",
  contexts: ["admin", "agent_internal", "documents", "memory"],
  roleGate: { minRole: "OWNER" },
  similes: ["READ_TABLE", "SELECT_TABLE", "BROWSE_TABLE"],
  description:
    "Fetch a page of rows from a database table. Supports limit, offset, sortBy, and sortDir.",
  descriptionCompressed:
    "fetch page row database table support limit, offset, sortby, sortdir",
  validate: async () => true,
  handler: async (
    _runtime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | GetTableDataParams
      | undefined;
    const tableName = params?.tableName?.trim();
    if (!tableName) {
      return {
        success: false,
        text: "tableName is required.",
        values: { error: "MISSING_TABLE" },
      };
    }

    const search = new URLSearchParams();
    if (params?.limit != null) {
      search.set(
        "limit",
        String(Math.max(1, Math.min(500, Math.floor(params.limit)))),
      );
    }
    if (params?.offset != null) {
      search.set("offset", String(Math.max(0, Math.floor(params.offset))));
    }
    if (params?.sortBy) search.set("sort", params.sortBy);
    if (params?.sortDir === "asc" || params?.sortDir === "desc") {
      search.set("order", params.sortDir);
    }

    const qs = search.toString();
    const url = `${getApiBase()}/api/database/tables/${encodeURIComponent(tableName)}/rows${qs ? `?${qs}` : ""}`;

    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!resp.ok) {
        return {
          success: false,
          text: `Failed to read table "${tableName}": HTTP ${resp.status}`,
        };
      }
      const data = (await resp.json()) as TableRowsResponse;
      const rows = data.rows ?? [];
      return {
        success: true,
        text: `Returned ${rows.length} row(s) from "${tableName}" (total: ${data.total ?? "unknown"}).`,
        values: { rowCount: rows.length, total: data.total ?? null },
        data: {
          actionName: "GET_TABLE_DATA",
          tableName,
          rows,
          total: data.total,
          offset: data.offset,
          limit: data.limit,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[get-table-data] failed: ${msg}`);
      return {
        success: false,
        text: `Failed to read table "${tableName}": ${msg}`,
      };
    }
  },
  parameters: [
    {
      name: "tableName",
      description: "Name of the table to read.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description: "Maximum rows to return (1-500). Default: server default.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "offset",
      description: "Row offset for pagination.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "sortBy",
      description: "Column name to sort by.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "sortDir",
      description: "Sort direction: asc or desc.",
      required: false,
      schema: { type: "string" as const, enum: ["asc", "desc"] },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Show me the first 10 rows of the memories table." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Returned 10 row(s) from memories...",
          action: "GET_TABLE_DATA",
        },
      },
    ],
  ],
};

// ---------------------------------------------------------------------------
// EXECUTE_DATABASE_QUERY
// ---------------------------------------------------------------------------

interface ExecuteQueryParams {
  sql?: string;
  allowWrites?: boolean;
}

// Pre-flight client-side mutation check. The server enforces this too, but we
// fail closed before sending anything when allowWrites is not explicitly set.
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

function stripSqlNoise(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "")
    .replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, " ")
    .replace(/'(?:[^']|'')*'/g, " ")
    .replace(/"(?:[^"]|"")*"/g, " ");
}

function detectMutation(sql: string): string | null {
  const cleaned = stripSqlNoise(sql);
  const pattern = new RegExp(`\\b(${MUTATION_KEYWORDS.join("|")})\\b`, "i");
  const match = pattern.exec(cleaned);
  return match ? match[1].toUpperCase() : null;
}

export const executeDatabaseQueryAction: Action = {
  name: "EXECUTE_DATABASE_QUERY",
  contexts: ["admin", "agent_internal", "documents", "memory"],
  roleGate: { minRole: "OWNER" },
  similes: ["RUN_QUERY", "SQL_QUERY", "DB_QUERY"],
  description:
    "Execute a SQL query against the agent's database. Read-only by default — pass allowWrites:true to permit mutations.",
  descriptionCompressed:
    "execute SQL query against agent database read-only default pass allowwrite: true permit mutation",
  validate: async () => true,
  handler: async (
    _runtime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | ExecuteQueryParams
      | undefined;
    const sqlRaw = params?.sql?.trim();
    if (!sqlRaw) {
      return {
        success: false,
        text: "sql is required.",
        values: { error: "MISSING_SQL" },
      };
    }

    const allowWrites = params?.allowWrites === true;
    if (!allowWrites) {
      const offending = detectMutation(sqlRaw);
      if (offending) {
        return {
          success: false,
          text: `Query rejected: "${offending}" is a mutation keyword. Set allowWrites:true to execute mutations.`,
          values: { error: "MUTATION_BLOCKED", keyword: offending },
          data: { actionName: "EXECUTE_DATABASE_QUERY" },
        };
      }
    }

    try {
      const resp = await fetch(`${getApiBase()}/api/database/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: sqlRaw, readOnly: !allowWrites }),
        signal: AbortSignal.timeout(30_000),
      });
      const result = (await resp.json()) as QueryResultShape;
      if (!resp.ok) {
        return {
          success: false,
          text: result.error
            ? `Query failed: ${result.error}`
            : `Query failed: HTTP ${resp.status}`,
          values: { error: "QUERY_FAILED" },
          data: { actionName: "EXECUTE_DATABASE_QUERY", result },
        };
      }
      const rows = result.rows ?? [];
      return {
        success: true,
        text: `Query returned ${result.rowCount ?? rows.length} row(s).`,
        values: {
          rowCount: result.rowCount ?? rows.length,
          allowWrites,
        },
        data: { actionName: "EXECUTE_DATABASE_QUERY", result },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[execute-database-query] failed: ${msg}`);
      return { success: false, text: `Query failed: ${msg}` };
    }
  },
  parameters: [
    {
      name: "sql",
      description: "SQL query to run.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "allowWrites",
      description:
        "Set true to permit mutations (INSERT/UPDATE/DELETE/DDL). Default: false (read-only).",
      required: false,
      schema: { type: "boolean" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Run SELECT count(*) FROM memories" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Query returned 1 row(s).",
          action: "EXECUTE_DATABASE_QUERY",
        },
      },
    ],
  ],
};

// ---------------------------------------------------------------------------
// SEARCH_VECTORS
// ---------------------------------------------------------------------------

interface SearchVectorsParams {
  query?: string;
  limit?: number;
  table?: string;
  threshold?: number;
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

interface VectorSearchResponse {
  query: string;
  table: string;
  limit: number;
  count: number;
  results: VectorSearchHit[];
}

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
        "Memory table to search. One of: messages, memories, facts, documents, knowledge.",
      type: "enum",
      options: [
        { label: "messages", value: "messages" },
        { label: "memories", value: "memories" },
        { label: "facts", value: "facts" },
        { label: "documents", value: "documents" },
        { label: "documents", value: "documents" },
      ],
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

export const searchVectorsAction: Action = {
  name: "SEARCH_VECTORS",
  contexts: ["admin", "agent_internal", "documents", "memory"],
  roleGate: { minRole: "OWNER" },
  similes: ["VECTOR_SEARCH", "EMBEDDING_SEARCH", "SIMILARITY_SEARCH"],
  description:
    "Search the agent's vector store for semantically similar items via /api/database/vectors/search. Embeds the query with the runtime's TEXT_EMBEDDING model and returns top-k matches with similarity scores.",
  descriptionCompressed:
    "search agent vector store semantically similar item via / api/database/vectors/search embed query w/ runtime TEXT_EMBEDDING model return top-k match w/ similarity score",
  validate: async (runtime, _message) => {
    registerVectorSearchCategory(runtime);
    return false;
  },
  handler: async (
    runtime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    registerVectorSearchCategory(runtime);

    const params = (options as HandlerOptions | undefined)?.parameters as
      | SearchVectorsParams
      | undefined;
    const query = params?.query?.trim();
    if (!query) {
      return {
        success: false,
        text: "query is required.",
        values: { error: "MISSING_QUERY" },
      };
    }

    const body: Record<string, unknown> = { query };
    if (typeof params?.limit === "number") {
      body.limit = Math.max(1, Math.min(100, Math.floor(params.limit)));
    }
    if (typeof params?.table === "string" && params.table.trim()) {
      body.table = params.table.trim();
    }
    if (typeof params?.threshold === "number") {
      body.threshold = params.threshold;
    }

    try {
      const resp = await fetch(`${getApiBase()}/api/database/vectors/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try {
          const errBody = (await resp.json()) as { error?: string };
          if (errBody.error) detail = errBody.error;
        } catch {
          // Non-JSON body — fall back.
        }
        return {
          success: false,
          text: `Vector search failed: ${detail}`,
          values: { error: "SEARCH_FAILED" },
          data: { actionName: "SEARCH_VECTORS" },
        };
      }
      const data = (await resp.json()) as VectorSearchResponse;
      const results = data.results ?? [];
      const lines = results.slice(0, 5).map((hit, i) => {
        const score =
          typeof hit.similarity === "number"
            ? hit.similarity.toFixed(3)
            : "n/a";
        const snippet = hit.text.slice(0, 160).replace(/\s+/g, " ");
        return `${i + 1}. [${score}] ${snippet}`;
      });
      return {
        success: true,
        text:
          results.length === 0
            ? `No matches for "${data.query}" in ${data.table}.`
            : [
                `Top ${results.length} match(es) in ${data.table}:`,
                ...lines,
              ].join("\n"),
        values: { count: results.length, table: data.table },
        data: {
          actionName: "SEARCH_VECTORS",
          query: data.query,
          table: data.table,
          limit: data.limit,
          results,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[search-vectors] failed: ${msg}`);
      return {
        success: false,
        text: `Vector search failed: ${msg}`,
      };
    }
  },
  parameters: [
    {
      name: "query",
      description: "Search query text.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description: "Maximum number of results to return (1-100). Default: 10.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "table",
      description:
        "Memory table to search. One of: messages, memories, facts, documents, knowledge. Default: messages.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "threshold",
      description:
        "Optional minimum similarity threshold (0-1). Lower values return more results.",
      required: false,
      schema: { type: "number" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Find memories similar to 'birthday plans'." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Top match(es)...",
          action: "SEARCH_VECTORS",
        },
      },
    ],
  ],
};
