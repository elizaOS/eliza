/**
 * Idempotent Postgres + Redis migration to a new cloud.
 *
 * Reads from `DATABASE_URL` (the existing Neon in `.env`) and writes to
 * `NEW_POSTGRES_URL`. Re-runs are safe: rows already copied are skipped via
 * `INSERT ... ON CONFLICT DO NOTHING`, and per-table cursors live in a
 * `_migration_state` table on the destination so an interrupted run resumes
 * from the last committed batch.
 *
 * Heavy text/jsonb columns flagged by migration 0081 are uploaded to R2 during
 * the copy and replaced with a `*_storage='r2'` + `*_key=<object-key>` pointer.
 * If R2 isn't configured the script just copies inline.
 *
 * Tables that exist purely as ephemeral state (idempotency keys, anonymous
 * sessions, webhook dedup, daily aggregates) are skipped.
 *
 * Redis: nothing to copy. The script PINGs `NEW_REDIS_URL` if set, then exits.
 * The cache repopulates on first request.
 *
 * Usage:
 *   bun run packages/scripts/migrate-database.ts
 *   bun run packages/scripts/migrate-database.ts --dry-run
 *   bun run packages/scripts/migrate-database.ts --only=users,organizations
 *   bun run packages/scripts/migrate-database.ts --reset
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { loadEnvFiles } from "./local-dev-helpers";

// Existing shell env wins so a one-off `NEW_POSTGRES_URL=… bun run …` works.
// Then .env.local fills gaps; then .env fills the rest.
loadEnvFiles([".env.local", ".env"]);

// Imports below depend on env being loaded first because they read process.env at module init.
const { putObjectText } = await import("../lib/storage/object-store");
const { ObjectNamespaces } = await import("../lib/storage/object-namespace");
const { putTrajectoryPayload } = await import("../lib/services/trajectory-object-storage");
const { objectStorageConfigured } = await import("../lib/storage/s3-compatible-client");

const { Client } = pg;
type PgClient = pg.Client;

// ───────────────────────────────────────────────────────────── CLI parsing ──

interface CliArgs {
  dryRun: boolean;
  noR2: boolean;
  reset: boolean;
  skipMigrate: boolean;
  skipRedis: boolean;
  batchSize: number;
  r2MinBytes: number;
  only: Set<string> | null;
  skip: Set<string>;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    dryRun: false,
    noR2: false,
    reset: false,
    skipMigrate: false,
    skipRedis: false,
    batchSize: 1000,
    r2MinBytes: 1024,
    only: null,
    skip: new Set(),
  };
  for (const raw of argv) {
    const [key, val] = raw.startsWith("--") ? raw.slice(2).split("=", 2) : [raw, undefined];
    switch (key) {
      case "dry-run":
        out.dryRun = true;
        break;
      case "no-r2":
        out.noR2 = true;
        break;
      case "reset":
        out.reset = true;
        break;
      case "skip-migrate":
        out.skipMigrate = true;
        break;
      case "skip-redis":
        out.skipRedis = true;
        break;
      case "batch-size":
        out.batchSize = Math.max(1, Number(val ?? 1000));
        break;
      case "r2-min-bytes":
        out.r2MinBytes = Math.max(0, Number(val ?? 1024));
        break;
      case "only":
        out.only = new Set(
          (val ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
        break;
      case "skip":
        for (const t of (val ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)) {
          out.skip.add(t);
        }
        break;
      default:
        if (raw !== "") throw new Error(`Unknown argument: ${raw}`);
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────── skip / R2 config ──

/**
 * Tables we explicitly do not copy. All of these either expire on their own,
 * dedupe state we'd rather rebuild fresh, or aggregate views we can recompute.
 * `_migration_state` is the destination-only progress table.
 */
const ALWAYS_SKIP = new Set([
  "webhook_events",
  "idempotency_keys",
  "cli_auth_sessions",
  "agent_pairing_tokens",
  "anonymous_sessions",
  "daily_metrics",
  "provider_health",
  "_migration_state",
  "__drizzle_migrations",
]);

interface R2TextField {
  column: string;
  storageColumn: string;
  keyColumn: string;
  namespace: string;
  field: string;
  inlineValueWhenOffloaded?: string;
}

interface R2JsonField extends R2TextField {
  inlineValueWhenOffloaded?: (value: unknown) => unknown;
}

interface R2OffloadConfig {
  /** Special-cased trajectory bundle (system_prompt + user_prompt + response_text). */
  trajectoryBundle?: boolean;
  text: R2TextField[];
  json: R2JsonField[];
}

const R2_TABLES: Record<string, R2OffloadConfig> = {
  llm_trajectories: {
    trajectoryBundle: true,
    text: [],
    json: [],
  },
  conversation_messages: {
    text: [
      {
        column: "content",
        storageColumn: "content_storage",
        keyColumn: "content_key",
        namespace: ObjectNamespaces.ConversationMessageBodies,
        field: "content",
      },
    ],
    json: [
      {
        column: "api_request",
        storageColumn: "api_request_storage",
        keyColumn: "api_request_key",
        namespace: ObjectNamespaces.ConversationMessageApiPayloads,
        field: "api_request",
      },
      {
        column: "api_response",
        storageColumn: "api_response_storage",
        keyColumn: "api_response_key",
        namespace: ObjectNamespaces.ConversationMessageApiPayloads,
        field: "api_response",
      },
    ],
  },
  generations: {
    text: [
      {
        column: "prompt",
        storageColumn: "prompt_storage",
        keyColumn: "prompt_key",
        namespace: ObjectNamespaces.GenerationArtifacts,
        field: "prompt",
      },
      {
        column: "negative_prompt",
        storageColumn: "negative_prompt_storage",
        keyColumn: "negative_prompt_key",
        namespace: ObjectNamespaces.GenerationArtifacts,
        field: "negative_prompt",
      },
      {
        column: "content",
        storageColumn: "content_storage",
        keyColumn: "content_key",
        namespace: ObjectNamespaces.GenerationArtifacts,
        field: "content",
      },
    ],
    json: [
      {
        column: "result",
        storageColumn: "result_storage",
        keyColumn: "result_key",
        namespace: ObjectNamespaces.GenerationArtifacts,
        field: "result",
      },
    ],
  },
  jobs: {
    text: [
      {
        column: "error",
        storageColumn: "error_storage",
        keyColumn: "error_key",
        namespace: ObjectNamespaces.JobPayloads,
        field: "error",
      },
    ],
    json: [
      {
        column: "data",
        storageColumn: "data_storage",
        keyColumn: "data_key",
        namespace: ObjectNamespaces.JobPayloads,
        field: "data",
        inlineValueWhenOffloaded: inlineJobDataForMigration,
      },
      {
        column: "result",
        storageColumn: "result_storage",
        keyColumn: "result_key",
        namespace: ObjectNamespaces.JobPayloads,
        field: "result",
      },
    ],
  },
  containers: {
    text: [
      {
        column: "deployment_log",
        storageColumn: "deployment_log_storage",
        keyColumn: "deployment_log_key",
        namespace: ObjectNamespaces.ContainerDeployLogs,
        field: "deployment_log",
      },
    ],
    json: [],
  },
  agent_events: {
    text: [
      {
        column: "message",
        storageColumn: "message_storage",
        keyColumn: "message_key",
        namespace: ObjectNamespaces.AgentEventBodies,
        field: "message",
      },
    ],
    json: [
      {
        column: "metadata",
        storageColumn: "metadata_storage",
        keyColumn: "metadata_key",
        namespace: ObjectNamespaces.AgentEventBodies,
        field: "metadata",
      },
    ],
  },
  phone_message_log: {
    text: [
      {
        column: "message_body",
        storageColumn: "message_body_storage",
        keyColumn: "message_body_key",
        namespace: ObjectNamespaces.PhoneMessagePayloads,
        field: "message_body",
      },
      {
        column: "media_urls",
        storageColumn: "media_urls_storage",
        keyColumn: "media_urls_key",
        namespace: ObjectNamespaces.PhoneMessagePayloads,
        field: "media_urls",
        inlineValueWhenOffloaded: "[]",
      },
      {
        column: "agent_response",
        storageColumn: "agent_response_storage",
        keyColumn: "agent_response_key",
        namespace: ObjectNamespaces.PhoneMessagePayloads,
        field: "agent_response",
      },
      {
        column: "metadata",
        storageColumn: "metadata_storage",
        keyColumn: "metadata_key",
        namespace: ObjectNamespaces.PhoneMessagePayloads,
        field: "metadata",
        inlineValueWhenOffloaded: "{}",
      },
    ],
    json: [],
  },
  twilio_inbound_calls: {
    text: [],
    json: [
      {
        column: "raw_payload",
        storageColumn: "raw_payload_storage",
        keyColumn: "raw_payload_key",
        namespace: ObjectNamespaces.TwilioInboundPayloads,
        field: "raw_payload",
        inlineValueWhenOffloaded: emptyRecordWhenOffloaded,
      },
    ],
  },
  seo_requests: {
    text: [
      {
        column: "prompt_context",
        storageColumn: "prompt_context_storage",
        keyColumn: "prompt_context_key",
        namespace: ObjectNamespaces.SeoPayloads,
        field: "prompt_context",
      },
    ],
    json: [],
  },
  seo_artifacts: {
    text: [],
    json: [
      {
        column: "data",
        storageColumn: "data_storage",
        keyColumn: "data_key",
        namespace: ObjectNamespaces.SeoPayloads,
        field: "artifact_data",
        inlineValueWhenOffloaded: emptyRecordWhenOffloaded,
      },
    ],
  },
  seo_provider_calls: {
    text: [],
    json: [
      {
        column: "request_payload",
        storageColumn: "request_payload_storage",
        keyColumn: "request_payload_key",
        namespace: ObjectNamespaces.SeoPayloads,
        field: "request_payload",
      },
      {
        column: "response_payload",
        storageColumn: "response_payload_storage",
        keyColumn: "response_payload_key",
        namespace: ObjectNamespaces.SeoPayloads,
        field: "response_payload",
      },
    ],
  },
  vertex_tuning_jobs: {
    text: [],
    json: [
      {
        column: "last_remote_payload",
        storageColumn: "last_remote_payload_storage",
        keyColumn: "last_remote_payload_key",
        namespace: ObjectNamespaces.VertexTuningPayloads,
        field: "last_remote_payload",
        inlineValueWhenOffloaded: emptyRecordWhenOffloaded,
      },
    ],
  },
  agent_sandbox_backups: {
    text: [],
    json: [
      {
        column: "state_data",
        storageColumn: "state_data_storage",
        keyColumn: "state_data_key",
        namespace: ObjectNamespaces.AgentSandboxBackups,
        field: "state_data",
        inlineValueWhenOffloaded: emptyAgentBackupStateWhenOffloaded,
      },
    ],
  },
};

// ─────────────────────────────────────────────── schema introspection types ──

interface ColumnInfo {
  name: string;
  dataType: string;
  isGenerated: boolean;
}

interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  /** Inserted-cursor column for paginated copy (id by default; created_at fallback). */
  cursorColumn: string;
  cursorIsText: boolean;
}

interface CopyStats {
  source: number;
  copied: number;
  skipped: number;
  r2Uploads: number;
  r2BytesOffloaded: number;
}

// ─────────────────────────────────────────────── helpers: schema discovery ──

async function listTables(client: PgClient): Promise<string[]> {
  const r = await client.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return r.rows.map((row) => row.table_name);
}

async function describeTable(client: PgClient, table: string): Promise<TableInfo | null> {
  const cols = await client.query<{
    column_name: string;
    data_type: string;
    is_generated: string;
  }>(
    `
    SELECT column_name, data_type, is_generated
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `,
    [table],
  );
  if (cols.rowCount === 0) return null;

  const pk = await client.query<{ column_name: string }>(
    `
    SELECT a.attname AS column_name
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = $1::regclass AND i.indisprimary
    ORDER BY array_position(i.indkey, a.attnum)
  `,
    [`public."${table}"`],
  );

  const columns: ColumnInfo[] = cols.rows.map((c) => ({
    name: c.column_name,
    dataType: c.data_type,
    isGenerated: c.is_generated === "ALWAYS",
  }));
  const colByName = new Map(columns.map((c) => [c.name, c]));

  const primaryKey = pk.rows.map((r) => r.column_name);

  let cursorColumn = "id";
  if (!colByName.has(cursorColumn)) {
    if (colByName.has("created_at")) cursorColumn = "created_at";
    else if (primaryKey.length === 1) cursorColumn = primaryKey[0];
    else cursorColumn = columns[0].name; // last resort, full-scan friendly
  }
  const cursorMeta = colByName.get(cursorColumn);
  const cursorIsText = !cursorMeta
    ? true
    : cursorMeta.dataType === "uuid" ||
      cursorMeta.dataType.includes("char") ||
      cursorMeta.dataType === "text" ||
      cursorMeta.dataType.startsWith("timestamp") ||
      cursorMeta.dataType === "date";

  return { name: table, columns, primaryKey, cursorColumn, cursorIsText };
}

function intersectColumns(src: TableInfo, dst: TableInfo): ColumnInfo[] {
  const dstByName = new Map(dst.columns.map((c) => [c.name, c]));
  return src.columns.filter((c) => {
    const d = dstByName.get(c.name);
    if (!d) return false;
    if (d.isGenerated) return false; // generated columns can't be inserted
    return true;
  });
}

// ───────────────────────────────────── helpers: progress state on dest DB ──

async function ensureProgressTable(client: PgClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "_migration_state" (
      table_name text PRIMARY KEY,
      last_cursor text,
      rows_copied bigint NOT NULL DEFAULT 0,
      r2_uploads bigint NOT NULL DEFAULT 0,
      r2_bytes bigint NOT NULL DEFAULT 0,
      completed boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function loadProgress(
  client: PgClient,
  table: string,
): Promise<{
  cursor: string | null;
  copied: number;
  r2Uploads: number;
  r2Bytes: number;
  completed: boolean;
}> {
  const r = await client.query<{
    last_cursor: string | null;
    rows_copied: string;
    r2_uploads: string;
    r2_bytes: string;
    completed: boolean;
  }>(
    `SELECT last_cursor, rows_copied, r2_uploads, r2_bytes, completed
     FROM "_migration_state" WHERE table_name = $1`,
    [table],
  );
  if (r.rowCount === 0) {
    return { cursor: null, copied: 0, r2Uploads: 0, r2Bytes: 0, completed: false };
  }
  const row = r.rows[0];
  return {
    cursor: row.last_cursor,
    copied: Number(row.rows_copied),
    r2Uploads: Number(row.r2_uploads),
    r2Bytes: Number(row.r2_bytes),
    completed: row.completed,
  };
}

async function saveProgress(
  client: PgClient,
  table: string,
  cursor: string | null,
  copied: number,
  r2Uploads: number,
  r2Bytes: number,
  completed: boolean,
): Promise<void> {
  await client.query(
    `
    INSERT INTO "_migration_state" (table_name, last_cursor, rows_copied, r2_uploads, r2_bytes, completed, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, now())
    ON CONFLICT (table_name) DO UPDATE SET
      last_cursor = EXCLUDED.last_cursor,
      rows_copied = EXCLUDED.rows_copied,
      r2_uploads = EXCLUDED.r2_uploads,
      r2_bytes = EXCLUDED.r2_bytes,
      completed = EXCLUDED.completed,
      updated_at = now()
  `,
    [table, cursor, copied, r2Uploads, r2Bytes, completed],
  );
}

async function resetProgress(client: PgClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS "_migration_state"`);
  await ensureProgressTable(client);
}

// ────────────────────────────────────────────────────────── R2 offload helpers ──

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function stringRecordField(value: unknown, field: "agentId" | "characterId"): string | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function inlineJobDataForMigration(value: unknown): Record<string, unknown> {
  const inline: Record<string, unknown> = {};
  const agentId = stringRecordField(value, "agentId");
  const characterId = stringRecordField(value, "characterId");
  if (agentId) inline.agentId = agentId;
  if (characterId) inline.characterId = characterId;
  return inline;
}

function emptyRecordWhenOffloaded(): Record<string, unknown> {
  return {};
}

function emptyAgentBackupStateWhenOffloaded(): {
  memories: unknown[];
  config: Record<string, unknown>;
  workspaceFiles: Record<string, string>;
} {
  return { memories: [], config: {}, workspaceFiles: {} };
}

interface OffloadResult {
  inlineValue: unknown;
  storage: "inline" | "r2";
  key: string | null;
  bytes: number;
}

async function offloadText(
  field: R2TextField,
  value: string | null,
  organizationId: string,
  rowId: string,
  createdAt: Date,
  minBytes: number,
): Promise<OffloadResult> {
  if (value == null) return { inlineValue: null, storage: "inline", key: null, bytes: 0 };
  const bytes = byteLength(value);
  if (bytes < minBytes) return { inlineValue: value, storage: "inline", key: null, bytes: 0 };
  const key = await putObjectText({
    namespace: field.namespace as never,
    organizationId,
    objectId: rowId,
    field: field.field,
    createdAt,
    body: value,
    contentType: "text/plain; charset=utf-8",
  });
  return { inlineValue: field.inlineValueWhenOffloaded ?? "", storage: "r2", key, bytes };
}

async function offloadJson(
  field: R2JsonField,
  value: unknown,
  organizationId: string,
  rowId: string,
  createdAt: Date,
  minBytes: number,
): Promise<OffloadResult> {
  if (value == null) return { inlineValue: null, storage: "inline", key: null, bytes: 0 };
  const body = JSON.stringify(value);
  const bytes = byteLength(body);
  if (bytes < minBytes) return { inlineValue: value, storage: "inline", key: null, bytes: 0 };
  const key = await putObjectText({
    namespace: field.namespace as never,
    organizationId,
    objectId: rowId,
    field: field.field,
    createdAt,
    body,
    contentType: "application/json; charset=utf-8",
  });
  return {
    inlineValue: field.inlineValueWhenOffloaded ? field.inlineValueWhenOffloaded(value) : null,
    storage: "r2",
    key,
    bytes,
  };
}

async function offloadTrajectoryBundle(
  row: Record<string, unknown>,
  minBytes: number,
): Promise<{
  storage: "inline" | "r2";
  key: string | null;
  blankPrompts: boolean;
  bytes: number;
}> {
  const sys = (row.system_prompt as string | null) ?? null;
  const usr = (row.user_prompt as string | null) ?? null;
  const resp = (row.response_text as string | null) ?? null;
  if (sys == null && usr == null && resp == null) {
    return { storage: "inline", key: null, blankPrompts: false, bytes: 0 };
  }
  const totalBytes = byteLength(sys ?? "") + byteLength(usr ?? "") + byteLength(resp ?? "");
  if (totalBytes < minBytes) {
    return { storage: "inline", key: null, blankPrompts: false, bytes: 0 };
  }
  const orgId = String(row.organization_id ?? "no-org");
  const id = String(row.id);
  const createdAt = (row.created_at as Date | null) ?? new Date();
  const key = await putTrajectoryPayload({
    organizationId: orgId,
    trajectoryId: id,
    createdAt,
    body: { system_prompt: sys, user_prompt: usr, response_text: resp },
  });
  return { storage: "r2", key, blankPrompts: true, bytes: totalBytes };
}

// ─────────────────────────────────────────────────── value coercion for INSERT ──

function isJsonish(dataType: string): boolean {
  return dataType === "jsonb" || dataType === "json";
}

/**
 * Normalize a value coming back from `pg` into something the destination
 * `INSERT` accepts. The big one: pg auto-parses jsonb on read into JS values
 * (objects, arrays, primitives), and the destination needs the JSON text back
 * to satisfy the `::jsonb` cast — `JSON.stringify` always, even for string
 * scalars (a stored `"awdaw"` returns as the JS string `awdaw` and must go back
 * as the JSON literal `"awdaw"`).
 */
function coerceForInsert(value: unknown, destDataType: string): unknown {
  if (value === null || value === undefined) return null;
  if (isJsonish(destDataType)) return JSON.stringify(value);
  return value;
}

function placeholder(idx: number, destDataType: string): string {
  const base = `$${idx}`;
  if (isJsonish(destDataType)) return `${base}::jsonb`;
  return base;
}

// ───────────────────────────────────────────────────────── per-table copy ──

async function copyTable(
  source: PgClient,
  dest: PgClient,
  tableName: string,
  args: CliArgs,
): Promise<CopyStats> {
  const srcInfo = await describeTable(source, tableName);
  if (!srcInfo) {
    console.log(`  - table missing on source, skipping`);
    return { source: 0, copied: 0, skipped: 0, r2Uploads: 0, r2BytesOffloaded: 0 };
  }
  const dstInfo = await describeTable(dest, tableName);
  if (!dstInfo) {
    console.log(`  - table missing on destination (run migrations first), skipping`);
    return { source: 0, copied: 0, skipped: 0, r2Uploads: 0, r2BytesOffloaded: 0 };
  }

  const sharedCols = intersectColumns(srcInfo, dstInfo);
  if (sharedCols.length === 0) {
    console.log(`  - no shared columns, skipping`);
    return { source: 0, copied: 0, skipped: 0, r2Uploads: 0, r2BytesOffloaded: 0 };
  }

  const srcCount = await source.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM public."${tableName}"`,
  );
  const sourceTotal = Number(srcCount.rows[0].c);

  const prog = await loadProgress(dest, tableName);
  if (prog.completed) {
    console.log(`  - already completed (${prog.copied} rows). Use --reset to redo.`);
    return {
      source: sourceTotal,
      copied: prog.copied,
      skipped: 0,
      r2Uploads: prog.r2Uploads,
      r2BytesOffloaded: prog.r2Bytes,
    };
  }

  const r2Cfg = !args.noR2 && objectStorageConfigured() ? R2_TABLES[tableName] : undefined;
  if (r2Cfg) {
    console.log(`  - R2 offload enabled for this table (min ${args.r2MinBytes} bytes)`);
  } else if (R2_TABLES[tableName] && args.noR2) {
    console.log(`  - R2 offload skipped (--no-r2)`);
  } else if (R2_TABLES[tableName]) {
    console.log(`  - R2 offload skipped (object storage not configured)`);
  }

  // SELECT list = all source columns the destination also has, in source order.
  const selectCols = sharedCols.map((c) => `"${c.name}"`).join(", ");
  const cursorCol = `"${srcInfo.cursorColumn}"`;
  const cursorTypeCast = srcInfo.cursorIsText ? "::text" : "::text";

  let cursor = prog.cursor;
  let copied = prog.copied;
  let r2Uploads = prog.r2Uploads;
  let r2Bytes = prog.r2Bytes;
  let totalSkippedConflicts = 0;
  let batchNum = 0;

  while (true) {
    batchNum += 1;
    const params: unknown[] = [args.batchSize];
    let where = "";
    if (cursor !== null) {
      params.push(cursor);
      where = `WHERE ${cursorCol}${cursorTypeCast} > $2`;
    }

    const result = await source.query<Record<string, unknown>>(
      `SELECT ${selectCols} FROM public."${tableName}" ${where} ORDER BY ${cursorCol} LIMIT $1`,
      params,
    );
    if (result.rowCount === 0) break;

    if (args.dryRun) {
      const last = result.rows[result.rowCount - 1];
      cursor = String(last[srcInfo.cursorColumn]);
      copied += result.rowCount;
      console.log(
        `    batch ${batchNum}: would copy ${result.rowCount} rows (cursor=${cursor.slice(0, 12)}...)`,
      );
      continue;
    }

    // Apply R2 offload + collect insert columns/values per row.
    const insertCols = sharedCols.map((c) => c.name);
    // Destination types drive coercion + casting (jsonb on dest needs stringified JSON).
    const dstTypes = new Map(dstInfo.columns.map((c) => [c.name, c.dataType]));

    // Pre-flight: each row may add storage/key columns the destination has but the source
    // didn't include. We always include them when the destination has them.
    const dstColSet = new Set(dstInfo.columns.filter((c) => !c.isGenerated).map((c) => c.name));

    await dest.query("BEGIN");
    try {
      for (const row of result.rows) {
        const rowOut: Record<string, unknown> = { ...row };

        if (r2Cfg) {
          const orgId = String(rowOut.organization_id ?? "no-org");
          const rowId = String(rowOut.id ?? rowOut[srcInfo.primaryKey[0] ?? "id"]);
          const createdAt = (rowOut.created_at as Date | null) ?? new Date();

          if (r2Cfg.trajectoryBundle) {
            // Source row already lives in R2: copy the pointer through, don't re-upload.
            const alreadyOffloaded = rowOut.trajectory_payload_storage === "r2";
            if (!alreadyOffloaded) {
              const r = await offloadTrajectoryBundle(rowOut, args.r2MinBytes);
              if (r.storage === "r2") {
                rowOut.trajectory_payload_storage = "r2";
                rowOut.trajectory_payload_key = r.key;
                if (r.blankPrompts) {
                  rowOut.system_prompt = null;
                  rowOut.user_prompt = null;
                  rowOut.response_text = null;
                }
                r2Uploads += 1;
                r2Bytes += r.bytes;
              }
            }
          }

          for (const f of r2Cfg.text) {
            if (!(f.column in rowOut)) continue;
            // Source row already lives in R2: copy the pointer through, don't re-upload.
            if (rowOut[f.storageColumn] === "r2") continue;
            const r = await offloadText(
              f,
              (rowOut[f.column] as string | null) ?? null,
              orgId,
              rowId,
              createdAt,
              args.r2MinBytes,
            );
            if (r.storage === "r2") {
              rowOut[f.column] = r.inlineValue;
              rowOut[f.storageColumn] = "r2";
              rowOut[f.keyColumn] = r.key;
              r2Uploads += 1;
              r2Bytes += r.bytes;
            }
          }

          for (const f of r2Cfg.json) {
            if (!(f.column in rowOut)) continue;
            if (rowOut[f.storageColumn] === "r2") continue;
            const r = await offloadJson(
              f,
              rowOut[f.column],
              orgId,
              rowId,
              createdAt,
              args.r2MinBytes,
            );
            if (r.storage === "r2") {
              rowOut[f.column] = r.inlineValue;
              rowOut[f.storageColumn] = "r2";
              rowOut[f.keyColumn] = r.key;
              r2Uploads += 1;
              r2Bytes += r.bytes;
            }
          }
        }

        if (tableName === "jobs") {
          rowOut.agent_id ??= stringRecordField(row.data, "agentId");
          rowOut.character_id ??= stringRecordField(row.data, "characterId");
        }

        // Build the actual insert column list for this row (the offload may have introduced
        // storage/key columns that aren't in `insertCols`).
        const finalCols = new Set<string>(insertCols);
        if (r2Cfg) {
          if (r2Cfg.trajectoryBundle) {
            for (const c of [
              "trajectory_payload_storage",
              "trajectory_payload_key",
              "system_prompt",
              "user_prompt",
              "response_text",
            ]) {
              if (dstColSet.has(c)) finalCols.add(c);
            }
          }
          for (const f of [...r2Cfg.text, ...r2Cfg.json]) {
            if (dstColSet.has(f.storageColumn)) finalCols.add(f.storageColumn);
            if (dstColSet.has(f.keyColumn)) finalCols.add(f.keyColumn);
          }
        }
        if (tableName === "jobs") {
          if (dstColSet.has("agent_id")) finalCols.add("agent_id");
          if (dstColSet.has("character_id")) finalCols.add("character_id");
        }
        const orderedCols = [...finalCols];

        const values: unknown[] = [];
        const placeholders: string[] = [];
        orderedCols.forEach((c, i) => {
          const dt = dstTypes.get(c) ?? "text";
          values.push(coerceForInsert(rowOut[c], dt));
          placeholders.push(placeholder(i + 1, dt));
        });

        // Targetless ON CONFLICT DO NOTHING catches the PK *and* every other unique
        // constraint/index, which matters for tables like service_pricing that the
        // schema migrations themselves seed before we ever copy.
        const sql = `INSERT INTO public."${tableName}" (${orderedCols
          .map((c) => `"${c}"`)
          .join(", ")}) VALUES (${placeholders.join(", ")}) ON CONFLICT DO NOTHING`;

        const ins = await dest.query(sql, values);
        if (ins.rowCount === 0) totalSkippedConflicts += 1;
        else copied += 1;
      }

      const last = result.rows[result.rowCount - 1];
      cursor = String(last[srcInfo.cursorColumn]);
      await saveProgress(dest, tableName, cursor, copied, r2Uploads, r2Bytes, false);
      await dest.query("COMMIT");
    } catch (err) {
      await dest.query("ROLLBACK");
      throw err;
    }

    process.stdout.write(
      `    batch ${batchNum}: ${result.rowCount} processed (copied=${copied}, conflicts=${totalSkippedConflicts}, r2=${r2Uploads})\r`,
    );
    if (result.rowCount < args.batchSize) break;
  }

  if (!args.dryRun) {
    await saveProgress(dest, tableName, cursor, copied, r2Uploads, r2Bytes, true);
  }
  process.stdout.write("\n");
  return {
    source: sourceTotal,
    copied,
    skipped: totalSkippedConflicts,
    r2Uploads,
    r2BytesOffloaded: r2Bytes,
  };
}

// ─────────────────────────────────────────── apply schema migrations to dest ──

function runDestMigrations(newUrl: string): void {
  console.log("→ Applying drizzle migrations to destination…");
  const child = spawnSync(
    "bun",
    ["run", path.join("packages", "scripts", "migrate-with-diagnostics.ts")],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: newUrl,
      },
    },
  );
  if (child.status !== 0) {
    throw new Error(`Destination migrations failed (exit code ${child.status})`);
  }
}

// ───────────────────────────────────────────────────────────── Redis check ──

async function checkRedis(newRedisUrl: string): Promise<void> {
  console.log(`→ Verifying new Redis at ${newRedisUrl.replace(/\/\/[^@]+@/, "//***@")}`);
  const { createClient } = await import("redis");
  const client = createClient({ url: newRedisUrl });
  client.on("error", () => {
    /* surfaced via the await below */
  });
  await client.connect();
  const pong = await client.ping();
  if (pong !== "PONG") throw new Error(`Unexpected PING response: ${pong}`);
  await client.quit();
  console.log("  ✓ Redis reachable. Cache will repopulate on first request.");
}

// ───────────────────────────────────────────────────── topological FK order ──

/**
 * Order tables so that FK referents are inserted before dependents. We tolerate
 * cycles (users<->organizations is the canonical one) by inserting the cycle
 * tables last and relying on `ON CONFLICT DO NOTHING` + post-pass updates if
 * needed. Most managed Postgres providers permit `SET session_replication_role`
 * for the table owner; if so, we skip the topo sort entirely.
 */
async function topologicalOrder(client: PgClient, tables: string[]): Promise<string[]> {
  const setT = new Set(tables);
  const fks = await client.query<{ table_name: string; foreign_table_name: string }>(`
    SELECT
      tc.table_name AS table_name,
      ccu.table_name AS foreign_table_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
     AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
  `);
  const deps = new Map<string, Set<string>>();
  for (const t of tables) deps.set(t, new Set());
  for (const r of fks.rows) {
    if (!setT.has(r.table_name) || !setT.has(r.foreign_table_name)) continue;
    if (r.table_name === r.foreign_table_name) continue;
    deps.get(r.table_name)!.add(r.foreign_table_name);
  }

  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (n: string): void => {
    if (visited.has(n)) return;
    if (visiting.has(n)) return; // cycle: break the edge, will be retried
    visiting.add(n);
    for (const d of deps.get(n) ?? []) visit(d);
    visiting.delete(n);
    visited.add(n);
    ordered.push(n);
  };
  for (const t of tables) visit(t);
  return ordered;
}

async function trySessionReplicationReplica(client: PgClient): Promise<boolean> {
  try {
    await client.query("SET session_replication_role = 'replica'");
    const r = await client.query<{ s: string }>("SHOW session_replication_role");
    return r.rows[0]?.s === "replica";
  } catch {
    return false;
  }
}

// ───────────────────────────────────────────────────────────────── main ──

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const sourceUrl = process.env.DATABASE_URL;
  const destUrl = process.env.NEW_POSTGRES_URL ?? process.env.NEW_DATABASE_URL;
  if (!sourceUrl) throw new Error("DATABASE_URL (source) is required.");
  if (!destUrl) {
    throw new Error(
      "NEW_POSTGRES_URL (destination) is required. Add it to .env or export it before running.",
    );
  }
  if (sourceUrl === destUrl) {
    throw new Error("Source and destination DATABASE_URL are identical — refusing to run.");
  }

  console.log(`source:      ${sourceUrl.replace(/\/\/[^@]+@/, "//***@")}`);
  console.log(`destination: ${destUrl.replace(/\/\/[^@]+@/, "//***@")}`);
  console.log(`mode:        ${args.dryRun ? "DRY-RUN" : "WRITE"}`);
  console.log(
    `r2:          ${
      args.noR2 ? "disabled (--no-r2)" : objectStorageConfigured() ? "enabled" : "not configured"
    }`,
  );
  if (args.only) console.log(`--only:      ${[...args.only].join(", ")}`);
  if (args.skip.size > 0) console.log(`--skip:      ${[...args.skip].join(", ")}`);

  // 1. Apply destination schema unless skipped.
  if (!args.skipMigrate && !args.dryRun) {
    runDestMigrations(destUrl);
  } else {
    console.log("→ Skipping destination schema migrations (--skip-migrate or --dry-run)");
  }

  // 2. Connect.
  const source = new Client({ connectionString: sourceUrl });
  const dest = new Client({ connectionString: destUrl });
  await source.connect();
  await dest.connect();

  try {
    // 3. Reset progress if asked.
    await ensureProgressTable(dest);
    if (args.reset && !args.dryRun) {
      console.log("→ --reset: dropping _migration_state");
      await resetProgress(dest);
    }

    // 4. Try to disable triggers on dest so we don't have to topo-sort.
    let useTopoOrder = true;
    if (!args.dryRun) {
      const ok = await trySessionReplicationReplica(dest);
      if (ok) {
        useTopoOrder = false;
        console.log("→ Disabled triggers on destination (session_replication_role=replica)");
      } else {
        console.log("→ Could not disable destination triggers; falling back to topological order");
      }
    }

    // 5. Pick tables.
    const allTables = await listTables(source);
    let tables = allTables.filter((t) => !ALWAYS_SKIP.has(t) && !args.skip.has(t));
    if (args.only) tables = tables.filter((t) => args.only!.has(t));

    if (useTopoOrder) {
      tables = await topologicalOrder(source, tables);
    }

    console.log(`\n→ Will process ${tables.length} tables:\n  ${tables.join(", ")}\n`);
    const skipped = allTables.filter((t) => !tables.includes(t));
    if (skipped.length > 0) {
      console.log(`  (skipping: ${skipped.join(", ")})\n`);
    }

    // 6. Copy each.
    const summary: Array<{ table: string; stats: CopyStats }> = [];
    for (const table of tables) {
      console.log(`\n[${table}]`);
      const stats = await copyTable(source, dest, table, args);
      summary.push({ table, stats });
    }

    // 7. Optional Redis check.
    const newRedisUrl = process.env.NEW_REDIS_URL;
    if (newRedisUrl && !args.skipRedis) {
      console.log("");
      try {
        await checkRedis(newRedisUrl);
      } catch (err) {
        console.error(`  ✗ Redis check failed: ${(err as Error).message}`);
      }
    } else if (!newRedisUrl) {
      console.log(
        "\n→ NEW_REDIS_URL not set — skipping Redis check (cache will rebuild on demand)",
      );
    }

    // 8. Print summary.
    console.log("\n─── Summary ────────────────────────────────────────────────");
    let totalSrc = 0;
    let totalCopied = 0;
    let totalR2Uploads = 0;
    let totalR2Bytes = 0;
    for (const { table, stats } of summary) {
      totalSrc += stats.source;
      totalCopied += stats.copied;
      totalR2Uploads += stats.r2Uploads;
      totalR2Bytes += stats.r2BytesOffloaded;
      const r2Suffix =
        stats.r2Uploads > 0
          ? `  r2:${stats.r2Uploads} (${(stats.r2BytesOffloaded / 1024).toFixed(1)} KiB)`
          : "";
      console.log(
        `  ${table.padEnd(40)}  src=${String(stats.source).padStart(8)}  copied=${String(
          stats.copied,
        ).padStart(8)}  skip=${String(stats.skipped).padStart(6)}${r2Suffix}`,
      );
    }
    console.log(
      `  ${"TOTAL".padEnd(40)}  src=${String(totalSrc).padStart(8)}  copied=${String(
        totalCopied,
      ).padStart(
        8,
      )}                r2:${totalR2Uploads} (${(totalR2Bytes / 1024 / 1024).toFixed(2)} MiB)`,
    );
    console.log("────────────────────────────────────────────────────────────");
  } finally {
    await source.end();
    await dest.end();
  }
}

main().catch((err) => {
  console.error("\n[migrate-database] fatal:", err);
  process.exit(1);
});
