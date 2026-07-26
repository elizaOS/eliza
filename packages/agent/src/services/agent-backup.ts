/**
 * Content-hashed agent backup and restore. Captures a full agent snapshot — the
 * database (a PGlite `dumpDataDir` archive, a PGlite file-set, agent-scoped
 * Postgres rows, or a credential-free external-Postgres identity reference),
 * the content-addressed media store, the vault, the runtime character plus its
 * config file, and remaining state-dir files. Manual and automatic backups keep
 * the v1 hydrated format; pre-upgrade v2 snapshots bind shared Postgres by
 * identity so an image replacement never copies or rewrites the same external
 * database. Every captured component is content-hashed and restore refuses
 * tampered bytes. Local backup files remain KMS-encrypted v1 envelopes under the
 * state directory. Restore is destructive and returns `requiresRestart`.
 */
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentRuntime, IAgentRuntime } from "@elizaos/core";
import { ElizaError, logger } from "@elizaos/core";
import { createKmsClient, systemKey } from "@elizaos/security/kms";
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

export interface AgentBackupExternalPostgresReference {
  kind: "external-postgres-reference";
  identityVersion: 1;
  algorithm: "sha256";
  identitySha256: string;
  sha256: string;
}

export interface AgentBackupPgliteDump {
  kind: "pglite-dump";
  compression: "gzip";
  file: AgentBackupFileEntry;
  sha256: string;
}

export interface AgentBackupDatabaseComponent {
  kind:
    | "external-postgres-reference"
    | "pglite-dump"
    | "pglite-files"
    | "postgres-rows"
    | "none";
  externalPostgres?: AgentBackupExternalPostgresReference;
  pgliteDump?: AgentBackupPgliteDump;
  pglite?: AgentBackupFileSet;
  postgres?: AgentBackupPostgresDump;
  reason?: string;
  sha256: string;
}

interface AgentBackupManifestBase {
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

export interface AgentBackupManifestV1 extends AgentBackupManifestBase {
  schemaVersion: 1;
}

export interface AgentBackupManifestV2 extends AgentBackupManifestBase {
  schemaVersion: 2;
}

export type AgentBackupManifest = AgentBackupManifestV1 | AgentBackupManifestV2;

export type AgentSnapshotPurpose = "manual" | "auto" | "pre-upgrade";
export type AgentSnapshotTransfer = "chunked-v1";

export interface AgentSnapshotRequest {
  purpose?: AgentSnapshotPurpose;
  schemaVersion?: 1 | 2;
  transfer?: AgentSnapshotTransfer;
}

export interface ResolvedAgentSnapshotRequest {
  purpose: AgentSnapshotPurpose;
  schemaVersion: 1 | 2;
  transfer?: AgentSnapshotTransfer;
}

function invalidSnapshotRequest(message: string): ElizaError {
  return new ElizaError(message, {
    code: "AGENT_SNAPSHOT_REQUEST_INVALID",
    severity: "fatal",
  });
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
export const AGENT_BACKUP_V1_MAX_SOURCE_BYTES = 128 * 1024 * 1024;

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

export function parseAgentSnapshotRequest(
  input?: unknown,
): ResolvedAgentSnapshotRequest {
  if (input === undefined) {
    return { purpose: "manual", schemaVersion: 1 };
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalidSnapshotRequest("Snapshot request must be a JSON object");
  }

  const record = input as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(
    (key) => key !== "purpose" && key !== "schemaVersion" && key !== "transfer",
  );
  if (unknownKeys.length > 0) {
    throw invalidSnapshotRequest(
      `Snapshot request contains unsupported fields: ${unknownKeys.sort().join(", ")}`,
    );
  }

  const purposeValue = record.purpose;
  const purpose = purposeValue === undefined ? "manual" : purposeValue;
  if (purpose !== "manual" && purpose !== "auto" && purpose !== "pre-upgrade") {
    throw invalidSnapshotRequest(
      `Unsupported snapshot purpose: ${String(purpose)}`,
    );
  }

  const defaultSchemaVersion = purpose === "pre-upgrade" ? 2 : 1;
  const schemaVersion = record.schemaVersion ?? defaultSchemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw invalidSnapshotRequest(
      `Unsupported snapshot schema version: ${String(schemaVersion)}`,
    );
  }
  if (purpose === "pre-upgrade" && schemaVersion !== 2) {
    throw invalidSnapshotRequest(
      "Pre-upgrade snapshots require schema version 2",
    );
  }
  if (purpose !== "pre-upgrade" && schemaVersion !== 1) {
    throw invalidSnapshotRequest(
      `${purpose} snapshots require schema version 1`,
    );
  }
  const transfer = record.transfer;
  if (transfer !== undefined && transfer !== "chunked-v1") {
    throw invalidSnapshotRequest(
      `Unsupported snapshot transfer: ${String(transfer)}`,
    );
  }
  if (transfer === "chunked-v1" && purpose !== "pre-upgrade") {
    throw invalidSnapshotRequest(
      "The chunked-v1 transfer requires a pre-upgrade snapshot",
    );
  }
  return transfer
    ? { purpose, schemaVersion, transfer }
    : { purpose, schemaVersion };
}

class SnapshotSourceBudget {
  private consumedBytes = 0;

  constructor(private readonly maxBytes: number) {}

  reserve(bytes: number, source: string): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error(`Invalid snapshot source size for ${source}`);
    }
    const next = this.consumedBytes + bytes;
    if (!Number.isSafeInteger(next) || next > this.maxBytes) {
      throw new ElizaError(
        `Snapshot source exceeds the ${this.maxBytes}-byte aggregate budget`,
        {
          code: "AGENT_SNAPSHOT_SOURCE_TOO_LARGE",
          context: {
            attemptedBytes: next,
            maxBytes: this.maxBytes,
            source,
          },
          severity: "fatal",
        },
      );
    }
    this.consumedBytes = next;
  }
}

export function assertV1SnapshotSourceBytesWithinBudget(bytes: number): void {
  new SnapshotSourceBudget(AGENT_BACKUP_V1_MAX_SOURCE_BYTES).reserve(
    bytes,
    "test-boundary",
  );
}

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

interface ExternalPostgresIdentity {
  identityVersion: 1;
  backend: "postgresql";
  host: string;
  port: number;
  database: string;
  agentId: string;
  namespace: string | null;
}

function invalidExternalPostgresIdentity(
  message: string,
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, {
    code: "AGENT_SNAPSHOT_POSTGRES_IDENTITY_INVALID",
    cause,
    severity: "fatal",
  });
}

const POSTGRES_IDENTITY_QUERY_KEYS = new Set([
  "database",
  "dbname",
  "host",
  "port",
]);
const POSTGRES_NAMESPACE_QUERY_KEYS = new Set([
  "currentschema",
  "schema",
  "search_path",
]);

function normalizePostgresNamespace(url: URL): string | null {
  const candidates: string[] = [];
  for (const [rawKey, rawValue] of url.searchParams) {
    const key = rawKey.toLowerCase();
    if (POSTGRES_IDENTITY_QUERY_KEYS.has(key)) {
      throw invalidExternalPostgresIdentity(
        `Postgres identity parameter ${rawKey} must be encoded in the connection URL authority/path`,
      );
    }
    if (POSTGRES_NAMESPACE_QUERY_KEYS.has(key)) {
      const value = rawValue.trim();
      if (!value) {
        throw invalidExternalPostgresIdentity(
          `Postgres namespace parameter ${rawKey} is empty`,
        );
      }
      candidates.push(value);
      continue;
    }
    if (key !== "options") continue;
    for (const match of rawValue.matchAll(
      /(?:^|\s)(?:-c\s*)?search_path\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/gi,
    )) {
      const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (value) candidates.push(value);
    }
  }

  const distinct = [...new Set(candidates)];
  if (distinct.length > 1) {
    throw invalidExternalPostgresIdentity(
      "Postgres connection URL has conflicting namespaces",
    );
  }
  return distinct[0] ?? null;
}

function externalPostgresIdentity(
  postgresUrl: string,
  agentId: string,
): ExternalPostgresIdentity {
  let parsed: URL;
  try {
    parsed = new URL(postgresUrl);
  } catch (cause) {
    // error-policy:J2 Preserve the parser failure without logging the credential-bearing URL.
    throw invalidExternalPostgresIdentity(
      "POSTGRES_URL is not a valid URL",
      cause,
    );
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw invalidExternalPostgresIdentity(
      "POSTGRES_URL must use postgres:// or postgresql://",
    );
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) {
    throw invalidExternalPostgresIdentity(
      "POSTGRES_URL must identify a database host",
    );
  }
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 5432;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw invalidExternalPostgresIdentity("POSTGRES_URL has an invalid port");
  }

  let database: string;
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  } catch (cause) {
    // error-policy:J2 Preserve the decoder failure while withholding the source URL.
    throw invalidExternalPostgresIdentity(
      "POSTGRES_URL has an invalid encoded database name",
      cause,
    );
  }
  if (!database) {
    throw invalidExternalPostgresIdentity(
      "POSTGRES_URL must include an explicit database name for snapshot identity",
    );
  }
  if (!agentId.trim()) {
    throw invalidExternalPostgresIdentity(
      "Agent id is required for snapshot identity",
    );
  }

  return {
    identityVersion: 1,
    backend: "postgresql",
    host,
    port,
    database,
    agentId,
    namespace: normalizePostgresNamespace(parsed),
  };
}

function externalPostgresIdentitySha256(
  postgresUrl: string,
  agentId: string,
): string {
  return sha256Json(externalPostgresIdentity(postgresUrl, agentId));
}

function withExternalPostgresReferenceHash(
  reference: AgentBackupExternalPostgresReference,
): AgentBackupExternalPostgresReference {
  return {
    ...reference,
    sha256: sha256Json({
      kind: reference.kind,
      identityVersion: reference.identityVersion,
      algorithm: reference.algorithm,
      identitySha256: reference.identitySha256,
    }),
  };
}

export function createExternalPostgresReference(
  postgresUrl: string,
  agentId: string,
): AgentBackupExternalPostgresReference {
  return withExternalPostgresReferenceHash({
    kind: "external-postgres-reference",
    identityVersion: 1,
    algorithm: "sha256",
    identitySha256: externalPostgresIdentitySha256(postgresUrl, agentId),
    sha256: "",
  });
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
  budget?: SnapshotSourceBudget,
): Promise<AgentBackupFileEntry> {
  const before = await fs.lstat(absolutePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Snapshot source is not a regular file: ${absolutePath}`);
  }
  const handle = await fs.open(
    absolutePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error(`Snapshot source changed while opening: ${absolutePath}`);
    }
    budget?.reserve(opened.size, absolutePath);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.length !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino
    ) {
      throw new Error(`Snapshot source changed while reading: ${absolutePath}`);
    }
    const relative = normalizeRelativePath(path.relative(root, absolutePath));
    return {
      path: relative,
      sha256: sha256Bytes(bytes),
      size: bytes.length,
      mode: opened.mode,
      mtimeMs: opened.mtimeMs,
      bytesBase64: bytes.toString("base64"),
    };
  } finally {
    await handle.close();
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
  budget?: SnapshotSourceBudget;
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
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (!isWithin(root, absolute)) continue;
      const relative = normalizeRelativePath(path.relative(root, absolute));
      if (params.include && !params.include(relative)) continue;
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Snapshot source contains a symbolic link: ${relative}`,
        );
      }
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        files.push(await readFileEntry(root, absolute, params.budget));
      } else {
        throw new Error(`Snapshot source is not a regular file: ${relative}`);
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
    if (configured === ":memory:" || configured.includes("://")) {
      return configured;
    }
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

async function capturePostgresRows(
  postgresUrl: string,
  agentId: string,
  budget?: SnapshotSourceBudget,
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
        const result = await pool.query(
          `SELECT e.*
           FROM ${quoteIdentifier(tableName)} e
           INNER JOIN ${quoteIdentifier(POSTGRES_MEMORIES_TABLE)} m
             ON e.${quoteIdentifier("memory_id")} = m.${quoteIdentifier("id")}
           WHERE m.${quoteIdentifier("agent_id")} = $1`,
          [agentId],
        );
        rows = result.rows as JsonRecord[];
      } else {
        const ownerColumn = agentIdColumn(columnSet);
        if (!ownerColumn) continue;
        const result = await pool.query(
          `SELECT * FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(ownerColumn)} = $1`,
          [agentId],
        );
        rows = result.rows as JsonRecord[];
      }
      if (
        tableName === POSTGRES_AGENT_TABLE ||
        tableName === POSTGRES_EMBEDDINGS_TABLE ||
        agentIdColumn(columnSet)
      ) {
        budget?.reserve(
          Buffer.byteLength(stableJson(rows)),
          `postgres:${tableName}`,
        );
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
  budget?: SnapshotSourceBudget,
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
  budget?.reserve(dump.size, PGLITE_DUMP_PATH);
  const bytes = Buffer.from(await dump.arrayBuffer());
  return withPgliteDumpHash({
    kind: "pglite-dump",
    compression: "gzip",
    file: fileEntryFromBytes(PGLITE_DUMP_PATH, bytes),
    sha256: "",
  });
}

async function captureDatabaseComponent(
  runtime: IAgentRuntime | AgentRuntime,
  request: ResolvedAgentSnapshotRequest,
  budget?: SnapshotSourceBudget,
): Promise<AgentBackupDatabaseComponent> {
  const postgresUrl = hasPostgresUrl(runtime);
  if (postgresUrl) {
    if (request.schemaVersion === 2) {
      const externalPostgres = createExternalPostgresReference(
        postgresUrl,
        runtime.agentId,
      );
      return {
        kind: "external-postgres-reference",
        externalPostgres,
        sha256: externalPostgres.sha256,
      };
    }
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
    if (request.schemaVersion === 2) {
      throw new ElizaError(
        `Pre-upgrade snapshot cannot capture ${reason.toLowerCase()}`,
        {
          code: "AGENT_SNAPSHOT_DATABASE_UNCAPTURABLE",
          context: { databaseKind: "pglite" },
          severity: "fatal",
        },
      );
    }
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
  budget?: SnapshotSourceBudget,
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
  requestInput?: AgentSnapshotRequest,
): Promise<AgentBackupStateData> {
  const request = parseAgentSnapshotRequest(requestInput);
  const sourceBudget =
    request.schemaVersion === 1
      ? new SnapshotSourceBudget(AGENT_BACKUP_V1_MAX_SOURCE_BYTES)
      : undefined;
  const stateDir = resolveStateDir();
  const pgliteDirForStateFiles = hasPostgresUrl(runtime)
    ? null
    : await resolvePgliteDir();
  const stateFileInclude = makeStateFileInclude(
    stateDir,
    pgliteDirForStateFiles,
  );
  // V1 hydrates every byte into one JSON object, so capture sequentially to
  // make the aggregate cap a real peak-memory bound rather than racing several
  // reads that each passed the budget check.
  const database = await captureDatabaseComponent(
    runtime,
    request,
    sourceBudget,
  );
  const media = await collectFileSet({
    root: path.join(stateDir, MEDIA_DIR_NAME),
    rootLabel: "state-dir",
    budget: sourceBudget,
  });
  const vault = await collectFileSet({
    root: stateDir,
    rootLabel: "state-dir",
    include: vaultFileInclude,
    budget: sourceBudget,
  });
  const character = await captureCharacterComponent(runtime, sourceBudget);
  const stateFiles = await collectFileSet({
    root: stateDir,
    rootLabel: "state-dir",
    include: stateFileInclude,
    budget: sourceBudget,
  });

  const componentHashes = {
    database: database.sha256,
    media: media.sha256,
    vault: vault.sha256,
    character: character.sha256,
    stateFiles: stateFiles.sha256,
  };
  const manifestFields = {
    format: "elizaos.agent-backup" as const,
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
  const manifest: AgentBackupManifest =
    request.schemaVersion === 1
      ? { ...manifestFields, schemaVersion: 1 }
      : { ...manifestFields, schemaVersion: 2 };

  logger.info(
    {
      agentId: runtime.agentId,
      purpose: request.purpose,
      schemaVersion: request.schemaVersion,
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

export function verifyExternalPostgresReference(
  postgresUrl: string,
  agentId: string,
  database: AgentBackupDatabaseComponent,
): void {
  const databaseKeys = Object.keys(database).sort();
  if (
    stableJson(databaseKeys) !==
    stableJson(["externalPostgres", "kind", "sha256"])
  ) {
    throw new ElizaError(
      "Backup external Postgres database component has unsupported fields",
      {
        code: "AGENT_SNAPSHOT_POSTGRES_REFERENCE_INVALID",
        severity: "fatal",
      },
    );
  }
  const reference = database.externalPostgres;
  if (!reference) {
    throw new ElizaError(
      "Backup database component is missing external Postgres identity",
      {
        code: "AGENT_SNAPSHOT_POSTGRES_REFERENCE_INVALID",
        severity: "fatal",
      },
    );
  }
  const referenceKeys = Object.keys(reference).sort();
  if (
    stableJson(referenceKeys) !==
    stableJson([
      "algorithm",
      "identitySha256",
      "identityVersion",
      "kind",
      "sha256",
    ])
  ) {
    throw new ElizaError(
      "Backup external Postgres identity has unsupported fields",
      {
        code: "AGENT_SNAPSHOT_POSTGRES_REFERENCE_INVALID",
        severity: "fatal",
      },
    );
  }
  if (
    reference.kind !== "external-postgres-reference" ||
    reference.identityVersion !== 1 ||
    reference.algorithm !== "sha256" ||
    !/^[a-f0-9]{64}$/.test(reference.identitySha256) ||
    !/^[a-f0-9]{64}$/.test(reference.sha256)
  ) {
    throw new ElizaError("Backup external Postgres identity is malformed", {
      code: "AGENT_SNAPSHOT_POSTGRES_REFERENCE_INVALID",
      severity: "fatal",
    });
  }

  const expectedReference = withExternalPostgresReferenceHash({
    ...reference,
    sha256: "",
  });
  if (
    expectedReference.sha256 !== reference.sha256 ||
    database.sha256 !== reference.sha256
  ) {
    throw new ElizaError(
      "Backup external Postgres identity hash is inconsistent",
      {
        code: "AGENT_SNAPSHOT_POSTGRES_REFERENCE_INVALID",
        severity: "fatal",
      },
    );
  }

  const expectedIdentity = externalPostgresIdentitySha256(postgresUrl, agentId);
  if (
    !crypto.timingSafeEqual(
      Buffer.from(expectedIdentity, "hex"),
      Buffer.from(reference.identitySha256, "hex"),
    )
  ) {
    throw new ElizaError(
      "Backup external Postgres identity does not match this agent database",
      {
        code: "AGENT_SNAPSHOT_POSTGRES_IDENTITY_MISMATCH",
        context: { agentId },
        severity: "fatal",
      },
    );
  }
}

function assertManifest(snapshot: AgentBackupStateData): AgentBackupManifest {
  const manifest = snapshot.manifest;
  if (
    manifest?.format !== "elizaos.agent-backup" ||
    (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2)
  ) {
    throw new Error("Unsupported or missing elizaOS backup manifest");
  }
  if (
    manifest.schemaVersion === 1 &&
    manifest.components.database.kind === "external-postgres-reference"
  ) {
    throw new ElizaError(
      "Schema version 1 cannot contain an external Postgres reference",
      {
        code: "AGENT_SNAPSHOT_SCHEMA_INVALID",
        severity: "fatal",
      },
    );
  }
  if (
    manifest.schemaVersion === 2 &&
    manifest.components.database.kind === "postgres-rows"
  ) {
    throw new ElizaError(
      "Schema version 2 cannot contain hydrated Postgres rows",
      {
        code: "AGENT_SNAPSHOT_SCHEMA_INVALID",
        severity: "fatal",
      },
    );
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
  if (database.kind === "external-postgres-reference") {
    const postgresUrl = hasPostgresUrl(runtime);
    if (!postgresUrl) {
      throw new ElizaError(
        "Backup references external Postgres but POSTGRES_URL is not configured",
        {
          code: "AGENT_SNAPSHOT_POSTGRES_CONFIG_MISSING",
          context: { agentId: runtime.agentId },
          severity: "fatal",
        },
      );
    }
    verifyExternalPostgresReference(postgresUrl, runtime.agentId, database);
  } else if (database.kind === "postgres-rows") {
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
