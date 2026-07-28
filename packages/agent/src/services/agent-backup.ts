/**
 * Content-hashed agent backup and restore. Captures a full agent snapshot — the
 * database (a PGlite `dumpDataDir` archive, a PGlite file-set, or agent-scoped
 * Postgres rows), the content-addressed media store, the vault (vault.json,
 * `.vault-pglite`, audit log), the runtime character plus its config file, and
 * remaining state-dir files — into a manifest whose every component carries a
 * sha256, then restores each component verifying those hashes and refusing
 * tampered bytes. Also writes, lists, and prunes KMS-encrypted local backup
 * envelope files (`*.agent-backup.json`, AES-256-GCM via `@elizaos/security/kms`)
 * under the state dir, keeping only the most recent few. Restore is destructive
 * and returns `requiresRestart`.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentRuntime, IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { createKmsClient, systemKey } from "@elizaos/security/kms";
import { MAX_RESTORABLE_AGENT_BACKUP_BYTES } from "@elizaos/shared/agent-backup-limits";
import type { ElizaConfig } from "../config/config.ts";
import { resolveConfigPath, resolveStateDir } from "../config/paths.ts";

type JsonRecord = Record<string, unknown>;

const EMPTY_LEGACY_CONFIG_SECTION = Object.freeze({});

export interface AgentBackupFileEntry {
  path: string;
  sha256: string;
  size: number;
  mode?: number;
  mtimeMs?: number;
  bytesBase64: string;
}

export interface AgentBackupFileSet {
  kind: "file-set";
  rootLabel: "state-dir" | "pglite-dir";
  rootPath?: string;
  files: AgentBackupFileEntry[];
  sha256: string;
}

export interface AgentBackupPostgresTable {
  name: string;
  columns: string[];
  rows: JsonRecord[];
}

export interface AgentBackupPostgresDump {
  kind: "postgres-rows";
  tables: AgentBackupPostgresTable[];
  sha256: string;
}

export interface AgentBackupPgliteDump {
  kind: "pglite-dump";
  compression: "gzip";
  file: AgentBackupFileEntry;
  sha256: string;
}

export interface AgentBackupDatabaseComponent {
  kind: "pglite-dump" | "pglite-files" | "postgres-rows" | "none";
  pgliteDump?: AgentBackupPgliteDump;
  pglite?: AgentBackupFileSet;
  postgres?: AgentBackupPostgresDump;
  reason?: string;
  sha256: string;
}

export interface AgentBackupManifest {
  schemaVersion: 1;
  format: "elizaos.agent-backup";
  createdAt: string;
  agentId: string;
  components: {
    database: AgentBackupDatabaseComponent;
    media: AgentBackupFileSet;
    vault: AgentBackupFileSet;
    character: {
      runtimeCharacter: unknown;
      configFile?: AgentBackupFileEntry;
      sha256: string;
    };
    stateFiles: AgentBackupFileSet;
  };
  integrity: {
    componentHashes: Record<string, string>;
  };
}

export interface AgentBackupStateData {
  memories: Array<{ role: string; text: string; timestamp: number }>;
  config: Record<string, unknown>;
  workspaceFiles: Record<string, string>;
  manifest: AgentBackupManifest;
}

export interface AgentBackupFileEnvelope {
  schemaVersion: 1;
  format: "elizaos.agent-backup-file";
  createdAt: string;
  agentId: string;
  stateSha256: string;
  encryption: {
    algorithm: "kms-aes-256-gcm";
    ciphertext: string;
    nonce: string;
    authTag: string;
    kmsKeyId: string;
    kmsKeyVersion: number;
  };
}

export interface LocalAgentBackupMetadata {
  fileName: string;
  path: string;
  createdAt: string;
  agentId: string;
  stateSha256: string;
  sizeBytes: number;
}

/**
 * A capture refused because it would exceed the source-side snapshot budget.
 *
 * Typed so a caller can tell "this agent's state is too large to snapshot"
 * apart from a transport or disk failure: the former is deterministic and
 * retrying identical state cannot help, while the latter is worth another try.
 */
export class AgentSnapshotBudgetExceededError extends Error {
  readonly name = "AgentSnapshotBudgetExceededError";
  constructor(
    readonly stage: string,
    readonly observedBytes: number,
    readonly limitBytes: number,
  ) {
    super(
      `Snapshot refused during ${stage}: ${observedBytes} bytes exceeds the source budget of ${limitBytes} bytes`,
    );
  }
}

/**
 * Produce-side budget for a snapshot capture (#17172 §1).
 *
 * Cloud's restorable-size check is strictly DOWNSTREAM of this process having
 * already assembled AND serialized the whole payload, so it bounds what Cloud
 * retains — never what the agent's own heap burns getting there. A large agent
 * can therefore exhaust its container (the memory watchdog force-restarts at a
 * sustained RSS ceiling) mid-capture, and the lifecycle call sites that snapshot
 * before upgrade/shutdown/sleep silently degrade to a stale or missing backup.
 *
 * Charged as bytes are produced, so an over-budget capture is refused at the
 * first byte past the line instead of after everything is resident. `reserve`
 * exists for the pre-allocation case: a file entry transiently costs ~2.33x its
 * size (Buffer + base64 string), so the refusal has to happen from `stat` before
 * the read, not after — and the reservation HOLDS that capacity until the entry
 * is charged or released, so concurrent captures cannot all pass the same check
 * and then collectively allocate past the limit.
 */
export class SnapshotBudget {
  private chargedBytes = 0;
  private reservedBytes = 0;
  private fileCount = 0;

  constructor(
    private readonly maxRawBytes: number,
    private readonly maxFiles: number,
    private readonly signal?: AbortSignal,
  ) {}

  /** Abort between units of work so a cancelled capture stops promptly. */
  check(): void {
    this.signal?.throwIfAborted();
  }

  /**
   * Hold capacity for a not-yet-read payload from its declared size. Refuses
   * before anything is allocated, counting capacity other in-flight holds have
   * already claimed. The returned token must be settled exactly once: `commit`
   * converts the hold into a charged file entry, `release` frees it.
   */
  reserve(declaredBytes: number): SnapshotReservation {
    this.check();
    // base64 is the wire form, so hold what the entry will actually cost.
    const holdBytes = base64Length(declaredBytes);
    const projected = this.chargedBytes + this.reservedBytes + holdBytes;
    if (projected > this.maxRawBytes) {
      throw new AgentSnapshotBudgetExceededError(
        "file capture",
        projected,
        this.maxRawBytes,
      );
    }
    this.reservedBytes += holdBytes;

    let settled = false;
    const releaseHold = () => {
      if (settled) return false;
      settled = true;
      this.reservedBytes -= holdBytes;
      return true;
    };
    return {
      commit: (actualBase64Bytes: number) => {
        if (!releaseHold()) return;
        this.chargeFileEntry(actualBase64Bytes);
      },
      release: () => {
        releaseHold();
      },
    };
  }

  chargeRaw(bytes: number, stage: string): void {
    this.check();
    this.charge(bytes, stage);
  }

  private chargeFileEntry(base64Bytes: number): void {
    this.check();
    this.fileCount += 1;
    if (this.fileCount > this.maxFiles) {
      throw new AgentSnapshotBudgetExceededError(
        "file capture",
        this.fileCount,
        this.maxFiles,
      );
    }
    this.charge(base64Bytes, "file capture");
  }

  private charge(bytes: number, stage: string): void {
    this.chargedBytes += bytes;
    if (this.chargedBytes + this.reservedBytes > this.maxRawBytes) {
      throw new AgentSnapshotBudgetExceededError(
        stage,
        this.chargedBytes + this.reservedBytes,
        this.maxRawBytes,
      );
    }
  }
}

/** Settle-once token returned by {@link SnapshotBudget.reserve}. */
export interface SnapshotReservation {
  /** Convert the hold into a charged file entry at its actual encoded size. */
  commit(actualBase64Bytes: number): void;
  /** Free the hold without charging (the payload was never materialized). */
  release(): void;
}

/** Encoded length of `n` raw bytes in base64 (4 chars per 3 bytes, padded). */
function base64Length(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

/**
 * File-count ceiling for one capture. Mirrors the hydration-side file cap so a
 * snapshot this process is willing to PRODUCE is one the consumer is willing to
 * expand; a pathological state dir is refused here rather than downstream.
 */
const DEFAULT_SNAPSHOT_MAX_FILES = 5_000;

/**
 * Rows fetched per round-trip when capturing an agent-scoped Postgres table.
 *
 * `pool.query` buffers whatever a statement returns, so an unbounded
 * `SELECT * WHERE agent_id = $1` puts the entire table in this process's heap
 * before the budget can see a single byte. Reading in keyset batches caps that
 * peak at one batch and lets the budget refuse mid-table (#17172 §1).
 */
const POSTGRES_CAPTURE_BATCH_ROWS = 500;

const MEDIA_DIR_NAME = "media";
const BACKUPS_DIR_NAME = "backups";
const LOCAL_BACKUP_EXTENSION = ".agent-backup.json";
const LOCAL_BACKUP_FORMAT = "elizaos.agent-backup-file";
const LOCAL_BACKUP_RETENTION = 10;
const DEFAULT_PGLITE_DIR_NAME = ".elizadb";
const VAULT_PGLITE_DIR_NAME = ".vault-pglite";
const VAULT_AUDIT_DIR_NAME = "audit";
const VAULT_AUDIT_PATH = path.join("audit", "vault.jsonl");
const VAULT_JSON_PATH = "vault.json";
const PGLITE_VOLATILE_ROOT_FILES = new Set([
  "eliza-pglite.lock",
  "postmaster.opts",
  "postmaster.pid",
]);
const PGLITE_DUMP_PATH = "pglite-data-dir.tar.gz";

const POSTGRES_AGENT_ID_COLUMNS = ["agent_id", "agentId"];
const POSTGRES_AGENT_TABLE = "agents";
const POSTGRES_EMBEDDINGS_TABLE = "embeddings";
const POSTGRES_MEMORIES_TABLE = "memories";

const RESTORE_TABLE_ORDER = [
  "agents",
  "worlds",
  "entities",
  "rooms",
  "participants",
  "relationships",
  "memories",
  "embeddings",
  "components",
  "tasks",
  "logs",
  "long_term_memories",
  "session_summaries",
  "memory_access_logs",
  "connector_accounts",
  "connector_account_credentials",
  "connector_account_audit_events",
  "oauth_flows",
  "pairing_allowlist",
  "pairing_requests",
  "approval_requests",
  "auth_sessions",
  "auth_identities",
  "auth_owner_bindings",
  "auth_audit_events",
  "auth_bootstrap_jti_seen",
  "auth_owner_login_tokens",
  "cache",
];

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
let localBackupKmsClient: ReturnType<typeof createKmsClient> | null = null;

function getLocalBackupKmsClient(): ReturnType<typeof createKmsClient> {
  localBackupKmsClient ??= createKmsClient();
  return localBackupKmsClient;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: JsonRecord = {};
    for (const key of Object.keys(value as JsonRecord).sort()) {
      out[key] = canonicalize((value as JsonRecord)[key]);
    }
    return out;
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256Bytes(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha256Json(value: unknown): string {
  return sha256Bytes(stableJson(value));
}

function b64encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function b64decode(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, "base64"));
}

function localBackupAad(agentId: string, stateSha256: string): Uint8Array {
  return textEncoder.encode(`agent-backup-file|${agentId}|${stateSha256}`);
}

function localBackupsDir(): string {
  return path.join(resolveStateDir(), BACKUPS_DIR_NAME);
}

function safeBackupFileName(createdAt: string, agentId: string): string {
  const timestamp = createdAt.replace(/[:.]/g, "-");
  return `${timestamp}-${agentId}${LOCAL_BACKUP_EXTENSION}`;
}

function resolveLocalBackupPath(fileName: string): string {
  if (
    path.basename(fileName) !== fileName ||
    !fileName.endsWith(LOCAL_BACKUP_EXTENSION) ||
    !/^[A-Za-z0-9_.=-]+\.agent-backup\.json$/.test(fileName)
  ) {
    throw new Error(`Invalid backup file name: ${fileName}`);
  }
  const root = path.resolve(localBackupsDir());
  const resolved = path.resolve(root, fileName);
  if (!isWithin(root, resolved)) {
    throw new Error(`Backup file escapes backup directory: ${fileName}`);
  }
  return resolved;
}

function normalizeRelativePath(input: string): string {
  const normalized = path.posix.normalize(input.replaceAll(path.sep, "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Invalid backup path: ${input}`);
  }
  return normalized;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function readFileEntry(
  root: string,
  absolutePath: string,
  budget?: SnapshotBudget,
): Promise<AgentBackupFileEntry> {
  const stat = await fs.stat(absolutePath);
  // Refuse from the declared size BEFORE reading: the entry transiently costs
  // ~2.33x its bytes (Buffer + base64 string), so charging after the read is
  // charging after the damage. The hold stays claimed until the actual encoded
  // size is committed, so concurrent siblings see it.
  const hold = budget?.reserve(stat.size);
  let bytes: Buffer;
  let bytesBase64: string;
  try {
    bytes = await fs.readFile(absolutePath);
    bytesBase64 = bytes.toString("base64");
  } catch (error) {
    hold?.release();
    throw error;
  }
  const relative = normalizeRelativePath(path.relative(root, absolutePath));
  hold?.commit(bytesBase64.length);
  return {
    path: relative,
    sha256: sha256Bytes(bytes),
    size: bytes.length,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    bytesBase64,
  };
}

function fileEntryFromBytes(
  relativePath: string,
  bytes: Buffer,
): AgentBackupFileEntry {
  const normalized = normalizeRelativePath(relativePath);
  return {
    path: normalized,
    sha256: sha256Bytes(bytes),
    size: bytes.length,
    bytesBase64: bytes.toString("base64"),
  };
}

async function collectFileSet(params: {
  root: string;
  rootLabel: AgentBackupFileSet["rootLabel"];
  include?: (relativePath: string) => boolean;
  budget?: SnapshotBudget;
}): Promise<AgentBackupFileSet> {
  const root = path.resolve(params.root);
  const files: AgentBackupFileEntry[] = [];
  if (!(await pathExists(root))) {
    return withFileSetHash({
      kind: "file-set",
      rootLabel: params.rootLabel,
      rootPath: root,
      files,
      sha256: "",
    });
  }

  async function visit(dir: string): Promise<void> {
    // Stop descending promptly once the capture is cancelled or over budget.
    params.budget?.check();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (!isWithin(root, absolute)) continue;
      const relative = normalizeRelativePath(path.relative(root, absolute));
      if (params.include && !params.include(relative)) continue;
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        files.push(await readFileEntry(root, absolute, params.budget));
      }
    }
  }

  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return withFileSetHash({
    kind: "file-set",
    rootLabel: params.rootLabel,
    rootPath: root,
    files,
    sha256: "",
  });
}

function withFileSetHash(fileSet: AgentBackupFileSet): AgentBackupFileSet {
  const hashInput = fileSet.files.map(({ path, sha256, size }) => ({
    path,
    sha256,
    size,
  }));
  return { ...fileSet, sha256: sha256Json(hashInput) };
}

function baseStateFileInclude(relativePath: string): boolean {
  const first = relativePath.split("/")[0];
  if (
    first === MEDIA_DIR_NAME ||
    first === BACKUPS_DIR_NAME ||
    first === DEFAULT_PGLITE_DIR_NAME ||
    first === VAULT_PGLITE_DIR_NAME ||
    relativePath === VAULT_JSON_PATH ||
    relativePath === VAULT_AUDIT_PATH
  ) {
    return false;
  }
  if (relativePath.endsWith(".log")) return false;
  return true;
}

function vaultFileInclude(relativePath: string): boolean {
  return (
    relativePath === VAULT_JSON_PATH ||
    relativePath === VAULT_AUDIT_DIR_NAME ||
    relativePath === VAULT_AUDIT_PATH ||
    relativePath === VAULT_PGLITE_DIR_NAME ||
    relativePath.startsWith(`${VAULT_PGLITE_DIR_NAME}/`)
  );
}

function pgliteFileInclude(relativePath: string): boolean {
  const first = relativePath.split("/")[0];
  if (PGLITE_VOLATILE_ROOT_FILES.has(relativePath)) return false;
  if (first.startsWith(".s.PGSQL.")) return false;
  if (relativePath === "pg_stat_tmp" || relativePath.startsWith("pg_stat_tmp/"))
    return false;
  return true;
}

async function removePgliteVolatileFiles(root: string): Promise<void> {
  await Promise.all(
    [...PGLITE_VOLATILE_ROOT_FILES].map((fileName) =>
      fs.rm(path.join(root, fileName), { force: true }),
    ),
  );
  await fs.rm(path.join(root, "pg_stat_tmp"), {
    recursive: true,
    force: true,
  });
  const entries = await fs
    .readdir(root, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  await Promise.all(
    entries
      .filter((entry) => entry.name.startsWith(".s.PGSQL."))
      .map((entry) => fs.rm(path.join(root, entry.name), { force: true })),
  );
}

function relativeRootWithin(
  root: string,
  target: string | null,
): string | null {
  if (!target) return null;
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    return null;
  return normalizeRelativePath(relative);
}

function makeStateFileInclude(
  stateDir: string,
  pgliteDir: string | null,
): (relativePath: string) => boolean {
  const pgliteRelativeRoot = relativeRootWithin(
    path.resolve(stateDir),
    pgliteDir ? path.resolve(pgliteDir) : null,
  );
  return (relativePath: string): boolean => {
    if (!baseStateFileInclude(relativePath)) return false;
    if (
      pgliteRelativeRoot &&
      (relativePath === pgliteRelativeRoot ||
        relativePath.startsWith(`${pgliteRelativeRoot}/`))
    ) {
      return false;
    }
    return true;
  };
}

async function resolvePgliteDir(): Promise<string> {
  const configured = process.env.PGLITE_DATA_DIR?.trim();
  if (configured) {
    return configured.startsWith("~")
      ? path.join(process.cwd(), configured.slice(1))
      : path.resolve(configured);
  }

  let current = process.cwd();
  while (true) {
    if (await pathExists(path.join(current, "packages", "core"))) {
      return path.join(current, ".eliza", ".elizadb");
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.join(process.cwd(), ".eliza", ".elizadb");
}

function hasPostgresUrl(
  runtime?: IAgentRuntime | AgentRuntime | null,
): string | null {
  const runtimeSetting = runtime?.getSetting?.("POSTGRES_URL");
  if (typeof runtimeSetting === "string" && runtimeSetting.trim()) {
    return runtimeSetting.trim();
  }
  return (
    process.env.POSTGRES_URL?.trim() || process.env.DATABASE_URL?.trim() || null
  );
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

function agentIdColumn(columns: Set<string>): string | null {
  for (const candidate of POSTGRES_AGENT_ID_COLUMNS) {
    if (columns.has(candidate)) return candidate;
  }
  return null;
}

function getTableColumnsBucket(
  tableColumns: Map<string, string[]>,
  tableName: string,
): string[] {
  const existing = tableColumns.get(tableName);
  if (existing) return existing;
  const columns: string[] = [];
  tableColumns.set(tableName, columns);
  return columns;
}

/**
 * Read an agent-scoped table in keyset batches, charging the budget per batch.
 *
 * Keyset (`id > $last ORDER BY id LIMIT n`) rather than OFFSET: OFFSET re-scans
 * from the start on every page and skips or duplicates rows as they shift under
 * a live agent. Ordering on the primary key makes each batch disjoint and the
 * walk resumable.
 *
 * What this bounds is MEMORY — the peak is one batch, not the table, and the
 * budget is charged after each batch so an oversized table stops the capture
 * partway. What it does NOT provide is transactional consistency: each batch
 * runs as its own statement against its own MVCC snapshot, so rows committed
 * mid-walk may or may not appear, and cross-table capture points differ. A
 * capture of a live agent is a best-effort walk, not a frozen snapshot; the
 * lifecycle call sites that need a consistent image quiesce the agent first.
 */
export async function fetchAgentScopedRowsBatched(
  pool: {
    query: (text: string, values: unknown[]) => Promise<{ rows: unknown[] }>;
  },
  buildSql: (keysetClause: string) => string,
  baseParams: unknown[],
  budget: SnapshotBudget | undefined,
  tableName: string,
  // Qualified for a join (`e."id"`), bare otherwise — the ORDER BY must be
  // unambiguous or Postgres rejects the statement.
  idExpression: string,
): Promise<JsonRecord[]> {
  const rows: JsonRecord[] = [];
  let lastId: unknown = null;
  for (;;) {
    budget?.check();
    const params = lastId === null ? baseParams : [...baseParams, lastId];
    const keysetClause =
      lastId === null
        ? `ORDER BY ${idExpression} LIMIT ${POSTGRES_CAPTURE_BATCH_ROWS}`
        : `AND ${idExpression} > $${baseParams.length + 1} ORDER BY ${idExpression} LIMIT ${POSTGRES_CAPTURE_BATCH_ROWS}`;
    const batch = (await pool.query(buildSql(keysetClause), params))
      .rows as JsonRecord[];
    if (batch.length === 0) break;
    budget?.chargeRaw(
      Buffer.byteLength(JSON.stringify(batch), "utf8"),
      `postgres table ${tableName}`,
    );
    rows.push(...batch);
    if (batch.length < POSTGRES_CAPTURE_BATCH_ROWS) break;
    lastId = batch[batch.length - 1]?.id ?? null;
    // A table whose last row carries no usable id cannot be walked further;
    // stopping is the honest outcome rather than looping on the same page.
    if (lastId === null) break;
  }
  return rows;
}

async function capturePostgresRows(
  postgresUrl: string,
  agentId: string,
  budget?: SnapshotBudget,
): Promise<AgentBackupPostgresDump> {
  const pgModule = await import("pg");
  const pool = new pgModule.default.Pool({
    connectionString: postgresUrl,
    max: 1,
  });
  try {
    const columnsResult = await pool.query<{
      table_name: string;
      column_name: string;
      ordinal_position: number;
    }>(
      `SELECT table_name, column_name, ordinal_position
       FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, ordinal_position`,
    );
    const tableColumns = new Map<string, string[]>();
    for (const row of columnsResult.rows) {
      const columns = getTableColumnsBucket(tableColumns, row.table_name);
      columns.push(row.column_name);
    }

    const tables: AgentBackupPostgresTable[] = [];
    for (const [tableName, columns] of tableColumns) {
      const columnSet = new Set(columns);
      let rows: JsonRecord[] = [];
      // Batched reads charge per batch; the single-read paths charge below.
      let charged = false;
      if (tableName === POSTGRES_AGENT_TABLE && columnSet.has("id")) {
        const result = await pool.query(
          `SELECT * FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier("id")} = $1`,
          [agentId],
        );
        rows = result.rows as JsonRecord[];
      } else if (
        tableName === POSTGRES_EMBEDDINGS_TABLE &&
        columnSet.has("memory_id")
      ) {
        if (columnSet.has("id")) {
          rows = await fetchAgentScopedRowsBatched(
            pool,
            (keyset) =>
              `SELECT e.*
               FROM ${quoteIdentifier(tableName)} e
               INNER JOIN ${quoteIdentifier(POSTGRES_MEMORIES_TABLE)} m
                 ON e.${quoteIdentifier("memory_id")} = m.${quoteIdentifier("id")}
               WHERE m.${quoteIdentifier("agent_id")} = $1 ${keyset}`,
            [agentId],
            budget,
            tableName,
            `e.${quoteIdentifier("id")}`,
          );
          charged = true;
        } else {
          const result = await pool.query(
            `SELECT e.*
             FROM ${quoteIdentifier(tableName)} e
             INNER JOIN ${quoteIdentifier(POSTGRES_MEMORIES_TABLE)} m
               ON e.${quoteIdentifier("memory_id")} = m.${quoteIdentifier("id")}
             WHERE m.${quoteIdentifier("agent_id")} = $1`,
            [agentId],
          );
          rows = result.rows as JsonRecord[];
        }
      } else {
        const ownerColumn = agentIdColumn(columnSet);
        if (!ownerColumn) continue;
        if (columnSet.has("id")) {
          rows = await fetchAgentScopedRowsBatched(
            pool,
            (keyset) =>
              `SELECT * FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(ownerColumn)} = $1 ${keyset}`,
            [agentId],
            budget,
            tableName,
            quoteIdentifier("id"),
          );
          charged = true;
        } else {
          // No primary key to walk: a single read is the only option, so the
          // peak stays the table. Such tables are the small ones in practice;
          // the post-read charge below still bounds the assembled snapshot.
          const result = await pool.query(
            `SELECT * FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(ownerColumn)} = $1`,
            [agentId],
          );
          rows = result.rows as JsonRecord[];
        }
      }
      if (
        tableName === POSTGRES_AGENT_TABLE ||
        tableName === POSTGRES_EMBEDDINGS_TABLE ||
        agentIdColumn(columnSet)
      ) {
        // Batched reads already charged per batch; only the single-read paths
        // (a keyless table, or the single-row agent row) are charged here.
        if (!charged) {
          budget?.chargeRaw(
            Buffer.byteLength(JSON.stringify(rows), "utf8"),
            `postgres table ${tableName}`,
          );
        }
        tables.push({ name: tableName, columns, rows });
      }
    }
    tables.sort(
      (left, right) =>
        tableRestoreRank(left.name) - tableRestoreRank(right.name),
    );
    return withPostgresHash({ kind: "postgres-rows", tables, sha256: "" });
  } finally {
    await pool.end();
  }
}

function withPostgresHash(
  dump: AgentBackupPostgresDump,
): AgentBackupPostgresDump {
  return {
    ...dump,
    sha256: sha256Json(
      dump.tables.map((table) => ({
        name: table.name,
        columns: table.columns,
        rows: table.rows,
      })),
    ),
  };
}

function withPgliteDumpHash(
  dump: AgentBackupPgliteDump,
): AgentBackupPgliteDump {
  return {
    ...dump,
    sha256: sha256Json({
      kind: dump.kind,
      compression: dump.compression,
      file: {
        path: dump.file.path,
        sha256: dump.file.sha256,
        size: dump.file.size,
      },
    }),
  };
}

function isBlobLike(value: unknown): value is {
  arrayBuffer: () => Promise<ArrayBuffer>;
  size: number;
} {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function" &&
    typeof (value as { size?: unknown }).size === "number"
  );
}

async function capturePgliteDump(
  runtime: IAgentRuntime | AgentRuntime,
  budget?: SnapshotBudget,
): Promise<AgentBackupPgliteDump | null> {
  const raw = (
    runtime.adapter as
      | {
          getRawConnection?: () => unknown;
        }
      | undefined
  )?.getRawConnection?.();
  if (!raw || typeof raw !== "object") return null;
  const connection = raw as {
    dumpDataDir?: (compression?: "gzip") => Promise<unknown>;
    runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
  };
  const dumpDataDir = connection.dumpDataDir;
  if (typeof dumpDataDir !== "function") return null;

  const dump = connection.runExclusive
    ? await connection.runExclusive(() => dumpDataDir.call(connection, "gzip"))
    : await dumpDataDir.call(connection, "gzip");
  if (!isBlobLike(dump)) {
    throw new Error("PGlite dumpDataDir() did not return a Blob/File");
  }
  // Refuse from Blob.size BEFORE arrayBuffer(): the dump would otherwise be
  // resident three times over (ArrayBuffer + Buffer + base64) with the budget
  // none the wiser.
  const hold = budget?.reserve(dump.size);
  let file: AgentBackupFileEntry;
  try {
    const bytes = Buffer.from(await dump.arrayBuffer());
    file = fileEntryFromBytes(PGLITE_DUMP_PATH, bytes);
  } catch (error) {
    hold?.release();
    throw error;
  }
  hold?.commit(file.bytesBase64.length);
  return withPgliteDumpHash({
    kind: "pglite-dump",
    compression: "gzip",
    file,
    sha256: "",
  });
}

async function captureDatabaseComponent(
  runtime: IAgentRuntime | AgentRuntime,
  budget?: SnapshotBudget,
): Promise<AgentBackupDatabaseComponent> {
  const postgresUrl = hasPostgresUrl(runtime);
  if (postgresUrl) {
    const postgres = await capturePostgresRows(
      postgresUrl,
      runtime.agentId,
      budget,
    );
    return {
      kind: "postgres-rows",
      postgres,
      sha256: postgres.sha256,
    };
  }

  const pgliteDir = await resolvePgliteDir();
  if (pgliteDir === ":memory:" || pgliteDir.includes("://")) {
    const reason = `PGlite data dir ${pgliteDir} is not a filesystem directory`;
    return { kind: "none", reason, sha256: sha256Json({ reason }) };
  }

  const pgliteDump = await capturePgliteDump(runtime, budget);
  if (pgliteDump) {
    return {
      kind: "pglite-dump",
      pgliteDump,
      sha256: pgliteDump.sha256,
    };
  }

  const pglite = await collectFileSet({
    root: pgliteDir,
    rootLabel: "pglite-dir",
    include: pgliteFileInclude,
    budget,
  });
  return {
    kind: "pglite-files",
    pglite,
    sha256: pglite.sha256,
  };
}

async function captureCharacterComponent(
  runtime: IAgentRuntime | AgentRuntime,
  budget?: SnapshotBudget,
): Promise<AgentBackupManifest["components"]["character"]> {
  const configPath = resolveConfigPath();
  const configFile = (await pathExists(configPath))
    ? await readFileEntry(path.dirname(configPath), configPath, budget)
    : undefined;
  const component = {
    runtimeCharacter: runtime.character ?? null,
    configFile,
  };
  return { ...component, sha256: sha256Json(component) };
}

function legacyConfigProjection(config: ElizaConfig): Record<string, unknown> {
  return {
    agents: config.agents || EMPTY_LEGACY_CONFIG_SECTION,
    plugins: config.plugins || EMPTY_LEGACY_CONFIG_SECTION,
    features: config.features || EMPTY_LEGACY_CONFIG_SECTION,
    cloud: config.cloud || EMPTY_LEGACY_CONFIG_SECTION,
  };
}

export async function createAgentSnapshot(
  runtime: IAgentRuntime | AgentRuntime,
  config: ElizaConfig,
  options?: { signal?: AbortSignal; maxRawBytes?: number; maxFiles?: number },
): Promise<AgentBackupStateData> {
  // Bound what THIS process materializes. Without it the five captures below
  // run concurrently with no size awareness at all, and the downstream Cloud
  // check only ever sees a payload this heap already paid for (#17172 §1).
  //
  // The internal controller exists so a refusal in ONE component stops the
  // OTHERS: siblings poll `budget.check()` between units of work, and a plain
  // Promise.all rejection would leave them reading and encoding at full speed
  // until they finish on their own.
  const controller = new AbortController();
  const signal = options?.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const budget = new SnapshotBudget(
    options?.maxRawBytes ?? MAX_RESTORABLE_AGENT_BACKUP_BYTES,
    options?.maxFiles ?? DEFAULT_SNAPSHOT_MAX_FILES,
    signal,
  );
  const stateDir = resolveStateDir();
  const pgliteDirForStateFiles = hasPostgresUrl(runtime)
    ? null
    : await resolvePgliteDir();
  const stateFileInclude = makeStateFileInclude(
    stateDir,
    pgliteDirForStateFiles,
  );
  // First failure aborts the shared signal, then allSettled drains the
  // siblings — the failure surfaces once, with no unhandled rejections from
  // captures that were cancelled mid-flight.
  let firstFailure: unknown;
  let failed = false;
  const guarded = async <T>(work: Promise<T>): Promise<T> => {
    try {
      return await work;
    } catch (error) {
      if (!failed) {
        failed = true;
        firstFailure = error;
        controller.abort(error);
      }
      throw error;
    }
  };
  const captures = [
    guarded(captureDatabaseComponent(runtime, budget)),
    guarded(
      collectFileSet({
        root: path.join(stateDir, MEDIA_DIR_NAME),
        rootLabel: "state-dir",
        budget,
      }),
    ),
    guarded(
      collectFileSet({
        root: stateDir,
        rootLabel: "state-dir",
        include: vaultFileInclude,
        budget,
      }),
    ),
    guarded(captureCharacterComponent(runtime, budget)),
    guarded(
      collectFileSet({
        root: stateDir,
        rootLabel: "state-dir",
        include: stateFileInclude,
        budget,
      }),
    ),
  ] as const;
  await Promise.allSettled(captures);
  if (failed) throw firstFailure;
  // Everything settled fulfilled (a rejection would have set `failed`), so
  // this resolves immediately with full inference.
  const [database, media, vault, character, stateFiles] =
    await Promise.all(captures);

  const componentHashes = {
    database: database.sha256,
    media: media.sha256,
    vault: vault.sha256,
    character: character.sha256,
    stateFiles: stateFiles.sha256,
  };
  const manifest: AgentBackupManifest = {
    schemaVersion: 1,
    format: "elizaos.agent-backup",
    createdAt: new Date().toISOString(),
    agentId: runtime.agentId,
    components: {
      database,
      media,
      vault,
      character,
      stateFiles,
    },
    integrity: { componentHashes },
  };

  logger.info(
    {
      agentId: runtime.agentId,
      database: database.kind,
      mediaFiles: media.files.length,
      vaultFiles: vault.files.length,
      stateFiles: stateFiles.files.length,
    },
    "[agent-backup] Snapshot manifest created",
  );

  return {
    memories: [],
    config: legacyConfigProjection(config),
    workspaceFiles: {},
    manifest,
  };
}

async function encryptLocalBackupEnvelope(
  snapshot: AgentBackupStateData,
): Promise<AgentBackupFileEnvelope> {
  const manifest = assertManifest(snapshot);
  const stateSha256 = sha256Json(snapshot);
  const kms = getLocalBackupKmsClient();
  const keyId = systemKey("agent-backup");
  await kms.getOrCreateKey(keyId);
  const encrypted = await kms.encrypt(
    keyId,
    textEncoder.encode(stableJson(snapshot)),
    localBackupAad(manifest.agentId, stateSha256),
  );
  return {
    schemaVersion: 1,
    format: LOCAL_BACKUP_FORMAT,
    createdAt: new Date().toISOString(),
    agentId: manifest.agentId,
    stateSha256,
    encryption: {
      algorithm: "kms-aes-256-gcm",
      ciphertext: b64encode(encrypted.ciphertext),
      nonce: b64encode(encrypted.nonce),
      authTag: b64encode(encrypted.authTag),
      kmsKeyId: encrypted.keyId,
      kmsKeyVersion: encrypted.keyVersion,
    },
  };
}

async function decryptLocalBackupEnvelope(
  envelope: AgentBackupFileEnvelope,
): Promise<AgentBackupStateData> {
  if (
    envelope.format !== LOCAL_BACKUP_FORMAT ||
    envelope.schemaVersion !== 1 ||
    envelope.encryption.algorithm !== "kms-aes-256-gcm"
  ) {
    throw new Error("Unsupported local agent backup file");
  }
  const kms = getLocalBackupKmsClient();
  const plaintext = await kms.decrypt(
    envelope.encryption.kmsKeyId,
    b64decode(envelope.encryption.ciphertext),
    b64decode(envelope.encryption.nonce),
    b64decode(envelope.encryption.authTag),
    localBackupAad(envelope.agentId, envelope.stateSha256),
    envelope.encryption.kmsKeyVersion,
  );
  const snapshot = JSON.parse(
    textDecoder.decode(plaintext),
  ) as AgentBackupStateData;
  const actual = sha256Json(snapshot);
  if (actual !== envelope.stateSha256) {
    throw new Error(
      `Local backup state hash mismatch: expected ${envelope.stateSha256}, got ${actual}`,
    );
  }
  assertManifest(snapshot);
  return snapshot;
}

async function readLocalBackupEnvelope(
  fileName: string,
): Promise<AgentBackupFileEnvelope> {
  const filePath = resolveLocalBackupPath(fileName);
  return JSON.parse(
    await fs.readFile(filePath, "utf8"),
  ) as AgentBackupFileEnvelope;
}

export async function createLocalAgentBackup(
  runtime: IAgentRuntime | AgentRuntime,
  config: ElizaConfig,
): Promise<LocalAgentBackupMetadata> {
  const snapshot = await createAgentSnapshot(runtime, config);
  const envelope = await encryptLocalBackupEnvelope(snapshot);
  const fileName = safeBackupFileName(envelope.createdAt, envelope.agentId);
  const filePath = resolveLocalBackupPath(fileName);
  const body = `${JSON.stringify(envelope, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, body, { mode: 0o600 });
  await pruneLocalBackups(envelope.agentId, fileName);

  logger.info(
    {
      agentId: envelope.agentId,
      fileName,
      stateSha256: envelope.stateSha256,
      sizeBytes: Buffer.byteLength(body),
    },
    "[agent-backup] Local backup file written",
  );

  return {
    fileName,
    path: filePath,
    createdAt: envelope.createdAt,
    agentId: envelope.agentId,
    stateSha256: envelope.stateSha256,
    sizeBytes: Buffer.byteLength(body),
  };
}

async function pruneLocalBackups(
  agentId: string,
  keepFileName: string,
): Promise<void> {
  const backups = await listLocalAgentBackups(agentId);
  const stale = backups
    .filter((backup) => backup.fileName !== keepFileName)
    .slice(Math.max(0, LOCAL_BACKUP_RETENTION - 1));
  await Promise.all(
    stale.map(async (backup) => {
      try {
        await fs.unlink(resolveLocalBackupPath(backup.fileName));
      } catch (error) {
        logger.warn(
          {
            agentId,
            fileName: backup.fileName,
            error,
          },
          "[agent-backup] Failed to prune stale local backup",
        );
      }
    }),
  );
  if (stale.length > 0) {
    logger.info(
      {
        agentId,
        pruned: stale.length,
        retained: LOCAL_BACKUP_RETENTION,
      },
      "[agent-backup] Pruned stale local backup files",
    );
  }
}

export async function listLocalAgentBackups(
  agentId?: string,
): Promise<LocalAgentBackupMetadata[]> {
  const root = localBackupsDir();
  if (!(await pathExists(root))) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const backups: LocalAgentBackupMetadata[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(LOCAL_BACKUP_EXTENSION))
      continue;
    try {
      const filePath = resolveLocalBackupPath(entry.name);
      const envelope = JSON.parse(
        await fs.readFile(filePath, "utf8"),
      ) as AgentBackupFileEnvelope;
      if (
        envelope.format !== LOCAL_BACKUP_FORMAT ||
        envelope.schemaVersion !== 1
      )
        continue;
      if (agentId && envelope.agentId !== agentId) continue;
      const stat = await fs.stat(filePath);
      backups.push({
        fileName: entry.name,
        path: filePath,
        createdAt: envelope.createdAt,
        agentId: envelope.agentId,
        stateSha256: envelope.stateSha256,
        sizeBytes: stat.size,
      });
    } catch (error) {
      logger.warn(
        {
          fileName: entry.name,
          err: error instanceof Error ? error.message : String(error),
        },
        "[agent-backup] Skipping unreadable local backup file",
      );
    }
  }
  return backups.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

export async function restoreLocalAgentBackup(
  runtime: IAgentRuntime | AgentRuntime,
  fileName: string,
): Promise<{ restored: true; requiresRestart: true }> {
  const snapshot = await decryptLocalBackupEnvelope(
    await readLocalBackupEnvelope(fileName),
  );
  return restoreAgentSnapshot(runtime, snapshot);
}

function verifyFileEntry(entry: AgentBackupFileEntry): Buffer {
  const bytes = Buffer.from(entry.bytesBase64, "base64");
  const actual = sha256Bytes(bytes);
  if (actual !== entry.sha256) {
    throw new Error(
      `Backup file hash mismatch for ${entry.path}: expected ${entry.sha256}, got ${actual}`,
    );
  }
  if (entry.size !== bytes.length) {
    throw new Error(
      `Backup file size mismatch for ${entry.path}: expected ${entry.size}, got ${bytes.length}`,
    );
  }
  return bytes;
}

function verifyFileSet(fileSet: AgentBackupFileSet): void {
  const expected = withFileSetHash({ ...fileSet, sha256: "" }).sha256;
  if (expected !== fileSet.sha256) {
    throw new Error(`Backup file-set hash mismatch for ${fileSet.rootLabel}`);
  }
  for (const file of fileSet.files) verifyFileEntry(file);
}

function verifyPgliteDump(dump: AgentBackupPgliteDump): Buffer {
  const expected = withPgliteDumpHash({ ...dump, sha256: "" }).sha256;
  if (expected !== dump.sha256) {
    throw new Error(
      `PGlite dump hash mismatch: expected ${dump.sha256}, got ${expected}`,
    );
  }
  return verifyFileEntry(dump.file);
}

async function pruneExtraFiles(
  root: string,
  include: (relativePath: string) => boolean,
  keepPaths: Set<string>,
): Promise<void> {
  if (!(await pathExists(root))) return;

  async function visit(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (!isWithin(root, absolute)) continue;
      const relative = normalizeRelativePath(path.relative(root, absolute));
      if (!include(relative)) continue;

      if (entry.isDirectory()) {
        await visit(absolute);
        await fs.rmdir(absolute).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOTEMPTY" || error.code === "ENOENT") return;
          throw error;
        });
        continue;
      }

      if (entry.isFile() && !keepPaths.has(relative)) {
        await fs.rm(absolute, { force: true });
      }
    }
  }

  await visit(root);
}

async function restoreFileSet(
  root: string,
  fileSet: AgentBackupFileSet,
  options: {
    replaceRoot?: boolean;
    include?: (relativePath: string) => boolean;
    pruneExtra?: (relativePath: string) => boolean;
  } = {},
): Promise<void> {
  verifyFileSet(fileSet);
  const resolvedRoot = path.resolve(root);
  if (options.replaceRoot) {
    await fs.rm(resolvedRoot, { recursive: true, force: true });
  }
  await fs.mkdir(resolvedRoot, { recursive: true });
  const filesToRestore = options.include
    ? fileSet.files.filter((entry) =>
        options.include?.(normalizeRelativePath(entry.path)),
      )
    : fileSet.files;
  const keepPaths = new Set(
    filesToRestore.map((entry) => normalizeRelativePath(entry.path)),
  );
  if (options.pruneExtra) {
    await pruneExtraFiles(resolvedRoot, options.pruneExtra, keepPaths);
  }
  for (const entry of filesToRestore) {
    const relative = normalizeRelativePath(entry.path);
    const destination = path.resolve(resolvedRoot, relative);
    if (!isWithin(resolvedRoot, destination)) {
      throw new Error(`Backup file escapes restore root: ${entry.path}`);
    }
    const bytes = verifyFileEntry(entry);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes, {
      mode: typeof entry.mode === "number" ? entry.mode & 0o777 : undefined,
    });
    if (typeof entry.mtimeMs === "number") {
      const mtime = new Date(entry.mtimeMs);
      await fs.utimes(destination, mtime, mtime).catch(() => undefined);
    }
  }
}

async function restorePgliteDump(
  pgliteDir: string,
  dump: AgentBackupPgliteDump,
): Promise<void> {
  const bytes = verifyPgliteDump(dump);
  await fs.rm(pgliteDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(pgliteDir), { recursive: true });

  const { PGlite } = await import("@electric-sql/pglite");
  const blobBytes = new Uint8Array(bytes);
  const database = new PGlite({
    dataDir: pgliteDir,
    loadDataDir: new Blob([blobBytes], { type: "application/gzip" }),
  });
  try {
    await database.waitReady;
  } finally {
    await database.close();
  }
  await removePgliteVolatileFiles(pgliteDir);
}

function tableRestoreRank(tableName: string): number {
  const index = RESTORE_TABLE_ORDER.indexOf(tableName);
  return index === -1 ? RESTORE_TABLE_ORDER.length : index;
}

function sortedTablesForRestore(
  tables: AgentBackupPostgresTable[],
): AgentBackupPostgresTable[] {
  return [...tables].sort(
    (left, right) => tableRestoreRank(left.name) - tableRestoreRank(right.name),
  );
}

function sortedTablesForDelete(
  tables: AgentBackupPostgresTable[],
): AgentBackupPostgresTable[] {
  return sortedTablesForRestore(tables).reverse();
}

async function restorePostgresRows(
  postgresUrl: string,
  agentId: string,
  dump: AgentBackupPostgresDump,
): Promise<void> {
  const expected = withPostgresHash({ ...dump, sha256: "" }).sha256;
  if (expected !== dump.sha256) {
    throw new Error(
      `Postgres dump hash mismatch: expected ${dump.sha256}, got ${expected}`,
    );
  }

  const pgModule = await import("pg");
  const pool = new pgModule.default.Pool({
    connectionString: postgresUrl,
    max: 1,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client
      .query(
        `DELETE FROM ${quoteIdentifier(POSTGRES_EMBEDDINGS_TABLE)}
       WHERE ${quoteIdentifier("memory_id")} IN (
         SELECT ${quoteIdentifier("id")}
         FROM ${quoteIdentifier(POSTGRES_MEMORIES_TABLE)}
         WHERE ${quoteIdentifier("agent_id")} = $1
       )`,
        [agentId],
      )
      .catch(() => undefined);

    for (const table of sortedTablesForDelete(dump.tables)) {
      if (table.name === POSTGRES_EMBEDDINGS_TABLE) continue;
      if (table.name === POSTGRES_AGENT_TABLE) continue;
      const columnSet = new Set(table.columns);
      const ownerColumn = agentIdColumn(columnSet);
      if (!ownerColumn) continue;
      await client.query(
        `DELETE FROM ${quoteIdentifier(table.name)} WHERE ${quoteIdentifier(ownerColumn)} = $1`,
        [agentId],
      );
    }
    await client
      .query(
        `DELETE FROM ${quoteIdentifier(POSTGRES_AGENT_TABLE)} WHERE ${quoteIdentifier("id")} = $1`,
        [agentId],
      )
      .catch(() => undefined);

    for (const table of sortedTablesForRestore(dump.tables)) {
      if (table.rows.length === 0) continue;
      const quotedColumns = table.columns.map(quoteIdentifier);
      for (const row of table.rows) {
        const values = table.columns.map((column) => row[column] ?? null);
        const placeholders = values.map((_, index) => `$${index + 1}`);
        await client.query(
          `INSERT INTO ${quoteIdentifier(table.name)} (${quotedColumns.join(", ")})
           VALUES (${placeholders.join(", ")})`,
          values,
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function assertManifest(snapshot: AgentBackupStateData): AgentBackupManifest {
  const manifest = snapshot.manifest;
  if (
    manifest?.format !== "elizaos.agent-backup" ||
    manifest.schemaVersion !== 1
  ) {
    throw new Error("Unsupported or missing elizaOS backup manifest");
  }
  const actualHashes = {
    database: manifest.components.database.sha256,
    media: manifest.components.media.sha256,
    vault: manifest.components.vault.sha256,
    character: manifest.components.character.sha256,
    stateFiles: manifest.components.stateFiles.sha256,
  };
  if (
    stableJson(actualHashes) !== stableJson(manifest.integrity.componentHashes)
  ) {
    throw new Error("Backup manifest component hash index is inconsistent");
  }
  return manifest;
}

export async function restoreAgentSnapshot(
  runtime: IAgentRuntime | AgentRuntime,
  snapshot: AgentBackupStateData,
): Promise<{ restored: true; requiresRestart: true }> {
  const manifest = assertManifest(snapshot);
  if (manifest.agentId !== runtime.agentId) {
    throw new Error(
      `Backup belongs to agent ${manifest.agentId}, not ${runtime.agentId}`,
    );
  }

  const stateDir = resolveStateDir();
  const database = manifest.components.database;
  let pgliteDirForStateFiles: string | null = null;
  if (database.kind === "postgres-rows") {
    const postgresUrl = hasPostgresUrl(runtime);
    if (!postgresUrl) {
      throw new Error(
        "Backup contains Postgres rows but POSTGRES_URL is not configured",
      );
    }
    if (!database.postgres) {
      throw new Error("Backup database component is missing Postgres rows");
    }
    await restorePostgresRows(postgresUrl, runtime.agentId, database.postgres);
  } else if (database.kind === "pglite-dump") {
    if (!database.pgliteDump) {
      throw new Error("Backup database component is missing PGlite dump");
    }
    const pgliteDir = await resolvePgliteDir();
    pgliteDirForStateFiles = pgliteDir;
    if (pgliteDir === ":memory:" || pgliteDir.includes("://")) {
      throw new Error(
        `Cannot restore PGlite backup into non-filesystem data dir ${pgliteDir}`,
      );
    }
    if (
      typeof (runtime.adapter as { close?: () => Promise<void> }).close ===
      "function"
    ) {
      await (runtime.adapter as { close: () => Promise<void> }).close();
    }
    await restorePgliteDump(pgliteDir, database.pgliteDump);
  } else if (database.kind === "pglite-files") {
    if (!database.pglite) {
      throw new Error("Backup database component is missing PGlite files");
    }
    const pgliteDir = await resolvePgliteDir();
    pgliteDirForStateFiles = pgliteDir;
    if (pgliteDir === ":memory:" || pgliteDir.includes("://")) {
      throw new Error(
        `Cannot restore PGlite backup into non-filesystem data dir ${pgliteDir}`,
      );
    }
    if (
      typeof (runtime.adapter as { close?: () => Promise<void> }).close ===
      "function"
    ) {
      await (runtime.adapter as { close: () => Promise<void> }).close();
    }
    await restoreFileSet(pgliteDir, database.pglite, {
      replaceRoot: true,
      include: pgliteFileInclude,
    });
  } else {
    throw new Error(
      database.reason ?? "Backup did not capture a database component",
    );
  }

  await restoreFileSet(
    path.join(stateDir, MEDIA_DIR_NAME),
    manifest.components.media,
    {
      replaceRoot: true,
    },
  );
  await restoreFileSet(stateDir, manifest.components.vault, {
    pruneExtra: vaultFileInclude,
  });
  await restoreFileSet(stateDir, manifest.components.stateFiles, {
    pruneExtra: makeStateFileInclude(stateDir, pgliteDirForStateFiles),
  });

  if (manifest.components.character.configFile) {
    const configPath = resolveConfigPath();
    const bytes = verifyFileEntry(manifest.components.character.configFile);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, bytes, {
      mode:
        typeof manifest.components.character.configFile.mode === "number"
          ? manifest.components.character.configFile.mode & 0o777
          : 0o600,
    });
  } else {
    await fs.rm(resolveConfigPath(), { force: true });
  }

  logger.info(
    {
      agentId: runtime.agentId,
      database: database.kind,
      mediaFiles: manifest.components.media.files.length,
      vaultFiles: manifest.components.vault.files.length,
      stateFiles: manifest.components.stateFiles.files.length,
    },
    "[agent-backup] Snapshot restored",
  );

  return { restored: true, requiresRestart: true };
}
