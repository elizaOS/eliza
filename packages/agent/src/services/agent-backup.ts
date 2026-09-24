/**
 * Content-hashed agent backup and restore. Captures a full agent snapshot — the
 * database (a PGlite `dumpDataDir` archive, a PGlite file-set, or agent-scoped
 * Postgres rows), the content-addressed media store, the vault (vault.json,
 * `.vault-pglite`, audit log), the runtime character plus its config file, and
 * remaining state-dir files — into a manifest whose every component carries a
 * sha256, then restores each component verifying those hashes and refusing
 * tampered bytes. Also writes, lists, and prunes KMS-encrypted local backup
 * envelope files (`*.agent-backup.json`, AES-256-GCM via `@elizaos/auth/kms`)
 * under the state dir, keeping only the most recent few. Restore is destructive
 * and returns `requiresRestart`. Capture-v2 streams complete binary frames with
 * backpressure and cancellation; both formats share PGlite preflight and file
 * classification helpers without converting streaming payloads to JSON snapshots.
 */
import crypto from "node:crypto";
import nodeFs, { type BigIntStats, constants, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createKmsClient, systemKey } from "@elizaos/auth/kms";
import type { AgentRuntime, IAgentRuntime } from "@elizaos/core";
import { ElizaError, logger, timeInferenceSpan } from "@elizaos/core";
import {
  AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
  AGENT_BACKUP_CAPTURE_V2_LIMITS,
  AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
  type AgentBackupCaptureV2ComponentDescriptor,
  AgentBackupCaptureV2ComponentDescriptorSchema,
  type AgentBackupCaptureV2FileEntry,
  type AgentBackupCaptureV2FrameHeader,
  type AgentBackupCaptureV2Request,
  compareAgentBackupCaptureV2FilePaths,
  parseAgentBackupCaptureV2Request,
  readAgentBackupCaptureV2FrameDigest,
  serializeAgentBackupCaptureV2Frame,
} from "@elizaos/shared";
import { MAX_RESTORABLE_AGENT_BACKUP_BYTES } from "@elizaos/shared/agent-backup-limits";
import {
  AGENT_BACKUP_CANONICAL_JSON,
  stableJsonString,
} from "@elizaos/shared/canonical-json";
import { z } from "zod";
import type { ElizaConfig } from "../config/config.ts";
import {
  resolveConfigPath,
  resolveStateDir,
  resolveUserPath,
} from "../config/paths.ts";
import { cancelAndDrainDeferredBoot } from "../runtime/deferred-boot-owner.ts";
import { resolveDefaultAgentWorkspaceDir } from "../shared/workspace-resolution.ts";
import {
  AGENT_BACKUP_AUTHORITY_DIRECTORY,
  INITIAL_AGENT_BACKUP_GENERATION,
  isBackupAuthorityPath,
  withAgentBackupAuthority,
} from "./agent-backup-authority.ts";

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
  restoreGeneration?: string;
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
export class AgentSnapshotBudgetExceededError extends ElizaError {
  override readonly name = "AgentSnapshotBudgetExceededError";
  constructor(
    readonly stage: string,
    readonly observedBytes: number,
    readonly limitBytes: number,
  ) {
    super(`Snapshot refused during ${stage}: source budget exceeded`, {
      code: "AGENT_SNAPSHOT_BUDGET_EXCEEDED",
      context: { stage, observedBytes, limitBytes },
      severity: "fatal",
    });
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

  assertWireSize(value: unknown): void {
    this.check();
    const wireBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (wireBytes > this.maxRawBytes) {
      throw new AgentSnapshotBudgetExceededError(
        "final wire serialization",
        wireBytes,
        this.maxRawBytes,
      );
    }
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
/** Per-provider model cache / weights under state-dir (`resolveModelsCacheDir`). */
const MODELS_DIR_NAME = "models";
/** Cross-tool on-disk cache root under state-dir (`tools.cache.diskRoot` default). */
const TOOL_CACHE_DIR_NAME = "tool-cache";
/**
 * Generic cache root occasionally used by inference/runtime layers under
 * state-dir. Re-downloadable; must not bloat upgrade snapshots (#17920).
 */
const CACHE_DIR_NAME = "cache";
const LOCAL_BACKUP_EXTENSION = ".agent-backup.json";
const LOCAL_BACKUP_FORMAT = "elizaos.agent-backup-file";
const LOCAL_BACKUP_RETENTION = 10;
const DEFAULT_PGLITE_DIR_NAME = ".elizadb";
const VAULT_PGLITE_DIR_NAME = ".vault-pglite";
const VAULT_AUDIT_DIR_NAME = "audit";
// Always posix-style: collectFileSet/normalizeRelativePath compare against `/`.
const VAULT_AUDIT_PATH = "audit/vault.jsonl";
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

/**
 * Deterministic JSON with recursively sorted object keys — the bytes every
 * backup integrity hash is taken over.
 *
 * Bounded, because both directions run it on content the process does not
 * control. `assertManifest` canonicalizes `manifest.integrity.componentHashes`
 * straight out of a stored backup file, and `decryptLocalBackupEnvelope`
 * canonicalizes the decrypted snapshot BEFORE `assertManifest` has validated
 * its shape — so the unbounded sorted-key recursion this replaces made the
 * integrity gate itself `RangeError` on a deep or cyclic payload, leaving a
 * restore with no reachable error path rather than a clean rejection.
 * Canonical bytes are unchanged for every payload that hashed before, so
 * already-written `stateSha256` envelopes stay verifiable.
 */
function stableJson(value: unknown): string {
  return stableJsonString(value, AGENT_BACKUP_CANONICAL_JSON);
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
  let committed = false;
  try {
    const bytes = await fs.readFile(absolutePath);
    const entry = {
      path: normalizeRelativePath(path.relative(root, absolutePath)),
      sha256: sha256Bytes(bytes),
      size: bytes.length,
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
      bytesBase64: bytes.toString("base64"),
    };
    hold?.commit(Buffer.byteLength(JSON.stringify(entry), "utf8"));
    committed = true;
    return entry;
  } finally {
    if (!committed) hold?.release();
  }
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
  // Plugin import generations are rebuilt from installed sources on boot.
  if (
    relativePath === "plugins/.runtime-imports" ||
    relativePath.startsWith("plugins/.runtime-imports/")
  )
    return false;
  // The catalog is downloadable; its neighboring lock.json records installed skills.
  if (relativePath === "skills/.cache/catalog.json") return false;
  const first = relativePath.split("/")[0];
  if (
    first === AGENT_BACKUP_AUTHORITY_DIRECTORY ||
    first === MEDIA_DIR_NAME ||
    first === BACKUPS_DIR_NAME ||
    first === MODELS_DIR_NAME ||
    first === TOOL_CACHE_DIR_NAME ||
    first === CACHE_DIR_NAME ||
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
    const nextLastId = batch[batch.length - 1]?.id;
    if (nextLastId === null || nextLastId === undefined) {
      throw new ElizaError("Snapshot keyset pagination cannot advance", {
        code: "AGENT_SNAPSHOT_KEYSET_ID_MISSING",
        context: { tableName, idExpression },
        severity: "fatal",
      });
    }
    lastId = nextLastId;
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
  const size = (value as { size?: unknown } | null)?.size;
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function" &&
    typeof size === "number" &&
    Number.isSafeInteger(size) &&
    size >= 0
  );
}

/**
 * Recognizable sentinel for a snapshot that failed because the underlying
 * PGlite connection was closing/closed while `dumpDataDir()` ran — a TRANSIENT
 * teardown-race condition, not data corruption. The 2026-08-11 fleet incident
 * wedged agent restarts because a `dumpDataDir()` against a closing PGlite
 * threw an opaque error that surfaced as `POST /api/snapshot` → HTTP 500,
 * which tripped the cloud restart's fail-closed "Refusing to stop without a
 * current backup" gate and left healthy agents unrestartable. Surfacing this as
 * a distinct condition lets the caller degrade/retry instead of hard-failing.
 */
export const PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT =
  "PGlite snapshot temporarily unavailable (connection closing)";
export const PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT_CODE =
  "PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT";

const PGLITE_BOUNDED_SNAPSHOT_TRANSIENT_CODES = new Set([
  "PGLITE_DATA_DIR_EXPORT_BUSY",
  "AGENT_BACKUP_V2_PGLITE_RSS_BUDGET_EXCEEDED",
  "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_CHANGED",
]);
const LEGACY_PGLITE_POST_DUMP_COPY_FACTOR = 4;

/**
 * A PGlite handle that is mid-close throws with these shapes. Kept narrow so a
 * genuine dump failure (corruption, OOM) still hard-fails rather than being
 * silently treated as transient.
 */
function isPgliteClosingError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err))
    .trim()
    .toLowerCase();
  return (
    message === "closing" ||
    /\b(?:pglite|database|connection)\s+(?:is\s+)?(?:closed|closing)\b/.test(
      message,
    )
  );
}

async function capturePgliteDump(
  runtime: IAgentRuntime | AgentRuntime,
  pgliteDir: string,
  signal: AbortSignal,
  budget?: SnapshotBudget,
): Promise<AgentBackupPgliteDump | null> {
  const adapter = runtime.adapter as
    | {
        dumpPgliteDataDirAfterPreflight?: (
          preflight: () => Promise<PglitePhysicalPreflight>,
          compression?: "gzip",
        ) => Promise<unknown>;
        getPgliteDataDir?: () => unknown;
      }
    | undefined;
  const managedDump = adapter?.dumpPgliteDataDirAfterPreflight;
  if (typeof managedDump !== "function") {
    return null;
  }
  if (typeof adapter?.getPgliteDataDir !== "function") {
    throw new Error(
      "The bounded PGlite exporter cannot attest its physical data directory",
    );
  }
  const managedDataDir = adapter.getPgliteDataDir();
  if (
    typeof managedDataDir !== "string" ||
    managedDataDir.length === 0 ||
    managedDataDir === ":memory:" ||
    managedDataDir.includes("://")
  ) {
    throw new Error(
      "The bounded PGlite exporter is not backed by a physical data directory",
    );
  }

  const [physicalPgliteDir, physicalManagedDataDir] = await Promise.all([
    fs.realpath(path.resolve(pgliteDir)),
    fs.realpath(path.resolve(managedDataDir)),
  ]);
  if (physicalPgliteDir !== physicalManagedDataDir) {
    throw new Error(
      "The bounded PGlite exporter data directory does not match backup configuration",
    );
  }

  let bounded: unknown;
  let provenPreflight: PglitePhysicalPreflight | undefined;
  try {
    bounded = await managedDump.call(
      adapter,
      async () => {
        const proof = await preflightPglitePhysicalDirectory(
          physicalPgliteDir,
          signal,
          runtime.agentId,
        );
        provenPreflight = proof;
        return proof;
      },
      "gzip",
    );
  } catch (err) {
    const code =
      err && typeof err === "object"
        ? (err as { code?: unknown }).code
        : undefined;
    if (
      isPgliteClosingError(err) ||
      (typeof code === "string" &&
        PGLITE_BOUNDED_SNAPSHOT_TRANSIENT_CODES.has(code))
    ) {
      throw new Error(PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT);
    } else {
      throw err;
    }
  }
  if (!bounded || typeof bounded !== "object") {
    throw new Error("The bounded PGlite exporter returned an invalid result");
  }
  const { dump, preflight, release } = bounded as {
    dump?: unknown;
    preflight?: unknown;
    release?: unknown;
  };
  if (typeof release !== "function") {
    throw new Error(
      "The bounded PGlite exporter did not provide a consumer-lifetime lease",
    );
  }

  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };
  try {
    if (preflight !== provenPreflight || !provenPreflight) {
      throw new Error(
        "The bounded PGlite exporter skipped its required preflight",
      );
    }
    if (!isBlobLike(dump)) {
      throw new Error("PGlite dumpDataDir() did not return a Blob/File");
    }
    if (dump.size > provenPreflight.estimatedArchiveBytes) {
      throw new Error("PGlite export exceeds its preflighted archive bound");
    }
    // The shared eight-copy preflight bounds PGlite's directory/tar/gzip/Blob
    // materialization. Legacy JSON then retains up to one ArrayBuffer copy plus
    // 4/3-size base64 and JSON-string copies: 1 + 4/3 + 4/3 < 4. Re-check the
    // remaining memory against those four actual compressed-dump copies before
    // reading the Blob, while the shared export lease is still held.
    const legacyAdditionalMemoryBudgetBytes =
      dump.size * LEGACY_PGLITE_POST_DUMP_COPY_FACTOR;
    const legacyRequiredAvailableMemoryBytes =
      legacyAdditionalMemoryBudgetBytes +
      AGENT_BACKUP_V2_PGLITE_CAPTURE_LIMITS.availableMemoryHeadroomBytes;
    if (
      resolveAgentBackupAvailableMemoryBytes() <
      legacyRequiredAvailableMemoryBytes
    ) {
      throw new Error(PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT);
    }
    // Refuse from Blob.size BEFORE arrayBuffer(): the dump would otherwise be
    // resident three times over (ArrayBuffer + Buffer + base64) with the budget
    // none the wiser.
    const hold = budget?.reserve(dump.size);
    let committed = false;
    try {
      const bytes = Buffer.from(await dump.arrayBuffer());
      const file = fileEntryFromBytes(PGLITE_DUMP_PATH, bytes);
      hold?.commit(Buffer.byteLength(JSON.stringify(file), "utf8"));
      committed = true;
      return withPgliteDumpHash({
        kind: "pglite-dump",
        compression: "gzip",
        file,
        sha256: "",
      });
    } finally {
      if (!committed) hold?.release();
    }
  } finally {
    releaseOnce();
  }
}

async function captureDatabaseComponent(
  runtime: IAgentRuntime | AgentRuntime,
  signal: AbortSignal,
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

  const pgliteDump = await capturePgliteDump(
    runtime,
    pgliteDir,
    signal,
    budget,
  );
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
  budget?.chargeRaw(
    Buffer.byteLength(JSON.stringify(component.runtimeCharacter), "utf8"),
    "runtime character",
  );
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
  return withAgentBackupAuthority(resolveStateDir(), async (authority) =>
    captureAgentSnapshot(
      runtime,
      config,
      await authority.generation(runtime.agentId),
      options,
    ),
  );
}

async function captureAgentSnapshot(
  runtime: IAgentRuntime | AgentRuntime,
  config: ElizaConfig,
  restoreGeneration: string,
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
      // error-policy:J5 every rejection is rethrown and observed by the
      // Promise.allSettled drain below; the first one also cancels siblings.
      if (!failed) {
        failed = true;
        firstFailure = error;
        controller.abort(error);
      }
      throw error;
    }
  };
  const captures = [
    guarded(captureDatabaseComponent(runtime, signal, budget)),
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
    restoreGeneration,
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

  const snapshot = {
    memories: [],
    config: legacyConfigProjection(config),
    workspaceFiles: {},
    manifest,
  };
  budget.chargeRaw(
    Buffer.byteLength(JSON.stringify(snapshot.config), "utf8"),
    "legacy config",
  );
  budget.assertWireSize(snapshot);
  return snapshot;
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
  return withAgentBackupAuthority(resolveStateDir(), async (authority) => {
    const snapshot = await captureAgentSnapshot(
      runtime,
      config,
      await authority.generation(runtime.agentId),
    );
    return persistLocalAgentBackup(snapshot);
  });
}

async function persistLocalAgentBackup(
  snapshot: AgentBackupStateData,
): Promise<LocalAgentBackupMetadata> {
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

// Cache only public listing metadata, never encrypted bodies or restore data.
// Every listing still enumerates the directory and stats each file. The bound
// limits retained process memory, not the number of backups returned.
const LOCAL_BACKUP_METADATA_CACHE_SIZE = 128;
const localBackupMetadataCache = new Map<
  string,
  { version: string; metadata: LocalAgentBackupMetadata }
>();

function localBackupFileVersion(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

export async function listLocalAgentBackups(
  agentId?: string,
): Promise<LocalAgentBackupMetadata[]> {
  const root = localBackupsDir();
  let entries: Dirent[];
  try {
    entries = await timeInferenceSpan("local-backups:directory-list", () =>
      fs.readdir(root, { withFileTypes: true }),
    );
  } catch (error) {
    // error-policy:J3 A missing backup directory is an empty listing. Check
    // existence only after ENOENT so a dangling symlink remains an error,
    // while ordinary listings need no redundant directory stat.
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      !(await timeInferenceSpan("local-backups:directory-stat", () =>
        pathExists(root),
      ))
    )
      return [];
    throw error;
  }
  const backups: LocalAgentBackupMetadata[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(LOCAL_BACKUP_EXTENSION))
      continue;
    try {
      const filePath = resolveLocalBackupPath(entry.name);
      const stat = await fs.stat(filePath, { bigint: true });
      const version = localBackupFileVersion(stat);
      const cached = localBackupMetadataCache.get(filePath);
      if (cached?.version === version) {
        if (!agentId || cached.metadata.agentId === agentId)
          backups.push({ ...cached.metadata });
        continue;
      }
      localBackupMetadataCache.delete(filePath);
      const envelope = JSON.parse(
        await fs.readFile(filePath, "utf8"),
      ) as AgentBackupFileEnvelope;
      if (
        envelope.format !== LOCAL_BACKUP_FORMAT ||
        envelope.schemaVersion !== 1
      )
        continue;
      // Do not associate bytes read during a concurrent write with the older
      // stat identity. A later listing can retry the changed file.
      if (
        localBackupFileVersion(await fs.stat(filePath, { bigint: true })) !==
        version
      )
        continue;
      const metadata: LocalAgentBackupMetadata = {
        fileName: entry.name,
        path: filePath,
        createdAt: envelope.createdAt,
        agentId: envelope.agentId,
        stateSha256: envelope.stateSha256,
        sizeBytes: Number(stat.size),
      };
      if (localBackupMetadataCache.size >= LOCAL_BACKUP_METADATA_CACHE_SIZE) {
        const oldest = localBackupMetadataCache.keys().next().value;
        if (oldest !== undefined) localBackupMetadataCache.delete(oldest);
      }
      localBackupMetadataCache.set(filePath, { version, metadata });
      if (!agentId || metadata.agentId === agentId)
        backups.push({ ...metadata });
    } catch (error) {
      localBackupMetadataCache.delete(path.resolve(root, entry.name));
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

/** Whole-agent archive identities requiring separate owner review before removal. */
export interface RetiredLocalAgentBackup {
  fileName: string;
  archiveSha256: string;
  stateSha256: string;
  restoreGeneration: string;
  createdAt: string;
  sizeBytes: number;
}

const cleanupEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  format: z.literal("elizaos.agent-backup-file"),
  createdAt: z.string().datetime(),
  agentId: z.string().min(1),
  stateSha256: z.string().regex(/^[a-f0-9]{64}$/),
  encryption: z.strictObject({
    algorithm: z.literal("kms-aes-256-gcm"),
    ciphertext: z.string().min(1),
    nonce: z.string().min(1),
    authTag: z.string().min(1),
    kmsKeyId: z.string().min(1),
    kmsKeyVersion: z.number().int().nonnegative(),
  }),
});

/**
 * Authenticates the complete local archive inventory under the snapshot lock.
 * Unlike the diagnostic listing, unreadable archives block review. Results refer
 * to whole-agent backup copies, never permission to delete unrelated live data.
 */
export async function reviewRetiredLocalAgentBackups(agentId: string): Promise<{
  generation: string;
  archives: RetiredLocalAgentBackup[];
}> {
  return withReviewedRetiredLocalAgentBackups(
    agentId,
    async (review) => review,
  );
}

/** Keeps inventory stable until the caller durably admits its reviewed identities. */
export async function withReviewedRetiredLocalAgentBackups<T>(
  agentId: string,
  operation: (review: {
    generation: string;
    archives: RetiredLocalAgentBackup[];
  }) => Promise<T>,
): Promise<T> {
  return withAgentBackupAuthority(resolveStateDir(), async (authority) => {
    const generation = await authority.generation(agentId);
    return operation(await readRetiredLocalAgentBackups(agentId, generation));
  });
}

async function readRetiredLocalAgentBackups(
  agentId: string,
  generation: string,
): Promise<{
  generation: string;
  archives: RetiredLocalAgentBackup[];
}> {
  const root = localBackupsDir();
  let directory: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    directory = await fs.lstat(root);
  } catch (cause) {
    // error-policy:J4 A missing archive directory is an explicit empty inventory.
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return { generation, archives: [] };
    throw new ElizaError(
      "[AgentBackup] Backup directory is unavailable for review",
      {
        code: "AGENT_BACKUP_REVIEW_UNAVAILABLE",
        cause,
      },
    );
  }
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new ElizaError(
      "[AgentBackup] Backup review requires a real directory",
      {
        code: "AGENT_BACKUP_REVIEW_UNAVAILABLE",
      },
    );
  const archives: RetiredLocalAgentBackup[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith(LOCAL_BACKUP_EXTENSION)) continue;
    try {
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new Error("Archive is not a regular file");
      const handle = await fs.open(
        resolveLocalBackupPath(entry.name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let bytes: Buffer;
      try {
        const before = await handle.stat();
        if (!before.isFile()) throw new Error("Archive is not a regular file");
        bytes = await handle.readFile();
        const after = await handle.stat();
        if (
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs ||
          bytes.length !== after.size
        )
          throw new Error("Archive changed during review");
      } finally {
        await handle.close();
      }
      const envelope = cleanupEnvelopeSchema.parse(
        JSON.parse(bytes.toString("utf8")),
      );
      const snapshot = await decryptLocalBackupEnvelope(envelope);
      const manifest = assertManifest(snapshot);
      if (manifest.agentId !== envelope.agentId)
        throw new Error(
          "Authenticated archive identity disagrees with its envelope",
        );
      // Authenticate every candidate before excluding another agent's archive.
      if (manifest.agentId !== agentId) continue;
      const restoreGeneration =
        manifest.restoreGeneration === undefined
          ? INITIAL_AGENT_BACKUP_GENERATION
          : z
              .union([
                z.literal(INITIAL_AGENT_BACKUP_GENERATION),
                z.string().uuid(),
              ])
              .parse(manifest.restoreGeneration);
      if (restoreGeneration === generation) continue;
      archives.push({
        fileName: entry.name,
        archiveSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        stateSha256: envelope.stateSha256,
        restoreGeneration,
        createdAt: z.string().datetime().parse(manifest.createdAt),
        sizeBytes: bytes.length,
      });
    } catch (cause) {
      // error-policy:J2 An incomplete inventory cannot authorize archive removal.
      throw new ElizaError(
        "[AgentBackup] Reconcile the unreadable archive before reviewing backup cleanup",
        {
          code: "AGENT_BACKUP_REVIEW_UNAVAILABLE",
          context: { fileName: entry.name },
          cause,
        },
      );
    }
  }
  return { generation, archives };
}

/**
 * Removes only the exact retired archives already admitted in a durable owner job.
 * The caller must load this admission from its journal, never from an HTTP body.
 * Missing admitted files reconcile an interrupted removal; new or changed copies
 * require another owner review. The deadline is checked before any file mutation.
 */
export async function purgeAdmittedRetiredLocalAgentBackups(
  agentId: string,
  loadAdmission: () => Promise<{
    generation: string;
    notBefore: string;
    archives: RetiredLocalAgentBackup[];
  }>,
): Promise<void> {
  return withAgentBackupAuthority(resolveStateDir(), async (authority) => {
    const admission = await loadAdmission();
    const generation = await authority.generation(agentId);
    if (generation !== z.string().uuid().parse(admission.generation))
      throw new ElizaError(
        "[AgentBackup] Backup generation changed; review cleanup again",
        {
          code: "AGENT_BACKUP_CLEANUP_STALE",
        },
      );
    const deadline = Date.parse(
      z.string().datetime().parse(admission.notBefore),
    );
    if (Date.now() < deadline)
      throw new ElizaError("[AgentBackup] Backup retention has not elapsed", {
        code: "AGENT_BACKUP_RETENTION_PENDING",
      });
    const admitted = new Map<string, RetiredLocalAgentBackup>();
    for (const archive of admission.archives) {
      resolveLocalBackupPath(archive.fileName);
      z.string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(archive.archiveSha256);
      if (
        admitted.has(archive.fileName) ||
        archive.restoreGeneration === generation
      )
        throw new ElizaError(
          "[AgentBackup] Cleanup admission is inconsistent",
          {
            code: "AGENT_BACKUP_CLEANUP_STALE",
          },
        );
      admitted.set(archive.fileName, archive);
    }
    const review = await readRetiredLocalAgentBackups(agentId, generation);
    for (const archive of review.archives) {
      const expected = admitted.get(archive.fileName);
      if (!expected || stableJson(expected) !== stableJson(archive))
        throw new ElizaError(
          "[AgentBackup] Archive inventory changed; review cleanup again",
          {
            code: "AGENT_BACKUP_CLEANUP_STALE",
          },
        );
    }
    // Check every admitted path before the first unlink, including paths excluded
    // from the retired inventory because another agent or current generation owns it.
    for (const archive of admission.archives) {
      const filePath = resolveLocalBackupPath(archive.fileName);
      let handle: Awaited<ReturnType<typeof fs.open>>;
      try {
        handle = await fs.open(
          filePath,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
      } catch (cause) {
        // error-policy:J4 A durable admitted identity may already have been removed.
        if (
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "ENOENT"
        )
          continue;
        throw new ElizaError(
          "[AgentBackup] Admitted archive cannot be reconciled",
          {
            code: "AGENT_BACKUP_CLEANUP_STALE",
            cause,
          },
        );
      }
      try {
        if (
          !(await handle.stat()).isFile() ||
          !review.archives.some((item) => item.fileName === archive.fileName) ||
          sha256Bytes(await handle.readFile()) !== archive.archiveSha256
        )
          throw new ElizaError("[AgentBackup] Admitted archive was replaced", {
            code: "AGENT_BACKUP_CLEANUP_STALE",
          });
      } finally {
        await handle.close();
      }
    }
    for (const archive of review.archives)
      await fs.unlink(resolveLocalBackupPath(archive.fileName));
    if (review.archives.length) {
      const directory = await fs.open(
        localBackupsDir(),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    const remaining = await readRetiredLocalAgentBackups(agentId, generation);
    if (remaining.archives.length)
      throw new ElizaError(
        "[AgentBackup] Retired archive removal is incomplete",
        {
          code: "AGENT_BACKUP_CLEANUP_INCOMPLETE",
        },
      );
  });
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

/** Derives empty PostgreSQL directories from this PGlite version for legacy file-only vault archives. */
async function prepareVaultRestoreDirectories(
  vault: AgentBackupFileSet,
): Promise<string[]> {
  const version = vault.files.find(
    (file) => file.path === `${VAULT_PGLITE_DIR_NAME}/PG_VERSION`,
  );
  if (!version) return [];
  const { PGlite } = await import("@electric-sql/pglite");
  const template = await fs.mkdtemp(
    path.join(os.tmpdir(), "eliza-vault-restore-layout-"),
  );
  try {
    const database = await PGlite.create(template);
    await database.close();
    if (
      !(await fs.readFile(path.join(template, "PG_VERSION"))).equals(
        verifyFileEntry(version),
      )
    ) {
      throw new ElizaError(
        "[AgentBackup] Vault database version does not match the installed PGlite version",
        {
          code: "AGENT_BACKUP_VAULT_VERSION_MISMATCH",
        },
      );
    }
    const directories = [VAULT_PGLITE_DIR_NAME];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory()) continue;
        const absolute = path.join(directory, entry.name);
        const relative = normalizeRelativePath(
          path.relative(template, absolute),
        );
        directories.push(`${VAULT_PGLITE_DIR_NAME}/${relative}`);
        await visit(absolute);
      }
    };
    await visit(template);
    const files = new Set(
      vault.files.map((file) => normalizeRelativePath(file.path)),
    );
    for (const directory of directories) {
      if (files.has(directory)) {
        throw new ElizaError(
          "[AgentBackup] Vault archive replaces a required database directory with a file",
          {
            code: "AGENT_BACKUP_VAULT_DIRECTORY_CONFLICT",
            context: { directory },
          },
        );
      }
    }
    return directories.sort();
  } finally {
    await fs.rm(template, { recursive: true, force: true });
  }
}

async function restoreFileSet(
  root: string,
  fileSet: AgentBackupFileSet,
  options: {
    replaceRoot?: boolean;
    include?: (relativePath: string) => boolean;
    pruneExtra?: (relativePath: string) => boolean;
    directories?: readonly string[];
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
  for (const directory of options.directories ?? []) {
    const relative = normalizeRelativePath(directory);
    await fs.mkdir(path.join(resolvedRoot, relative), {
      recursive: true,
      mode: 0o700,
    });
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

function verifyPostgresDump(dump: AgentBackupPostgresDump): void {
  const expected = withPostgresHash({ ...dump, sha256: "" }).sha256;
  if (expected !== dump.sha256) {
    throw new Error(
      `Postgres dump hash mismatch: expected ${dump.sha256}, got ${expected}`,
    );
  }
}

async function restorePostgresRows(
  postgresUrl: string,
  agentId: string,
  dump: AgentBackupPostgresDump,
): Promise<void> {
  verifyPostgresDump(dump);

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
  return withAgentBackupAuthority(resolveStateDir(), async (authority) => {
    const manifest = assertManifest(snapshot);
    const current = await authority.generation(runtime.agentId);
    if (
      (manifest.restoreGeneration ?? INITIAL_AGENT_BACKUP_GENERATION) !==
      current
    )
      throw new ElizaError(
        "[AgentBackup] This snapshot predates a data-deletion boundary and cannot be restored",
        {
          code: "AGENT_BACKUP_GENERATION_RETIRED",
        },
      );
    const sets = [
      manifest.components.stateFiles,
      manifest.components.vault,
      manifest.components.media,
    ];
    if (
      sets.some((set) =>
        set.files.some((file) => isBackupAuthorityPath(file.path)),
      )
    )
      throw new ElizaError(
        "[AgentBackup] A snapshot cannot replace backup authority",
        {
          code: "AGENT_BACKUP_AUTHORITY_INVALID",
        },
      );
    const stateDir = path.resolve(resolveStateDir());
    const authorityRoot = path.join(stateDir, AGENT_BACKUP_AUTHORITY_DIRECTORY);
    const databaseRoot =
      manifest.components.database.kind === "postgres-rows"
        ? null
        : path.resolve(await resolvePgliteDir());
    const configTarget = path.resolve(resolveConfigPath());
    if (
      (databaseRoot &&
        (isWithin(databaseRoot, authorityRoot) ||
          isWithin(authorityRoot, databaseRoot))) ||
      isWithin(authorityRoot, configTarget)
    )
      throw new ElizaError(
        "[AgentBackup] Restore targets overlap backup authority; configure independent database and configuration paths",
        {
          code: "AGENT_BACKUP_AUTHORITY_INVALID",
        },
      );
    return restoreAuthorizedAgentSnapshot(runtime, snapshot);
  });
}

async function restoreAuthorizedAgentSnapshot(
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
  // Reject invalid later components before stopping a healthy runtime or
  // replacing any data. Each writer retains its own integrity check as well.
  for (const fileSet of [
    manifest.components.media,
    manifest.components.vault,
    manifest.components.stateFiles,
  ]) {
    verifyFileSet(fileSet);
    for (const file of fileSet.files) normalizeRelativePath(file.path);
  }
  if (manifest.components.character.configFile) {
    verifyFileEntry(manifest.components.character.configFile);
  }
  // A file-only archive omits empty database directories. Resolve and validate
  // their layout before shutting down the runtime or replacing any data.
  const vaultDirectories = await prepareVaultRestoreDirectories(
    manifest.components.vault,
  );
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
    verifyPostgresDump(database.postgres);
    await stopRuntimeBeforeDatabaseRestore(runtime);
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
    verifyPgliteDump(database.pgliteDump);
    await stopRuntimeBeforeDatabaseRestore(runtime);
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
    verifyFileSet(database.pglite);
    for (const file of database.pglite.files) normalizeRelativePath(file.path);
    await stopRuntimeBeforeDatabaseRestore(runtime);
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
    directories: vaultDirectories,
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

async function stopRuntimeBeforeDatabaseRestore(
  runtime: IAgentRuntime | AgentRuntime,
): Promise<void> {
  // Stop boot admissions and fully drain services while their database is
  // still usable. The fast signal-exit path can return with work pending and
  // is inappropriate when this process will immediately replace its data.
  await cancelAndDrainDeferredBoot(runtime);
  await runtime.stop();
}

const ACTIVATION_DIR_NAME = ".activation";
const MIB = 1024 * 1024;
const PGLITE_CAPTURE_AVAILABLE_MEMORY_HEADROOM_BYTES = 32 * MIB;

/**
 * PGlite 0.4.x materializes the file list, tar, gzip chunks, joined gzip bytes,
 * and Blob before capture can stream the result. The gate reserves eight
 * archive-sized additional-memory copies (including GC overlap and the
 * downstream frame) plus 32 MiB of emergency headroom from the memory Node/Bun
 * reports as still available to this process. This is cgroup-aware in supported
 * runtimes and does not incorrectly charge the already-resident PGlite WASM
 * heap a second time. The archive estimate charges 4 KiB per entry plus 1 MiB
 * fixed tar/gzip overhead. There is deliberately no independent directory-size
 * ceiling: the archive estimate is the quantity materialization consumes, and
 * the available-memory gate below bounds it against the current runtime.
 */
export const AGENT_BACKUP_V2_PGLITE_CAPTURE_LIMITS = Object.freeze({
  availableMemoryHeadroomBytes: PGLITE_CAPTURE_AVAILABLE_MEMORY_HEADROOM_BYTES,
  archiveCopyFactor: 8,
  archiveEntryOverheadBytes: 4 * 1024,
  archiveBaseOverheadBytes: MIB,
});

export interface AgentBackupV2CaptureSourceChunk {
  bytes: Uint8Array;
  /** Required for file-set sources; absent for opaque/record streams. */
  entry?: AgentBackupCaptureV2FileEntry;
}

/** Minimal runtime surface needed by capture; deliberately excludes providers. */
export interface AgentBackupV2CaptureRuntime {
  agentId: string;
  character?: unknown;
  adapter?: unknown;
  getSetting?(key: string): unknown;
}

export interface AgentBackupV2CaptureComponentSource {
  descriptor: AgentBackupCaptureV2ComponentDescriptor;
  /** Optional pre-header preparation for sources that must fail before commit. */
  prepare?(signal: AbortSignal): Promise<void>;
  /** Release any prepared source state when the enclosing capture closes. */
  dispose?(): void;
  open(signal: AbortSignal): AsyncIterable<AgentBackupV2CaptureSourceChunk>;
}

export interface StreamAgentBackupV2CaptureOptions {
  request: AgentBackupCaptureV2Request;
  agentId: string;
  components: readonly AgentBackupV2CaptureComponentSource[];
  signal?: AbortSignal;
  now?: () => number;
}

export interface CreateAgentBackupV2CaptureOptions {
  signal?: AbortSignal;
  components?: readonly AgentBackupV2CaptureComponentSource[];
  now?: () => number;
}

export class AgentBackupV2CaptureError extends ElizaError {
  override readonly name = "AgentBackupV2CaptureError";

  constructor(
    message: string,
    code: string,
    context?: Record<string, unknown>,
    options?: { cause?: unknown; severity?: "ephemeral" | "fatal" },
  ) {
    super(message, {
      code,
      context,
      cause: options?.cause,
      severity: options?.severity,
    });
  }
}

function captureError(
  message: string,
  code: string,
  context?: Record<string, unknown>,
  options?: { cause?: unknown; severity?: "ephemeral" | "fatal" },
): never {
  throw new AgentBackupV2CaptureError(message, code, context, options);
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason instanceof Error ? signal.reason : undefined;
}

function sourceAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new AgentBackupV2CaptureError(
        "Agent backup capture was cancelled",
        "AGENT_BACKUP_V2_CAPTURE_ABORTED",
        undefined,
        { severity: "ephemeral" },
      );
}

function assertCaptureActive(
  request: AgentBackupCaptureV2Request,
  signal: AbortSignal | undefined,
  now: () => number,
): void {
  if (signal?.aborted) {
    if (signal.reason instanceof AgentBackupV2CaptureError) {
      throw signal.reason;
    }
    captureError(
      "Agent backup capture was cancelled",
      "AGENT_BACKUP_V2_CAPTURE_ABORTED",
      { operationId: request.operationId },
      { cause: abortReason(signal), severity: "ephemeral" },
    );
  }
  if (now() >= request.deadlineEpochMs) {
    captureError(
      "Agent backup capture deadline exceeded",
      "AGENT_BACKUP_V2_CAPTURE_DEADLINE_EXCEEDED",
      {
        operationId: request.operationId,
        deadlineEpochMs: request.deadlineEpochMs,
      },
      { severity: "ephemeral" },
    );
  }
}

async function awaitWithCaptureControl<T>(
  operation: () => PromiseLike<T>,
  request: AgentBackupCaptureV2Request,
  signal: AbortSignal | undefined,
  now: () => number,
): Promise<T> {
  assertCaptureActive(request, signal, now);
  const value = Promise.resolve(operation());
  const remainingMs = request.deadlineEpochMs - now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () =>
        reject(
          new AgentBackupV2CaptureError(
            "Agent backup capture deadline exceeded",
            "AGENT_BACKUP_V2_CAPTURE_DEADLINE_EXCEEDED",
            {
              operationId: request.operationId,
              deadlineEpochMs: request.deadlineEpochMs,
            },
            { severity: "ephemeral" },
          ),
        ),
      Math.min(remainingMs, 2_147_483_647),
    );
    if (signal) {
      abortListener = () =>
        reject(
          signal.reason instanceof AgentBackupV2CaptureError
            ? signal.reason
            : new AgentBackupV2CaptureError(
                "Agent backup capture was cancelled",
                "AGENT_BACKUP_V2_CAPTURE_ABORTED",
                { operationId: request.operationId },
                { cause: abortReason(signal), severity: "ephemeral" },
              ),
        );
      signal.addEventListener("abort", abortListener, { once: true });
    }
  });
  try {
    return await Promise.race([value, interrupted]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

function nodeSha256Digest(bytes: Uint8Array): Uint8Array {
  return crypto.createHash("sha256").update(bytes).digest();
}

function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function normalizeCaptureRelativePath(input: string): string {
  const normalized = path.posix.normalize(input.replaceAll(path.sep, "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    captureError(
      `Invalid backup path: ${input}`,
      "AGENT_BACKUP_V2_INVALID_PATH",
      { path: input },
      { severity: "fatal" },
    );
  }
  return normalized;
}

function resolveCaptureDirectoryIdentity(
  directory: string,
  role: "pglite" | "state",
): string {
  const resolved = path.resolve(directory);
  try {
    const physical = nodeFs.realpathSync.native(resolved);
    if (!nodeFs.statSync(physical).isDirectory()) {
      captureError(
        `Agent backup ${role} path is not a directory`,
        "AGENT_BACKUP_V2_DIRECTORY_IDENTITY_INVALID",
        { role, path: resolved },
        { severity: "fatal" },
      );
    }
    return physical;
  } catch (error) {
    if (error instanceof AgentBackupV2CaptureError) throw error;
    // error-policy:J2 a missing, dangling, or unreadable path has no stable
    // physical identity, so capture cannot prove component disjointness.
    throw new AgentBackupV2CaptureError(
      `Agent backup could not resolve the ${role} directory identity`,
      "AGENT_BACKUP_V2_DIRECTORY_IDENTITY_UNRESOLVED",
      { role, path: resolved },
      { cause: error, severity: "fatal" },
    );
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function resolveStateFilesPgliteExclusion(
  stateDir: string,
  pgliteDir: string,
): string | null {
  const physicalStateDir = resolveCaptureDirectoryIdentity(stateDir, "state");
  const physicalPgliteDir = resolveCaptureDirectoryIdentity(
    pgliteDir,
    "pglite",
  );

  if (isWithin(physicalPgliteDir, physicalStateDir)) {
    captureError(
      "PGlite cannot contain or equal the agent state directory during capture",
      "AGENT_BACKUP_V2_PGLITE_STATE_OVERLAP",
      { stateDir: physicalStateDir, pgliteDir: physicalPgliteDir },
      { severity: "fatal" },
    );
  }
  if (!isWithin(physicalStateDir, physicalPgliteDir)) return null;

  const mediaDir = path.join(physicalStateDir, MEDIA_DIR_NAME);
  const vaultPgliteDir = path.join(physicalStateDir, VAULT_PGLITE_DIR_NAME);
  const vaultAuditDir = path.join(physicalStateDir, VAULT_AUDIT_DIR_NAME);
  if (
    pathsOverlap(mediaDir, physicalPgliteDir) ||
    pathsOverlap(vaultPgliteDir, physicalPgliteDir) ||
    physicalPgliteDir === vaultAuditDir
  ) {
    captureError(
      "PGlite overlaps another dedicated backup component",
      "AGENT_BACKUP_V2_PGLITE_COMPONENT_OVERLAP",
      { stateDir: physicalStateDir, pgliteDir: physicalPgliteDir },
      { severity: "fatal" },
    );
  }

  return normalizeCaptureRelativePath(
    path.relative(physicalStateDir, physicalPgliteDir),
  );
}

export interface PglitePhysicalPreflight {
  physicalBytes: number;
  estimatedArchiveBytes: number;
  entryCount: number;
  availableMemoryBytes: number;
  additionalMemoryBudgetBytes: number;
  requiredAvailableMemoryBytes: number;
}

/** Remaining memory available to this process, cgroup-aware when supported. */
export function resolveAgentBackupAvailableMemoryBytes(): number {
  const processAvailableMemory = process.availableMemory?.();
  if (
    typeof processAvailableMemory === "number" &&
    Number.isSafeInteger(processAvailableMemory) &&
    processAvailableMemory >= 0
  ) {
    return processAvailableMemory;
  }
  const hostFreeMemory = os.freemem();
  if (Number.isSafeInteger(hostFreeMemory) && hostFreeMemory >= 0) {
    return hostFreeMemory;
  }
  captureError(
    "Available memory could not be proven before PGlite export",
    "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_UNPROVEN",
    undefined,
    { severity: "fatal" },
  );
}

function roundUpTarBlock(bytes: bigint): bigint {
  const block = 512n;
  return ((bytes + block - 1n) / block) * block;
}

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs
  );
}

export async function preflightPglitePhysicalDirectory(
  physicalRoot: string,
  signal: AbortSignal,
  agentId: string,
  options: { archiveCopyFactor?: number } = {},
): Promise<PglitePhysicalPreflight> {
  const limits = AGENT_BACKUP_V2_PGLITE_CAPTURE_LIMITS;
  let physicalBytes = 0n;
  let estimatedArchiveBytes = BigInt(limits.archiveBaseOverheadBytes);
  let entryCount = 0;
  const pendingDirectories = [physicalRoot];

  try {
    while (pendingDirectories.length > 0) {
      if (signal.aborted) throw sourceAbortError(signal);
      const directory = pendingDirectories.pop();
      if (!directory) break;
      const before = await fs.lstat(directory, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) {
        captureError(
          "PGlite physical-size preflight encountered an unsafe directory",
          "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_UNPROVEN",
          { agentId },
          { severity: "fatal" },
        );
      }

      const entries = await fs.opendir(directory);
      for await (const entry of entries) {
        if (signal.aborted) throw sourceAbortError(signal);
        entryCount += 1;
        if (entryCount > AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFiles) {
          captureError(
            "PGlite physical-size preflight exceeds the entry-count limit",
            "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_ENTRY_LIMIT",
            { agentId, entryCount },
            { severity: "fatal" },
          );
        }

        const absolutePath = path.join(directory, entry.name);
        if (!isWithin(physicalRoot, absolutePath)) {
          captureError(
            "PGlite physical-size preflight escaped its configured root",
            "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_UNPROVEN",
            { agentId },
            { severity: "fatal" },
          );
        }
        const stats = await fs.lstat(absolutePath, { bigint: true });
        if (stats.isSymbolicLink()) {
          captureError(
            "PGlite physical-size preflight refuses symbolic links",
            "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_UNPROVEN",
            { agentId },
            { severity: "fatal" },
          );
        }

        estimatedArchiveBytes += BigInt(limits.archiveEntryOverheadBytes);
        if (stats.isDirectory()) {
          pendingDirectories.push(absolutePath);
          continue;
        }
        if (!stats.isFile() || stats.size < 0n) {
          captureError(
            "PGlite physical-size preflight encountered a non-regular entry",
            "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_UNPROVEN",
            { agentId },
            { severity: "fatal" },
          );
        }

        physicalBytes += stats.size;
        estimatedArchiveBytes += roundUpTarBlock(stats.size);
      }

      const after = await fs.lstat(directory, { bigint: true });
      if (!sameDirectoryIdentity(before, after)) {
        captureError(
          "PGlite changed while its physical size was being proven",
          "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_CHANGED",
          { agentId },
          { severity: "ephemeral" },
        );
      }
    }
  } catch (error) {
    if (error instanceof AgentBackupV2CaptureError) throw error;
    throw new AgentBackupV2CaptureError(
      "PGlite physical size could not be proven before export",
      "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_UNPROVEN",
      { agentId },
      { cause: error, severity: "fatal" },
    );
  }

  const estimatedArchive = Number(estimatedArchiveBytes);
  const archiveCopyFactor =
    options.archiveCopyFactor ?? limits.archiveCopyFactor;
  if (
    !Number.isSafeInteger(archiveCopyFactor) ||
    archiveCopyFactor < limits.archiveCopyFactor
  ) {
    captureError(
      "PGlite export requested an invalid archive-copy budget",
      "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_UNPROVEN",
      { agentId, archiveCopyFactor },
      { severity: "fatal" },
    );
  }
  const additionalMemoryBudgetBytes = estimatedArchive * archiveCopyFactor;
  const requiredAvailableMemoryBytes =
    additionalMemoryBudgetBytes + limits.availableMemoryHeadroomBytes;
  const availableMemoryBytes = resolveAgentBackupAvailableMemoryBytes();
  if (availableMemoryBytes < requiredAvailableMemoryBytes) {
    captureError(
      "PGlite export would exceed the available-memory budget",
      // This deployed wire code remains stable for Cloud failure classification.
      "AGENT_BACKUP_V2_PGLITE_RSS_BUDGET_EXCEEDED",
      {
        agentId,
        availableMemoryBytes,
        estimatedArchiveBytes: estimatedArchive,
        archiveCopyFactor,
        additionalMemoryBudgetBytes,
        requiredAvailableMemoryBytes,
        availableMemoryHeadroomBytes: limits.availableMemoryHeadroomBytes,
      },
      { severity: "ephemeral" },
    );
  }

  return {
    physicalBytes: Number(physicalBytes),
    estimatedArchiveBytes: estimatedArchive,
    entryCount,
    availableMemoryBytes,
    additionalMemoryBudgetBytes,
    requiredAvailableMemoryBytes,
  };
}

async function* splitOpaqueBytes(
  bytes: Uint8Array,
): AsyncGenerator<AgentBackupV2CaptureSourceChunk> {
  for (
    let offset = 0;
    offset < bytes.length;
    offset += AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes
  ) {
    yield {
      bytes: bytes.subarray(
        offset,
        Math.min(
          bytes.length,
          offset + AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes,
        ),
      ),
    };
  }
}

async function* walkFiles(
  root: string,
  include: ((relativePath: string) => boolean) | undefined,
  signal: AbortSignal,
): AsyncGenerator<{ absolutePath: string; relativePath: string }> {
  const resolvedRoot = path.resolve(root);
  if (!(await pathExists(resolvedRoot))) return;

  async function* visit(
    directory: string,
  ): AsyncGenerator<{ absolutePath: string; relativePath: string }> {
    if (signal.aborted) {
      captureError(
        "Agent backup file walk was cancelled",
        "AGENT_BACKUP_V2_CAPTURE_ABORTED",
        undefined,
        { cause: abortReason(signal), severity: "ephemeral" },
      );
    }
    const entries = await fs.readdir(directory, {
      withFileTypes: true,
    });
    entries.sort((left, right) =>
      compareAgentBackupCaptureV2FilePaths(
        `${left.name}${left.isDirectory() ? "/" : ""}`,
        `${right.name}${right.isDirectory() ? "/" : ""}`,
      ),
    );
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (!isWithin(resolvedRoot, absolutePath)) continue;
      const relativePath = normalizeCaptureRelativePath(
        path.relative(resolvedRoot, absolutePath),
      );
      if (include && !include(relativePath)) continue;
      if (entry.isDirectory()) {
        yield* visit(absolutePath);
      } else if (entry.isFile()) {
        yield { absolutePath, relativePath };
      }
    }
  }

  yield* visit(resolvedRoot);
}

function fileSetSource(
  descriptor: AgentBackupCaptureV2ComponentDescriptor,
  root: string,
  include?: (relativePath: string) => boolean,
): AgentBackupV2CaptureComponentSource {
  return {
    descriptor,
    async *open(signal) {
      let fileCount = 0;
      for await (const file of walkFiles(root, include, signal)) {
        fileCount += 1;
        if (fileCount > AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFiles) {
          captureError(
            `Component ${descriptor.name} exceeds the file-count limit`,
            "AGENT_BACKUP_V2_FILE_LIMIT",
            { componentName: descriptor.name, fileCount },
            { severity: "fatal" },
          );
        }
        const before = await fs.stat(file.absolutePath);
        const commonEntry = {
          path: file.relativePath,
          fileSizeBytes: before.size,
          mode: before.mode & 0o777,
          mtimeMs: Math.max(0, Math.trunc(before.mtimeMs)),
        };
        if (before.size === 0) {
          yield {
            bytes: new Uint8Array(0),
            entry: { ...commonEntry, fileOffsetBytes: 0 },
          };
        } else {
          let fileOffsetBytes = 0;
          const stream = nodeFs.createReadStream(file.absolutePath, {
            highWaterMark: AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes,
          });
          if (signal.aborted) stream.destroy(sourceAbortError(signal));
          const abort = () => stream.destroy(sourceAbortError(signal));
          signal.addEventListener("abort", abort, { once: true });
          try {
            for await (const chunk of stream) {
              const bytes = chunk as Buffer;
              if (bytes.length === 0) {
                captureError(
                  `File stream made no progress for ${file.relativePath}`,
                  "AGENT_BACKUP_V2_ZERO_PROGRESS",
                  { componentName: descriptor.name, path: file.relativePath },
                  { severity: "fatal" },
                );
              }
              yield {
                bytes,
                entry: { ...commonEntry, fileOffsetBytes },
              };
              fileOffsetBytes += bytes.length;
            }
          } finally {
            signal.removeEventListener("abort", abort);
          }
          if (fileOffsetBytes !== before.size) {
            captureError(
              `File size changed while capturing ${file.relativePath}`,
              "AGENT_BACKUP_V2_FILE_CHANGED",
              {
                componentName: descriptor.name,
                path: file.relativePath,
                expectedBytes: before.size,
                observedBytes: fileOffsetBytes,
              },
              { severity: "ephemeral" },
            );
          }
        }
        const after = await fs.stat(file.absolutePath);
        if (
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          (after.mode & 0o777) !== (before.mode & 0o777)
        ) {
          captureError(
            `File changed while capturing ${file.relativePath}`,
            "AGENT_BACKUP_V2_FILE_CHANGED",
            { componentName: descriptor.name, path: file.relativePath },
            { severity: "ephemeral" },
          );
        }
      }
    },
  };
}

function jsonSource(
  descriptor: AgentBackupCaptureV2ComponentDescriptor,
  value: unknown,
): AgentBackupV2CaptureComponentSource {
  return {
    descriptor,
    open() {
      return splitOpaqueBytes(new TextEncoder().encode(JSON.stringify(value)));
    },
  };
}

function isPgliteDump(value: unknown): value is {
  size: number;
  stream: () => ReadableStream<Uint8Array>;
} {
  const size = (value as { size?: unknown } | null)?.size;
  return (
    value !== null &&
    typeof value === "object" &&
    typeof size === "number" &&
    Number.isSafeInteger(size) &&
    size >= 0 &&
    typeof (value as { stream?: unknown }).stream === "function"
  );
}

const activePgliteDumpByPhysicalDirectory = new Map<string, symbol>();

function pgliteManagedExportErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function acquirePgliteDumpSlot(
  physicalPgliteDir: string,
  agentId: string,
): () => void {
  if (activePgliteDumpByPhysicalDirectory.has(physicalPgliteDir)) {
    captureError(
      "A previous PGlite export is still active or settling",
      "AGENT_BACKUP_V2_PGLITE_DUMP_BUSY",
      { agentId },
      { severity: "ephemeral" },
    );
  }
  const token = Symbol("pglite-dump");
  activePgliteDumpByPhysicalDirectory.set(physicalPgliteDir, token);
  return () => {
    if (activePgliteDumpByPhysicalDirectory.get(physicalPgliteDir) === token) {
      activePgliteDumpByPhysicalDirectory.delete(physicalPgliteDir);
    }
  };
}

function pgliteDumpSource(
  runtime: AgentBackupV2CaptureRuntime,
  physicalPgliteDir: string,
): AgentBackupV2CaptureComponentSource {
  const adapter = runtime.adapter as
    | {
        dumpPgliteDataDirAfterPreflight?: (
          preflight: () => Promise<PglitePhysicalPreflight>,
          compression?: "gzip",
        ) => Promise<{
          dump: unknown;
          preflight: PglitePhysicalPreflight;
          release: () => void;
        }>;
        getPgliteDataDir?: () => unknown;
      }
    | undefined;
  const managedDump = adapter?.dumpPgliteDataDirAfterPreflight;
  if (typeof managedDump !== "function") {
    captureError(
      "Capture v2 requires the fenced, lifecycle-managed PGlite dump exporter",
      "AGENT_BACKUP_V2_PGLITE_MANAGED_DUMP_UNAVAILABLE",
      { agentId: runtime.agentId },
      { severity: "fatal" },
    );
  }
  if (typeof adapter?.getPgliteDataDir !== "function") {
    captureError(
      "The PGlite exporter cannot attest its physical data directory",
      "AGENT_BACKUP_V2_PGLITE_DIRECTORY_UNATTESTED",
      { agentId: runtime.agentId },
      { severity: "fatal" },
    );
  }
  const managedDataDir = adapter.getPgliteDataDir();
  if (
    typeof managedDataDir !== "string" ||
    managedDataDir.length === 0 ||
    managedDataDir === ":memory:" ||
    managedDataDir.includes("://")
  ) {
    captureError(
      "The PGlite exporter did not attest a filesystem-backed data directory",
      "AGENT_BACKUP_V2_PGLITE_DIRECTORY_UNATTESTED",
      { agentId: runtime.agentId },
      { severity: "fatal" },
    );
  }
  const managedPhysicalDir = resolveCaptureDirectoryIdentity(
    resolveUserPath(managedDataDir),
    "pglite",
  );
  if (managedPhysicalDir !== physicalPgliteDir) {
    captureError(
      "The PGlite exporter data directory does not match capture configuration",
      "AGENT_BACKUP_V2_PGLITE_DIRECTORY_MISMATCH",
      { agentId: runtime.agentId },
      { severity: "fatal" },
    );
  }
  const runManagedDump = managedDump.bind(adapter);

  let prepared:
    | { dump: { size: number; stream: () => ReadableStream<Uint8Array> } }
    | undefined;
  let preparing: Promise<void> | undefined;
  let releasePreparedExport: (() => void) | undefined;
  let opened = false;
  let disposed = false;

  const prepare = async (signal: AbortSignal): Promise<void> => {
    if (signal.aborted) throw sourceAbortError(signal);
    if (disposed) {
      captureError(
        "The PGlite capture source is already closed",
        "AGENT_BACKUP_V2_PGLITE_DUMP_ALREADY_CONSUMED",
        { agentId: runtime.agentId },
        { severity: "fatal" },
      );
    }
    if (prepared) return;
    if (!preparing) {
      preparing = (async () => {
        const releaseDumpSlot = acquirePgliteDumpSlot(
          physicalPgliteDir,
          runtime.agentId,
        );
        let retainDumpSlot = false;
        let releaseManagedLease: (() => void) | undefined;
        try {
          let boundedDump: {
            dump: unknown;
            preflight: PglitePhysicalPreflight;
            release: () => void;
          };
          let provenPreflight: PglitePhysicalPreflight | undefined;
          try {
            const dumpPromise = Promise.resolve().then(() =>
              runManagedDump(async () => {
                const proof = await preflightPglitePhysicalDirectory(
                  physicalPgliteDir,
                  signal,
                  runtime.agentId,
                );
                provenPreflight = proof;
                return proof;
              }, "gzip"),
            );
            // PGlite 0.4.x cannot cancel a materializing dump. Keep its rejection
            // observed and its directory slot held until this promise settles.
            void dumpPromise.catch(() => undefined);
            boundedDump = await dumpPromise;
          } catch (error) {
            if (error instanceof AgentBackupV2CaptureError) throw error;
            if (
              pgliteManagedExportErrorCode(error) ===
              "PGLITE_DATA_DIR_EXPORT_BUSY"
            ) {
              captureError(
                "A previous PGlite export is still active or settling",
                "AGENT_BACKUP_V2_PGLITE_DUMP_BUSY",
                { agentId: runtime.agentId },
                { severity: "ephemeral" },
              );
            }
            throw new AgentBackupV2CaptureError(
              "PGlite could not create a managed data-dir export",
              "AGENT_BACKUP_V2_PGLITE_DUMP_FAILED",
              { agentId: runtime.agentId },
              { cause: error, severity: "ephemeral" },
            );
          }
          if (typeof boundedDump.release !== "function") {
            captureError(
              "The managed PGlite exporter did not provide a consumer-lifetime lease",
              "AGENT_BACKUP_V2_PGLITE_MANAGED_DUMP_UNAVAILABLE",
              { agentId: runtime.agentId },
              { severity: "fatal" },
            );
          }
          releaseManagedLease = boundedDump.release;
          if (signal.aborted) throw sourceAbortError(signal);
          if (disposed) {
            captureError(
              "The PGlite capture source closed while export was settling",
              "AGENT_BACKUP_V2_CAPTURE_CLOSED",
              { agentId: runtime.agentId },
              { severity: "ephemeral" },
            );
          }
          const { dump, preflight } = boundedDump;
          if (!isPgliteDump(dump)) {
            captureError(
              "PGlite dumpDataDir() did not return a streamable Blob/File",
              "AGENT_BACKUP_V2_PGLITE_DUMP_NOT_STREAMABLE",
              { agentId: runtime.agentId },
              { severity: "fatal" },
            );
          }
          if (
            !provenPreflight ||
            preflight !== provenPreflight ||
            !Number.isSafeInteger(preflight.estimatedArchiveBytes) ||
            preflight.estimatedArchiveBytes < 0
          ) {
            captureError(
              "The managed PGlite exporter skipped its required preflight",
              "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_UNPROVEN",
              { agentId: runtime.agentId },
              { severity: "fatal" },
            );
          }
          if (dump.size > preflight.estimatedArchiveBytes) {
            captureError(
              "PGlite export exceeds its preflighted archive bound",
              "AGENT_BACKUP_V2_PGLITE_DUMP_EXCEEDS_PREFLIGHT",
              {
                agentId: runtime.agentId,
                dumpBytes: dump.size,
                estimatedArchiveBytes: preflight.estimatedArchiveBytes,
                physicalBytes: preflight.physicalBytes,
              },
              { severity: "fatal" },
            );
          }
          prepared = { dump };
          releasePreparedExport = () => {
            const releaseLease = releaseManagedLease;
            releaseManagedLease = undefined;
            releaseLease?.();
            releaseDumpSlot();
          };
          retainDumpSlot = true;
        } finally {
          if (!retainDumpSlot) {
            releaseManagedLease?.();
            releaseDumpSlot();
          }
        }
      })();
      void preparing.catch(() => undefined);
    }
    await preparing;
    if (signal.aborted) throw sourceAbortError(signal);
  };

  return {
    descriptor: {
      name: "database",
      format: "pglite-data-dir-tar-gzip-v1",
      compression: "gzip",
      contentKind: "opaque",
      consistency: "transactional",
    },
    prepare,
    dispose() {
      disposed = true;
      prepared = undefined;
      if (!opened) {
        releasePreparedExport?.();
        releasePreparedExport = undefined;
      }
    },
    async *open(signal) {
      await prepare(signal);
      if (opened) {
        captureError(
          "A prepared PGlite export can only be consumed once",
          "AGENT_BACKUP_V2_PGLITE_DUMP_ALREADY_CONSUMED",
          { agentId: runtime.agentId },
          { severity: "fatal" },
        );
      }
      opened = true;
      const dump = prepared?.dump;
      if (!dump) {
        captureError(
          "The prepared PGlite export is unavailable",
          "AGENT_BACKUP_V2_PGLITE_DUMP_FAILED",
          { agentId: runtime.agentId },
          { severity: "fatal" },
        );
      }
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let abort: (() => void) | undefined;
      try {
        reader = dump.stream().getReader();
        abort = () => {
          // error-policy:J6 cancellation is already observed through the capture
          // signal; a reader cleanup failure is diagnostic and must not be unhandled.
          void reader?.cancel(abortReason(signal)).catch((error) => {
            logger.warn(
              { err: error instanceof Error ? error.message : String(error) },
              "[agent-backup-v2] PGlite reader cancellation failed",
            );
          });
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          if (next.value.length === 0) {
            captureError(
              "PGlite export made no progress",
              "AGENT_BACKUP_V2_ZERO_PROGRESS",
              { componentName: "database" },
              { severity: "fatal" },
            );
          }
          yield* splitOpaqueBytes(next.value);
        }
      } finally {
        if (abort) signal.removeEventListener("abort", abort);
        try {
          reader?.releaseLock();
        } finally {
          prepared = undefined;
          releasePreparedExport?.();
          releasePreparedExport = undefined;
        }
      }
    },
  };
}

function resolveCapturePgliteDir(config: ElizaConfig): string {
  const configured = process.env.PGLITE_DATA_DIR?.trim();
  if (configured) return resolveUserPath(configured);
  const workspace =
    config.agents?.defaults?.workspace ?? resolveDefaultAgentWorkspaceDir();
  return path.join(resolveUserPath(workspace), DEFAULT_PGLITE_DIR_NAME);
}

function captureHasPostgresUrl(runtime: AgentBackupV2CaptureRuntime): boolean {
  const runtimeSetting = runtime.getSetting?.("POSTGRES_URL");
  return (
    (typeof runtimeSetting === "string" && runtimeSetting.trim().length > 0) ||
    Boolean(
      process.env.POSTGRES_URL?.trim() || process.env.DATABASE_URL?.trim(),
    )
  );
}

function captureStateFileInclude(
  relativePath: string,
  pgliteRelativePath: string | null,
): boolean {
  // Plugin import generations are rebuilt from installed sources on boot.
  if (
    relativePath === "plugins/.runtime-imports" ||
    relativePath.startsWith("plugins/.runtime-imports/")
  )
    return false;
  // Preserve installed-skill state while excluding the downloadable catalog.
  if (relativePath === "skills/.cache/catalog.json") return false;
  if (
    pgliteRelativePath !== null &&
    (relativePath === pgliteRelativePath ||
      relativePath.startsWith(`${pgliteRelativePath}/`))
  ) {
    return false;
  }
  const first = relativePath.split("/")[0];
  if (
    first === MEDIA_DIR_NAME ||
    first === BACKUPS_DIR_NAME ||
    first === MODELS_DIR_NAME ||
    first === TOOL_CACHE_DIR_NAME ||
    first === CACHE_DIR_NAME ||
    first === ACTIVATION_DIR_NAME ||
    first === DEFAULT_PGLITE_DIR_NAME ||
    first === VAULT_PGLITE_DIR_NAME ||
    relativePath === VAULT_JSON_PATH ||
    relativePath === VAULT_AUDIT_PATH
  ) {
    return false;
  }
  return !relativePath.endsWith(".log");
}

/** Build the five required full-capture components without provider provenance. */
export function createDefaultAgentBackupV2CaptureSources(
  runtime: AgentBackupV2CaptureRuntime,
  config: ElizaConfig,
): readonly AgentBackupV2CaptureComponentSource[] {
  if (captureHasPostgresUrl(runtime)) {
    captureError(
      "Capture v2 currently requires the sandbox-local PGlite database export",
      "AGENT_BACKUP_V2_POSTGRES_UNSUPPORTED",
      { agentId: runtime.agentId },
      { severity: "fatal" },
    );
  }
  const stateDir = resolveStateDir();
  const pgliteDir = resolveCapturePgliteDir(config);
  if (pgliteDir === ":memory:" || pgliteDir.includes("://")) {
    captureError(
      "Capture v2 requires a filesystem-backed PGlite database",
      "AGENT_BACKUP_V2_PGLITE_NOT_FILESYSTEM",
      { pgliteDir },
      { severity: "fatal" },
    );
  }
  const pgliteStateFilesExclusion = resolveStateFilesPgliteExclusion(
    stateDir,
    pgliteDir,
  );
  const physicalPgliteDir = resolveCaptureDirectoryIdentity(
    pgliteDir,
    "pglite",
  );
  const database = pgliteDumpSource(runtime, physicalPgliteDir);

  return Object.freeze([
    jsonSource(
      {
        name: "character",
        format: "runtime-character-json-v1",
        compression: "none",
        contentKind: "opaque",
        consistency: "best-effort",
      },
      runtime.character ?? null,
    ),
    database,
    fileSetSource(
      {
        name: "media",
        format: "file-set-v1",
        compression: "none",
        contentKind: "file-set",
        consistency: "best-effort",
      },
      path.join(stateDir, MEDIA_DIR_NAME),
    ),
    fileSetSource(
      {
        name: "state-files",
        format: "file-set-v1",
        compression: "none",
        contentKind: "file-set",
        consistency: "best-effort",
      },
      stateDir,
      (relativePath) =>
        captureStateFileInclude(relativePath, pgliteStateFilesExclusion),
    ),
    fileSetSource(
      {
        name: "vault",
        format: "file-set-v1",
        compression: "none",
        contentKind: "file-set",
        consistency: "best-effort",
      },
      stateDir,
      vaultFileInclude,
    ),
  ]);
}

function assertComponentSources(
  components: readonly AgentBackupV2CaptureComponentSource[],
): void {
  if (
    components.length === 0 ||
    components.length > AGENT_BACKUP_CAPTURE_V2_LIMITS.maxComponents
  ) {
    captureError(
      "Capture component count is outside its bound",
      "AGENT_BACKUP_V2_COMPONENT_COUNT",
      { componentCount: components.length },
      { severity: "fatal" },
    );
  }
  let previousName: string | undefined;
  for (const source of components) {
    AgentBackupCaptureV2ComponentDescriptorSchema.parse(source.descriptor);
    if (previousName && source.descriptor.name <= previousName) {
      captureError(
        "Capture components must be unique and lexicographically ordered",
        "AGENT_BACKUP_V2_COMPONENT_ORDER",
        { previousName, componentName: source.descriptor.name },
        { severity: "fatal" },
      );
    }
    previousName = source.descriptor.name;
  }
}

/** Stream an injected capture source; used by production and large real tests. */
export async function* streamAgentBackupV2Capture(
  options: Readonly<StreamAgentBackupV2CaptureOptions>,
): AsyncGenerator<Uint8Array> {
  const request = parseAgentBackupCaptureV2Request(options.request);
  const now = options.now ?? Date.now;
  if (request.agentId !== options.agentId) {
    captureError(
      "Capture request agent does not match the active runtime",
      "AGENT_BACKUP_V2_AGENT_MISMATCH",
      { requestedAgentId: request.agentId, activeAgentId: options.agentId },
      { severity: "fatal" },
    );
  }
  const deadlineAheadMs = request.deadlineEpochMs - now();
  if (
    deadlineAheadMs <= 0 ||
    deadlineAheadMs > AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDeadlineAheadMs
  ) {
    captureError(
      "Capture request deadline is expired or too far in the future",
      "AGENT_BACKUP_V2_INVALID_DEADLINE",
      { deadlineEpochMs: request.deadlineEpochMs, deadlineAheadMs },
      { severity: "fatal" },
    );
  }
  assertComponentSources(options.components);

  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const deadlineTimer = setTimeout(
    () =>
      controller.abort(
        new AgentBackupV2CaptureError(
          "Agent backup capture deadline exceeded",
          "AGENT_BACKUP_V2_CAPTURE_DEADLINE_EXCEEDED",
          { operationId: request.operationId },
          { severity: "ephemeral" },
        ),
      ),
    Math.min(deadlineAheadMs, 2_147_483_647),
  );
  const frameDigestChain = crypto.createHash("sha256");
  let sequence = 0;
  let totalDataFrames = 0;
  let totalPlainBytes = 0;
  const base = {
    format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
    schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
  } as const;

  const serialize = async (
    header: AgentBackupCaptureV2FrameHeader,
    payload?: Uint8Array,
    includeInChain = true,
  ): Promise<Uint8Array> => {
    assertCaptureActive(request, signal, now);
    const wire = await serializeAgentBackupCaptureV2Frame(
      { header, payload },
      nodeSha256Digest,
    );
    if (includeInChain) {
      frameDigestChain.update(readAgentBackupCaptureV2FrameDigest(wire));
    }
    return wire;
  };

  try {
    for (const source of options.components) {
      if (!source.prepare) continue;
      try {
        await awaitWithCaptureControl(
          () => source.prepare?.(signal) ?? Promise.resolve(),
          request,
          signal,
          now,
        );
      } catch (error) {
        if (error instanceof AgentBackupV2CaptureError) throw error;
        throw new AgentBackupV2CaptureError(
          `Capture source preparation failed for component ${source.descriptor.name}`,
          "AGENT_BACKUP_V2_SOURCE_PREPARE_FAILED",
          {
            operationId: request.operationId,
            componentName: source.descriptor.name,
          },
          { cause: error, severity: "ephemeral" },
        );
      }
    }

    yield await serialize({
      ...base,
      kind: "capture-start",
      sequence: sequence++,
      operationId: request.operationId,
      agentId: request.agentId,
      activationGeneration: request.activationGeneration,
      lifecycleRevision: request.lifecycleRevision,
      createdAt: new Date(now()).toISOString(),
      componentCount: options.components.length,
      maxFramePayloadBytes: AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes,
    });

    for (const [componentIndex, source] of options.components.entries()) {
      yield await serialize({
        ...base,
        kind: "component-start",
        sequence: sequence++,
        componentIndex,
        component: source.descriptor,
      });
      const payloadHash = crypto.createHash("sha256");
      let componentDataFrames = 0;
      let componentPlainBytes = 0;
      const iterator = source.open(signal)[Symbol.asyncIterator]();
      let sourceCompleted = false;
      try {
        for (;;) {
          const next = await awaitWithCaptureControl(
            () => iterator.next(),
            request,
            signal,
            now,
          );
          if (next.done) {
            sourceCompleted = true;
            break;
          }
          const { bytes, entry } = next.value;
          if (!(bytes instanceof Uint8Array)) {
            captureError(
              `Component ${source.descriptor.name} yielded non-byte data`,
              "AGENT_BACKUP_V2_INVALID_SOURCE_CHUNK",
              { componentName: source.descriptor.name },
              { severity: "fatal" },
            );
          }
          if (
            bytes.length > AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes
          ) {
            captureError(
              `Component ${source.descriptor.name} exceeded the frame payload bound`,
              "AGENT_BACKUP_V2_SOURCE_CHUNK_TOO_LARGE",
              { componentName: source.descriptor.name, bytes: bytes.length },
              { severity: "fatal" },
            );
          }
          if (
            bytes.length === 0 &&
            (entry?.fileSizeBytes !== 0 || entry.fileOffsetBytes !== 0)
          ) {
            captureError(
              `Component ${source.descriptor.name} made no progress`,
              "AGENT_BACKUP_V2_ZERO_PROGRESS",
              { componentName: source.descriptor.name },
              { severity: "fatal" },
            );
          }
          if (
            totalPlainBytes >
            AGENT_BACKUP_CAPTURE_V2_LIMITS.maxPlainBytes - bytes.length
          ) {
            captureError(
              "Capture exceeds the plaintext byte limit",
              "AGENT_BACKUP_V2_PLAIN_BYTES_LIMIT",
              { observedBytes: totalPlainBytes + bytes.length },
              { severity: "fatal" },
            );
          }
          if (totalDataFrames >= AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDataFrames) {
            captureError(
              "Capture exceeds the data-frame limit",
              "AGENT_BACKUP_V2_DATA_FRAME_LIMIT",
              { observedFrames: totalDataFrames + 1 },
              { severity: "fatal" },
            );
          }
          payloadHash.update(bytes);
          yield await serialize(
            {
              ...base,
              kind: "data",
              sequence: sequence++,
              componentIndex,
              componentName: source.descriptor.name,
              dataIndex: componentDataFrames,
              offsetBytes: componentPlainBytes,
              payloadBytes: bytes.length,
              ...(entry ? { entry } : {}),
            },
            bytes,
          );
          componentDataFrames += 1;
          componentPlainBytes += bytes.length;
          totalDataFrames += 1;
          totalPlainBytes += bytes.length;
        }
      } catch (error) {
        // error-policy:J2 source failures gain stable operation/component
        // context; typed capture failures already carry that context.
        if (error instanceof AgentBackupV2CaptureError) throw error;
        throw new AgentBackupV2CaptureError(
          `Capture source failed for component ${source.descriptor.name}`,
          "AGENT_BACKUP_V2_SOURCE_FAILED",
          {
            operationId: request.operationId,
            componentName: source.descriptor.name,
          },
          { cause: error, severity: "ephemeral" },
        );
      } finally {
        if (!sourceCompleted && !controller.signal.aborted) {
          controller.abort(
            new AgentBackupV2CaptureError(
              "Agent backup capture source closed before completion",
              "AGENT_BACKUP_V2_CAPTURE_CLOSED",
              {
                operationId: request.operationId,
                componentName: source.descriptor.name,
              },
              { severity: "ephemeral" },
            ),
          );
        }
        const closing = iterator.return?.();
        if (closing) {
          if (signal.aborted) {
            // error-policy:J6 an interrupted source may never settle `return`;
            // observe cleanup rejection without pinning the HTTP deadline.
            void Promise.resolve(closing).catch((error) => {
              logger.warn(
                {
                  err: error instanceof Error ? error.message : String(error),
                  componentName: source.descriptor.name,
                },
                "[agent-backup-v2] Interrupted source cleanup failed",
              );
            });
          } else {
            await closing;
          }
        }
      }
      yield await serialize({
        ...base,
        kind: "component-end",
        sequence: sequence++,
        componentIndex,
        componentName: source.descriptor.name,
        dataFrameCount: componentDataFrames,
        plainBytes: componentPlainBytes,
        payloadSha256: payloadHash.digest("hex"),
      });
    }

    assertCaptureActive(request, signal, now);
    const frameDigestChainSha256 = frameDigestChain.digest("hex");
    yield await serialize(
      {
        ...base,
        kind: "capture-end",
        sequence: sequence++,
        componentCount: options.components.length,
        dataFrameCount: totalDataFrames,
        plainBytes: totalPlainBytes,
        frameDigestChainSha256,
      },
      undefined,
      false,
    );
  } finally {
    clearTimeout(deadlineTimer);
    for (const source of options.components) {
      try {
        source.dispose?.();
      } catch (error) {
        logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            componentName: source.descriptor.name,
          },
          "[agent-backup-v2] Capture source disposal failed",
        );
      }
    }
    if (!controller.signal.aborted) {
      controller.abort(
        new AgentBackupV2CaptureError(
          "Agent backup capture iterator closed",
          "AGENT_BACKUP_V2_CAPTURE_CLOSED",
          { operationId: request.operationId },
          { severity: "ephemeral" },
        ),
      );
    }
  }
}

/** Create the production capture stream for one authenticated runtime. */
export function createAgentBackupV2Capture(
  runtime: AgentBackupV2CaptureRuntime,
  config: ElizaConfig,
  request: AgentBackupCaptureV2Request,
  options: Readonly<CreateAgentBackupV2CaptureOptions> = {},
): AsyncIterable<Uint8Array> {
  const components =
    options.components ??
    createDefaultAgentBackupV2CaptureSources(runtime, config);
  assertComponentSources(components);
  return streamAgentBackupV2Capture({
    request,
    agentId: runtime.agentId,
    components,
    signal: options.signal,
    now: options.now,
  });
}

/** Utility for callers/tests that need the payload digest of one bounded chunk. */
export function sha256AgentBackupV2CaptureChunk(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}
