/**
 * Database management API handlers for the Milady Control UI.
 *
 * Provides endpoints for:
 * - Database provider configuration (PGLite vs Postgres)
 * - Connection testing for remote Postgres
 * - Table browsing and introspection
 * - Row-level CRUD operations
 * - Raw SQL query execution
 * - Database status and health
 *
 * All data endpoints use the active runtime's database adapter (Drizzle ORM)
 * so they work identically for both PGLite and Postgres.
 */

import dns from "node:dns";
import type http from "node:http";
import net from "node:net";
import { promisify } from "node:util";
import { type AgentRuntime, logger } from "@elizaos/core";
import { loadMiladyConfig, saveMiladyConfig } from "../config/config";
import type {
  DatabaseConfig,
  DatabaseProviderType,
  PostgresCredentials,
} from "../config/types.milady";
import {
  isLoopbackHost,
  normalizeHostLike,
  normalizeIpForPolicy,
} from "../security/network-policy";
import {
  readJsonBody as parseJsonBody,
  sendJson,
  sendJsonError,
} from "./http-helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DatabaseStatus {
  provider: DatabaseProviderType;
  connected: boolean;
  serverVersion: string | null;
  tableCount: number;
  pgliteDataDir: string | null;
  postgresHost: string | null;
}

interface TableInfo {
  name: string;
  schema: string;
  rowCount: number;
  columns: ColumnInfo[];
}

interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
}

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
}

interface ConnectionTestResult {
  success: boolean;
  serverVersion: string | null;
  error: string | null;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJsonBody<T = Record<string, unknown>>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<T | null> {
  return parseJsonBody(req, res, {
    maxBytes: 2 * 1024 * 1024,
  });
}

/**
 * Safely quote a SQL identifier (table or column name).
 * Postgres uses double-quote escaping: embedded " becomes "".
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Build a Postgres connection string from individual credential fields.
 */
function buildConnectionString(creds: PostgresCredentials): string {
  if (creds.connectionString) return creds.connectionString;
  const host = creds.host ?? "localhost";
  const port = creds.port ?? 5432;
  const user = encodeURIComponent(creds.user ?? "postgres");
  const password = creds.password ? encodeURIComponent(creds.password) : "";
  const database = creds.database ?? "postgres";
  const auth = password ? `${user}:${password}` : user;
  const sslParam = creds.ssl ? "?sslmode=require" : "";
  return `postgresql://${auth}@${host}:${port}/${database}${sslParam}`;
}

/**
 * Return a copy of credentials with host pinned to a validated IP address.
 * For connection strings, rewrites URL hostname to avoid re-resolution later.
 */
function withPinnedHost(
  creds: PostgresCredentials,
  pinnedHost: string,
): PostgresCredentials {
  const normalizedPinned = pinnedHost.replace(/^::ffff:/i, "");
  const next: PostgresCredentials = { ...creds, host: normalizedPinned };
  if (next.connectionString) {
    try {
      const parsed = new URL(next.connectionString);
      parsed.hostname = normalizedPinned;
      // Preserve DNS pinning even when libpq-style query params are present.
      // `host` / `hostaddr` can override URI hostname; force both to pinned IP.
      parsed.searchParams.set("host", normalizedPinned);
      parsed.searchParams.set("hostaddr", normalizedPinned);
      next.connectionString = parsed.toString();
    } catch {
      // Validation has already parsed this once, but if URL rewriting fails,
      // force builder path to use the pinned host.
      delete next.connectionString;
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Host validation — prevent SSRF via database connection endpoints
// ---------------------------------------------------------------------------

const dnsLookupAll = promisify(dns.lookup);

/**
 * IP ranges that are ALWAYS blocked regardless of bind address.
 * Cloud metadata and "this" network are never legitimate Postgres targets.
 */
const ALWAYS_BLOCKED_IP_PATTERNS: RegExp[] = [
  /^169\.254\./, // Link-local / cloud metadata (AWS, GCP, Azure)
  /^0\./, // "This" network
  /^fe[89ab][0-9a-f]:/i, // IPv6 link-local fe80::/10
];

/**
 * Private/internal IP ranges — blocked only when the API is bound to a
 * non-loopback address (i.e. remotely reachable).  When bound to 127.0.0.1
 * (the default), these are allowed since local Postgres is the most common
 * setup and an attacker who can reach the loopback API already has local
 * network access.
 */
const PRIVATE_IP_PATTERNS: RegExp[] = [
  /^127\./, // IPv4 loopback
  /^10\./, // RFC 1918 Class A
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC 1918 Class B
  /^192\.168\./, // RFC 1918 Class C
  /^::1$/, // IPv6 loopback
  /^f[cd][0-9a-f]{2}:/i, // IPv6 ULA (fc00::/7 includes fc00::–fdff::)
];

/**
 * Returns true when the API server is bound to a loopback-only address.
 * In that case, private/internal IP ranges are allowed for DB connections
 * since only local processes can reach the API.
 */
function isApiLoopbackOnly(): boolean {
  let bind = (process.env.MILADY_API_BIND ?? "127.0.0.1").trim().toLowerCase();
  if (!bind) bind = "127.0.0.1";

  // Accept accidental URL-shaped bind values.
  if (bind.startsWith("http://") || bind.startsWith("https://")) {
    try {
      const parsed = new URL(bind);
      bind = parsed.hostname.toLowerCase();
    } catch {
      // Fall through and treat as raw host value.
    }
  }

  // [::1]:2138 -> ::1
  const bracketedIpv6 = /^\[([^\]]+)\](?::\d+)?$/.exec(bind);
  if (bracketedIpv6?.[1]) {
    bind = bracketedIpv6[1];
  } else {
    // localhost:2138 -> localhost, 127.0.0.1:2138 -> 127.0.0.1
    const singleColonHostPort = /^([^:]+):(\d+)$/.exec(bind);
    if (singleColonHostPort?.[1]) {
      bind = singleColonHostPort[1];
    }
  }

  bind = bind.replace(/^\[|\]$/g, "");

  // Reuse the strict loopback classifier to avoid hostname prefix bypasses
  // such as "127.evil.com" that are not literal 127.0.0.0/8 IPs.
  return isLoopbackHost(bind);
}

/**
 * Extract all potential hosts from a Postgres connection string or credentials object.
 * Includes query params like ?host= and ?hostaddr= which Postgres clients honor.
 * Returns empty array if no host can be determined.
 */
function extractHosts(creds: PostgresCredentials): string[] {
  if (creds.connectionString) {
    try {
      const url = new URL(creds.connectionString);
      const hosts: string[] = [];

      // PostgreSQL connection strings can have ?host= param that overrides URI hostname
      const hostParam = url.searchParams.get("host");
      if (hostParam) {
        hosts.push(
          ...hostParam
            .split(",")
            .map((h) => normalizeHostLike(h))
            .filter(Boolean),
        );
      }

      // Also check hostaddr param
      const hostAddrParam = url.searchParams.get("hostaddr");
      if (hostAddrParam) {
        hosts.push(
          ...hostAddrParam
            .split(",")
            .map((h) => normalizeHostLike(h))
            .filter(Boolean),
        );
      }

      // Include URI hostname
      if (url.hostname) {
        hosts.push(normalizeHostLike(url.hostname));
      }

      return [...new Set(hosts)];
    } catch {
      return []; // Unparseable — will be rejected
    }
  }
  if (creds.host) {
    const host = normalizeHostLike(creds.host);
    return host ? [host] : [];
  }
  return [];
}

/**
 * Check whether an IP address falls in a blocked range.
 * When the API is remotely reachable, private ranges are also blocked.
 */
function isBlockedIp(ip: string): boolean {
  const normalized = normalizeIpForPolicy(ip);
  if (ALWAYS_BLOCKED_IP_PATTERNS.some((p) => p.test(normalized))) return true;
  if (
    !isApiLoopbackOnly() &&
    PRIVATE_IP_PATTERNS.some((p) => p.test(normalized))
  )
    return true;
  return false;
}

/**
 * Validate that all target hosts do not resolve to blocked addresses.
 *
 * Performs DNS resolution to catch hostnames like `metadata.google.internal`
 * or `169.254.169.254.nip.io` that resolve to link-local / cloud metadata
 * IPs.  Also handles IPv6-mapped IPv4 addresses (e.g. `::ffff:169.254.x.y`).
 *
 * Returns a validation result including a pinned host IP when successful.
 */
async function validateDbHost(
  creds: PostgresCredentials,
  opts: { allowUnresolvedHostnames?: boolean } = {},
): Promise<{ error: string | null; pinnedHost: string | null }> {
  const hosts = extractHosts(creds);
  if (hosts.length === 0) {
    return {
      error: "Could not determine target host from the provided credentials.",
      pinnedHost: null,
    };
  }

  let pinnedHost: string | null = null;

  for (const host of hosts) {
    const literalNormalized = normalizeIpForPolicy(host);

    // First check the literal host string (catches raw IPs without DNS lookup)
    if (isBlockedIp(literalNormalized)) {
      return {
        error: `Connection to "${host}" is blocked: link-local and metadata addresses are not allowed.`,
        pinnedHost: null,
      };
    }

    // Literal IPs are already pinned and do not require DNS.
    if (net.isIP(literalNormalized)) {
      if (!pinnedHost) pinnedHost = literalNormalized;
      continue;
    }

    // Resolve DNS and check all resulting IPs
    try {
      const results = await dnsLookupAll(host, { all: true });
      const addresses = Array.isArray(results) ? results : [results];
      for (const entry of addresses) {
        const ip =
          typeof entry === "string"
            ? entry
            : (entry as { address: string }).address;
        const normalized = normalizeIpForPolicy(ip);
        if (isBlockedIp(normalized)) {
          return {
            error:
              `Connection to "${host}" is blocked: it resolves to ${ip} ` +
              `which is a link-local or metadata address.`,
            pinnedHost: null,
          };
        }
        if (!pinnedHost) pinnedHost = normalized;
      }
    } catch {
      // For "save config" flows we allow unresolved hostnames so users can
      // persist remote endpoints that are only resolvable from their runtime
      // network. For "test connection" flows we keep strict DNS requirements.
      if (!opts.allowUnresolvedHostnames) {
        return {
          error:
            `Connection to "${host}" failed DNS resolution during validation. ` +
            "Use a resolvable hostname or a literal IP address.",
          pinnedHost: null,
        };
      }
    }
  }

  if (!pinnedHost) {
    if (opts.allowUnresolvedHostnames) {
      return { error: null, pinnedHost: null };
    }
    return {
      error: "Could not validate any host to a concrete IP address.",
      pinnedHost: null,
    };
  }
  return { error: null, pinnedHost };
}

/** Convert a JS value to a SQL literal for use in raw queries. */
function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "object")
    return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Build a "col = val" SQL assignment clause. */
function sqlAssign(col: string, val: unknown): string {
  if (val === null || val === undefined) return `${quoteIdent(col)} = NULL`;
  return `${quoteIdent(col)} = ${sqlLiteral(val)}`;
}

/** Build a "col = val" or "col IS NULL" SQL WHERE predicate. */
function sqlPredicate(col: string, val: unknown): string {
  if (val === null || val === undefined) return `${quoteIdent(col)} IS NULL`;
  return `${quoteIdent(col)} = ${sqlLiteral(val)}`;
}

// Cached drizzle-orm sql helper; resolved once on first call.
let _sqlHelper: { raw: (query: string) => { queryChunks: unknown[] } } | null =
  null;
async function getDrizzleSql(): Promise<typeof _sqlHelper> {
  if (!_sqlHelper) {
    const drizzle = await import("drizzle-orm");
    _sqlHelper = drizzle.sql;
  }
  return _sqlHelper;
}

/** Execute raw SQL via the runtime's Drizzle adapter. */
async function executeRawSql(
  runtime: AgentRuntime,
  sqlText: string,
): Promise<{ rows: Record<string, unknown>[]; columns: string[] }> {
  const drizzleSql = await getDrizzleSql();
  const db = runtime.adapter.db as {
    execute(query: { queryChunks: unknown[] }): Promise<{
      rows: Record<string, unknown>[];
      fields?: Array<{ name: string }>;
    }>;
  };
  const rawQuery = drizzleSql?.raw(sqlText);
  if (!rawQuery) throw new Error("SQL module not available");
  const result = await db.execute(rawQuery);
  const rows = Array.isArray(result.rows)
    ? result.rows
    : (result as unknown as Record<string, unknown>[]);

  let columns: string[] = [];
  if (result.fields && Array.isArray(result.fields)) {
    columns = result.fields.map((f: { name: string }) => f.name);
  } else if (rows.length > 0) {
    columns = Object.keys(rows[0]);
  }

  return { rows, columns };
}

/**
 * Detect the current database provider from environment / runtime state.
 */
function detectCurrentProvider(): DatabaseProviderType {
  return process.env.POSTGRES_URL ? "postgres" : "pglite";
}

/** Verify a table name refers to a real user table. */
async function assertTableExists(
  runtime: AgentRuntime,
  tableName: string,
): Promise<boolean> {
  const safe = tableName.replace(/'/g, "''");
  const { rows } = await executeRawSql(
    runtime,
    `SELECT 1 FROM information_schema.tables
     WHERE table_name = '${safe}'
       AND table_schema NOT IN ('pg_catalog', 'information_schema')
       AND table_type = 'BASE TABLE'
     LIMIT 1`,
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/database/status
 * Returns current connection status, provider, table count, version.
 */
async function handleGetStatus(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime | null,
): Promise<void> {
  const provider = detectCurrentProvider();
  if (!runtime?.adapter) {
    sendJson(res, {
      provider,
      connected: false,
      serverVersion: null,
      tableCount: 0,
      pgliteDataDir: process.env.PGLITE_DATA_DIR ?? null,
      postgresHost: null,
    } satisfies DatabaseStatus);
    return;
  }

  const { rows } = await executeRawSql(runtime, "SELECT version()");
  const serverVersion =
    rows.length > 0
      ? String((rows[0] as Record<string, unknown>).version ?? "")
      : null;

  const tableResult = await executeRawSql(
    runtime,
    `SELECT count(*) AS cnt
       FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        AND table_type = 'BASE TABLE'`,
  );
  const tableCount =
    tableResult.rows.length > 0
      ? Number((tableResult.rows[0] as Record<string, unknown>).cnt ?? 0)
      : 0;

  const status: DatabaseStatus = {
    provider,
    connected: true,
    serverVersion,
    tableCount,
    pgliteDataDir:
      provider === "pglite" ? (process.env.PGLITE_DATA_DIR ?? null) : null,
    postgresHost:
      provider === "postgres"
        ? (process.env.POSTGRES_URL?.replace(
            /^postgresql:\/\/[^@]*@/,
            "",
          ).replace(/\/.*$/, "") ?? null)
        : null,
  };

  sendJson(res, status);
}

/**
 * GET /api/database/config
 * Returns the persisted database configuration from milady.json.
 */
function handleGetConfig(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const config = loadMiladyConfig();
  const dbConfig: DatabaseConfig = config.database ?? { provider: "pglite" };
  // Mask the password in the response
  const sanitized = { ...dbConfig };
  if (sanitized.postgres?.password) {
    sanitized.postgres = {
      ...sanitized.postgres,
      password: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022",
    };
  }
  if (sanitized.postgres?.connectionString) {
    // Mask password in connection string
    sanitized.postgres = {
      ...sanitized.postgres,
      connectionString: sanitized.postgres.connectionString.replace(
        /:([^@]+)@/,
        ":\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022@",
      ),
    };
  }
  sendJson(res, {
    config: sanitized,
    activeProvider: detectCurrentProvider(),
    needsRestart: (dbConfig.provider ?? "pglite") !== detectCurrentProvider(),
  });
}

/**
 * PUT /api/database/config
 * Saves new database configuration. Does NOT restart the agent automatically;
 * the UI prompts the user to restart.
 */
async function handlePutConfig(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readJsonBody<DatabaseConfig>(req, res);
  if (!body) return;

  // Validate
  if (
    body.provider &&
    body.provider !== "pglite" &&
    body.provider !== "postgres"
  ) {
    sendJsonError(
      res,
      `Invalid provider: ${String(body.provider)}. Must be "pglite" or "postgres".`,
    );
    return;
  }

  // Load current config so validation can account for unchanged provider.
  const config = loadMiladyConfig();
  const existingDb = config.database ?? {};
  const effectiveProvider =
    body.provider ?? existingDb.provider ?? ("pglite" as DatabaseProviderType);
  let validatedPostgres: PostgresCredentials | null = null;

  if (body.postgres) {
    const pg = body.postgres;
    if (effectiveProvider === "postgres" && !pg.connectionString && !pg.host) {
      sendJsonError(
        res,
        "Postgres configuration requires either a connectionString or at least a host.",
      );
      return;
    }

    const validation = await validateDbHost(pg, {
      allowUnresolvedHostnames: Boolean(pg.connectionString),
    });
    if (validation.error) {
      sendJsonError(res, validation.error);
      return;
    }
    validatedPostgres = validation.pinnedHost
      ? withPinnedHost(pg, validation.pinnedHost)
      : pg;
  }

  // Merge: keep existing postgres/pglite sub-configs unless explicitly provided
  const merged: DatabaseConfig = {
    ...existingDb,
    ...body,
  };

  // If switching to postgres, ensure postgres config is present
  if (merged.provider === "postgres" && body.postgres) {
    merged.postgres = {
      ...existingDb.postgres,
      ...(validatedPostgres ?? body.postgres),
    };
  }
  // If switching to pglite, ensure pglite config is present
  if (merged.provider === "pglite" && body.pglite) {
    merged.pglite = { ...existingDb.pglite, ...body.pglite };
  }

  config.database = merged;
  saveMiladyConfig(config);

  logger.info(
    { src: "database-api", provider: merged.provider },
    "Database configuration saved",
  );

  sendJson(res, {
    saved: true,
    config: merged,
    needsRestart: (merged.provider ?? "pglite") !== detectCurrentProvider(),
  });
}

/**
 * POST /api/database/test
 * Tests a Postgres connection without persisting anything.
 * Body: { connectionString?, host?, port?, user?, password?, database?, ssl? }
 */
async function handleTestConnection(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readJsonBody<PostgresCredentials>(req, res);
  if (!body) return;

  const validation = await validateDbHost(body);
  if (validation.error) {
    sendJsonError(res, validation.error);
    return;
  }

  const pinnedCreds = validation.pinnedHost
    ? withPinnedHost(body, validation.pinnedHost)
    : body;
  const connectionString = buildConnectionString(pinnedCreds);
  const start = Date.now();

  // Dynamically import pg to avoid hard-coupling (it is a peer dep via plugin-sql)
  let Pool: typeof import("pg").Pool;
  try {
    const pgModule = await import("pg");
    Pool = pgModule.default?.Pool ?? pgModule.Pool;
  } catch {
    sendJson(res, {
      success: false,
      serverVersion: null,
      error:
        "PostgreSQL client library (pg) is not available. Ensure @elizaos/plugin-sql is installed.",
      durationMs: Date.now() - start,
    } satisfies ConnectionTestResult);
    return;
  }

  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 5000,
  });

  let client: import("pg").PoolClient | null = null;
  try {
    client = await pool.connect();
    const versionResult = await client.query("SELECT version()");
    const serverVersion = String(versionResult.rows[0]?.version ?? "");
    const durationMs = Date.now() - start;

    sendJson(res, {
      success: true,
      serverVersion,
      error: null,
      durationMs,
    } satisfies ConnectionTestResult);
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, {
      success: false,
      serverVersion: null,
      error: message,
      durationMs,
    } satisfies ConnectionTestResult);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

/**
 * GET /api/database/tables
 * Lists all user tables with column metadata and approximate row counts.
 */
async function handleGetTables(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime,
): Promise<void> {
  // Get all user tables
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

  // Get columns for all tables in one query
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

  // Group columns by table
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

  const tables: TableInfo[] = tablesResult.rows.map((row) => {
    const key = `${String(row.schema)}.${String(row.name)}`;
    return {
      name: String(row.name),
      schema: String(row.schema),
      rowCount: Number(row.row_count ?? 0),
      columns: columnsByTable.get(key) ?? [],
    };
  });

  sendJson(res, { tables });
}

/**
 * GET /api/database/tables/:table/rows?offset=0&limit=50&sort=col&order=asc&search=term
 * Paginated row retrieval for a specific table.
 */
async function handleGetRows(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime,
  tableName: string,
): Promise<void> {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0"));
  const limit = Math.min(
    500,
    Math.max(1, Number(url.searchParams.get("limit") ?? "50")),
  );
  const sortCol = url.searchParams.get("sort") ?? "";
  const sortOrder = url.searchParams.get("order") === "desc" ? "DESC" : "ASC";
  const search = url.searchParams.get("search") ?? "";

  if (!(await assertTableExists(runtime, tableName))) {
    sendJsonError(res, `Table "${tableName}" not found`, 404);
    return;
  }

  // Get column names for this table (for search and sort validation)
  const safeTableName = tableName.replace(/'/g, "''");
  const colResult = await executeRawSql(
    runtime,
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_name = '${safeTableName}'
       AND table_schema NOT IN ('pg_catalog', 'information_schema')
     ORDER BY ordinal_position`,
  );
  const columnNames = colResult.rows.map((r) => String(r.column_name));
  const columnTypes = new Map(
    colResult.rows.map((r) => [String(r.column_name), String(r.data_type)]),
  );

  // Validate sort column
  const validSort = sortCol && columnNames.includes(sortCol) ? sortCol : "";

  // Build search clause: search across all text-castable columns
  let whereClause = "";
  if (search.trim()) {
    // Escape ILIKE special characters: backslash first (since it becomes
    // the escape character), then the ILIKE wildcards % and _.
    const escapedSearch = search
      .replace(/'/g, "''")
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
    const textColumns = columnNames.filter((col) => {
      const t = columnTypes.get(col) ?? "";
      return (
        t.includes("char") ||
        t.includes("text") ||
        t === "uuid" ||
        t === "jsonb" ||
        t === "json" ||
        t === "integer" ||
        t === "bigint" ||
        t === "numeric" ||
        t === "timestamp" ||
        t.includes("timestamp")
      );
    });
    if (textColumns.length > 0) {
      const conditions = textColumns.map(
        (col) =>
          `${quoteIdent(col)}::text ILIKE '%${escapedSearch}%' ESCAPE '\\'`,
      );
      whereClause = `WHERE (${conditions.join(" OR ")})`;
    }
  }

  // Count total (with search filter)
  const countResult = await executeRawSql(
    runtime,
    `SELECT count(*) AS total FROM ${quoteIdent(tableName)} ${whereClause}`,
  );
  const total = Number(
    (countResult.rows[0] as Record<string, unknown>)?.total ?? 0,
  );

  // Fetch rows
  const orderClause = validSort
    ? `ORDER BY ${quoteIdent(validSort)} ${sortOrder}`
    : "";
  const query = `SELECT * FROM ${quoteIdent(tableName)} ${whereClause} ${orderClause} LIMIT ${limit} OFFSET ${offset}`;

  const result = await executeRawSql(runtime, query);

  sendJson(res, {
    table: tableName,
    rows: result.rows,
    columns: result.columns,
    total,
    offset,
    limit,
  });
}

/**
 * POST /api/database/tables/:table/rows
 * Insert a new row. Body: { data: Record<string, unknown> }
 */
async function handleInsertRow(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime,
  tableName: string,
): Promise<void> {
  const body = await readJsonBody<{
    data: Record<string, unknown>;
  }>(req, res);
  if (!body) return;

  if (
    !body.data ||
    typeof body.data !== "object" ||
    Object.keys(body.data).length === 0
  ) {
    sendJsonError(res, "Request body must include a non-empty 'data' object.");
    return;
  }

  if (!(await assertTableExists(runtime, tableName))) {
    sendJsonError(res, `Table "${tableName}" not found`, 404);
    return;
  }

  const columns = Object.keys(body.data);
  const values = Object.values(body.data);
  const colList = columns.map((c) => quoteIdent(c)).join(", ");
  const valList = values.map(sqlLiteral).join(", ");

  const result = await executeRawSql(
    runtime,
    `INSERT INTO ${quoteIdent(tableName)} (${colList}) VALUES (${valList}) RETURNING *`,
  );

  sendJson(res, { inserted: true, row: result.rows[0] ?? null }, 201);
}

/**
 * PUT /api/database/tables/:table/rows
 * Update a row. Body: { where: Record<string, unknown>, data: Record<string, unknown> }
 */
async function handleUpdateRow(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime,
  tableName: string,
): Promise<void> {
  const body = await readJsonBody<{
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }>(req, res);
  if (!body) return;

  if (!body.where || Object.keys(body.where).length === 0) {
    sendJsonError(
      res,
      "Request body must include a non-empty 'where' object for row identification.",
    );
    return;
  }
  if (!body.data || Object.keys(body.data).length === 0) {
    sendJsonError(
      res,
      "Request body must include a non-empty 'data' object with fields to update.",
    );
    return;
  }

  const setClauses = Object.entries(body.data).map(([col, val]) =>
    sqlAssign(col, val),
  );
  const whereClauses = Object.entries(body.where).map(([col, val]) =>
    sqlPredicate(col, val),
  );

  const result = await executeRawSql(
    runtime,
    `UPDATE ${quoteIdent(tableName)}
        SET ${setClauses.join(", ")}
      WHERE ${whereClauses.join(" AND ")}
      RETURNING *`,
  );

  if (result.rows.length === 0) {
    sendJsonError(res, "No matching row found to update.", 404);
    return;
  }

  sendJson(res, { updated: true, row: result.rows[0] });
}

/**
 * DELETE /api/database/tables/:table/rows
 * Delete a row. Body: { where: Record<string, unknown> }
 */
async function handleDeleteRow(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime,
  tableName: string,
): Promise<void> {
  const body = await readJsonBody<{
    where: Record<string, unknown>;
  }>(req, res);
  if (!body) return;

  if (!body.where || Object.keys(body.where).length === 0) {
    sendJsonError(
      res,
      "Request body must include a non-empty 'where' object for row identification.",
    );
    return;
  }

  const whereClauses = Object.entries(body.where).map(([col, val]) =>
    sqlPredicate(col, val),
  );

  const result = await executeRawSql(
    runtime,
    `DELETE FROM ${quoteIdent(tableName)}
      WHERE ${whereClauses.join(" AND ")}
      RETURNING *`,
  );

  if (result.rows.length === 0) {
    sendJsonError(res, "No matching row found to delete.", 404);
    return;
  }

  sendJson(res, { deleted: true, row: result.rows[0] });
}

/**
 * POST /api/database/query
 * Execute a raw SQL query. Body: { sql: string, readOnly?: boolean }
 */
async function handleQuery(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime,
): Promise<void> {
  const body = await readJsonBody<{
    sql: string;
    readOnly?: boolean;
  }>(req, res);
  if (!body) return;

  if (
    !body.sql ||
    typeof body.sql !== "string" ||
    body.sql.trim().length === 0
  ) {
    sendJsonError(res, "Request body must include a non-empty 'sql' string.");
    return;
  }

  const sqlText = body.sql.trim();

  // If readOnly mode, reject mutation statements.
  // Strip SQL comments, then scan for mutation keywords *anywhere* in the
  // query — not just the leading keyword. This prevents bypass via CTEs
  // (WITH ... AS (DELETE ...)) and other SQL constructs that nest mutations.
  if (body.readOnly !== false) {
    // Strip block comments (/* ... */) and line comments (-- ...).
    // Use empty-string replacement (not space) to mirror how PostgreSQL
    // concatenates tokens across comments — e.g. DE/* */LETE → DELETE.
    // A space replacement would turn it into "DE LETE", hiding the keyword.
    const stripped = sqlText
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/--.*$/gm, "")
      .trim();

    // Strip string literals so that mutation keywords/functions inside quoted
    // strings are ignored. Handles single-quoted ('...'), dollar-quoted
    // ($$...$$), and tagged dollar-quoted ($tag$...$tag$) strings.
    const noLiterals = stripped
      .replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, " ")
      .replace(/'(?:[^']|'')*'/g, " ");

    // For keyword checks, also strip double-quoted identifiers to avoid
    // matching words inside quoted table/column names.
    const noStrings = noLiterals.replace(/"(?:[^"]|"")*"/g, " ");

    const mutationKeywords = [
      // ── DML ────────────────────────────────────────────────────────────
      "INSERT",
      "UPDATE",
      "DELETE",
      "INTO",
      "COPY",
      "MERGE",
      // ── DDL ────────────────────────────────────────────────────────────
      "DROP",
      "ALTER",
      "TRUNCATE",
      "CREATE",
      "COMMENT",
      // ── Admin / privilege ──────────────────────────────────────────────
      "GRANT",
      "REVOKE",
      "SET",
      "RESET",
      "LOAD",
      // ── Maintenance ────────────────────────────────────────────────────
      "VACUUM",
      "REINDEX",
      "CLUSTER",
      "REFRESH",
      "DISCARD",
      // ── Procedural ─────────────────────────────────────────────────────
      "CALL",
      "DO",
      // ── Async notifications (side-effects) ─────────────────────────────
      "LISTEN",
      "UNLISTEN",
      "NOTIFY",
      // ── Prepared statements (can wrap mutations) ───────────────────────
      "PREPARE",
      "EXECUTE",
      "DEALLOCATE",
      // ── Locking ────────────────────────────────────────────────────────
      "LOCK",
    ];
    // Match mutation keywords as whole words (word boundary) anywhere in the
    // query, catching them inside CTEs, subqueries, etc.
    const mutationPattern = new RegExp(
      `\\b(${mutationKeywords.join("|")})\\b`,
      "i",
    );
    const match = mutationPattern.exec(noStrings);
    if (match) {
      sendJsonError(
        res,
        `Query rejected: "${match[1].toUpperCase()}" is a mutation keyword. Set readOnly: false to execute mutations.`,
      );
      return;
    }

    // PostgreSQL built-in functions that can read/write server files, mutate
    // server state, or cause denial of service.  These appear inside otherwise
    // valid SELECT expressions, so keyword checks alone won't catch them.
    //
    // ── File I/O (arbitrary file read/write on the DB server) ─────────
    //   lo_import('/etc/passwd')        — load file into large object
    //   lo_export(oid, '/tmp/evil')     — write large object to file
    //   lo_unlink(oid)                  — delete large object
    //   pg_read_file('/etc/passwd')     — read server file (superuser)
    //   pg_read_binary_file(...)        — same, binary
    //   pg_write_file(...)              — write to server files (ext. module)
    //   pg_stat_file(...)               — stat a server file
    //   pg_ls_dir(...)                  — list server directory
    //
    // ── Sequence / state mutation ────────────────────────────────────
    //   nextval('seq'), setval('seq', n)
    //
    // ── Denial of service ────────────────────────────────────────────
    //   pg_sleep(n)                     — block connection for n seconds
    //   pg_sleep_for(interval)          — same, interval version
    //   pg_sleep_until(timestamp)       — same, deadline version
    //
    // ── Session / backend control ────────────────────────────────────
    //   pg_terminate_backend(pid)       — kill another connection
    //   pg_cancel_backend(pid)          — cancel a running query
    //   pg_reload_conf()                — reload server configuration
    //   pg_rotate_logfile()             — rotate the server log
    //   set_config(name, value, local)  — SET equivalent as function
    //
    // ── Advisory locks (can deadlock other connections) ───────────────
    //   pg_advisory_lock(key)           — session-level advisory lock
    //   pg_advisory_lock_shared(key)
    //   pg_try_advisory_lock(key)
    const dangerousFunctions = [
      // File I/O
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
      // Sequence / state mutation
      "nextval",
      "setval",
      // Denial of service
      "pg_sleep",
      "pg_sleep_for",
      "pg_sleep_until",
      // Session / backend control
      "pg_terminate_backend",
      "pg_cancel_backend",
      "pg_reload_conf",
      "pg_rotate_logfile",
      "set_config",
      // Advisory locks
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
    const dangerousFnPattern = new RegExp(
      `(?:^|[^\\w$])"?(?:${dangerousFunctions.join("|")})"?\\s*\\(`,
      "i",
    );
    const fnMatch = dangerousFnPattern.exec(noLiterals);
    if (fnMatch) {
      // Extract the function name from the match for the error message.
      const fnNameMatch = fnMatch[0].match(
        new RegExp(`(${dangerousFunctions.join("|")})`, "i"),
      );
      const fnName = fnNameMatch ? fnNameMatch[1].toUpperCase() : "UNKNOWN";
      sendJsonError(
        res,
        `Query rejected: "${fnName}" is a dangerous function that can modify server state. Set readOnly: false to execute this query.`,
      );
      return;
    }

    // Reject multi-statement queries (naive: any semicolon not at the very end)
    const trimmedForSemicolon = stripped.replace(/;\s*$/, "");
    if (trimmedForSemicolon.includes(";")) {
      sendJsonError(
        res,
        "Query rejected: multi-statement queries are not allowed in read-only mode.",
      );
      return;
    }
  }

  const start = Date.now();
  const result = await executeRawSql(runtime, sqlText);
  const durationMs = Date.now() - start;

  const queryResult: QueryResult = {
    columns: result.columns,
    rows: result.rows,
    rowCount: result.rows.length,
    durationMs,
  };

  sendJson(res, queryResult);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Route a database API request. Returns true if handled, false if not matched.
 *
 * Expected URL patterns:
 *   GET    /api/database/status
 *   GET    /api/database/config
 *   PUT    /api/database/config
 *   POST   /api/database/test
 *   GET    /api/database/tables
 *   GET    /api/database/tables/:table/rows
 *   POST   /api/database/tables/:table/rows
 *   PUT    /api/database/tables/:table/rows
 *   DELETE /api/database/tables/:table/rows
 *   POST   /api/database/query
 */
export async function handleDatabaseRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime | null,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? "GET";

  // ── GET /api/database/status ──────────────────────────────────────────
  if (method === "GET" && pathname === "/api/database/status") {
    await handleGetStatus(req, res, runtime);
    return true;
  }

  // ── GET /api/database/config ──────────────────────────────────────────
  if (method === "GET" && pathname === "/api/database/config") {
    handleGetConfig(req, res);
    return true;
  }

  // ── PUT /api/database/config ──────────────────────────────────────────
  if (method === "PUT" && pathname === "/api/database/config") {
    await handlePutConfig(req, res);
    return true;
  }

  // ── POST /api/database/test ───────────────────────────────────────────
  if (method === "POST" && pathname === "/api/database/test") {
    await handleTestConnection(req, res);
    return true;
  }

  // Routes below require a live runtime with a database adapter
  if (!runtime?.adapter) {
    sendJsonError(
      res,
      "Database not available. The agent may not be running or the database adapter is not initialized.",
      503,
    );
    return true;
  }

  // ── GET /api/database/tables ──────────────────────────────────────────
  if (method === "GET" && pathname === "/api/database/tables") {
    await handleGetTables(req, res, runtime);
    return true;
  }

  // ── POST /api/database/query ──────────────────────────────────────────
  if (method === "POST" && pathname === "/api/database/query") {
    await handleQuery(req, res, runtime);
    return true;
  }

  // ── Table row operations: /api/database/tables/:table/rows ────────────
  const rowsMatch = pathname.match(/^\/api\/database\/tables\/([^/]+)\/rows$/);
  if (rowsMatch) {
    const tableNameDecoded = decodeURIComponent(rowsMatch[1]);

    if (method === "GET") {
      await handleGetRows(req, res, runtime, tableNameDecoded);
      return true;
    }
    if (method === "POST") {
      await handleInsertRow(req, res, runtime, tableNameDecoded);
      return true;
    }
    if (method === "PUT") {
      await handleUpdateRow(req, res, runtime, tableNameDecoded);
      return true;
    }
    if (method === "DELETE") {
      await handleDeleteRow(req, res, runtime, tableNameDecoded);
      return true;
    }
  }

  return false;
}
