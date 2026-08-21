/**
 * Restore-drill harness for the apps tenant Postgres off-host backups
 * (#21729). Consumes one dated backup set produced by the node's
 * tenant-db-backup timer (encrypted archive + plaintext sidecar), verifies
 * archive integrity and freshness, decrypts and checksums the contents, and
 * plans/executes a restore into an ISOLATED verification target — never the
 * production node. Emits a redacted JSON drill report with measured RPO
 * (backup age) and RTO (restore duration) against the declared objectives.
 *
 * Safety invariants: before any destructive SQL, the direct target must return
 * the operator's unique disposable-target identity from a server-side custom
 * setting; aliases and tunnels therefore cannot bypass the guard. Isolation is
 * proven by authenticating as every restored tenant role through both direct
 * Postgres and the isolated pgbouncer. DSNs, credentials, and tenant names
 * never reach reports or logs (reports reference truncated dump ids only).
 *
 * Usage (operator drill, needs openssl + tar + psql client tools):
 *   bun packages/cloud/scripts/admin/apps-tenant-db-recovery.ts \
 *     --set-dir /path/to/downloaded/<stamp> \
 *     --target-dsn postgresql://postgres:...@127.0.0.1:5433/postgres \
 *     --target-id drill-11111111-2222-4333-8444-555555555555 \
 *     --pooler-endpoint 127.0.0.1:6432 \
 *     --tenant-probes-file /path/to/tenant-probes.json \
 *     --passphrase-file /path/to/passphrase \
 *     --rpo-hours 26 --rto-minutes 60 --output /tmp/drill-report.json
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const SHA256 = /^[a-f0-9]{64}$/;
const DUMP_ID = /^[a-f0-9]{12}$/;
export const REPORT_SCHEMA_VERSION = 1 as const;

const RESTORE_TARGET_ID =
  /^drill-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASSWORD_ENV = /^[A-Z][A-Z0-9_]*$/;
export const POOLER_PORT = 6432;

export class RecoveryDrillError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "RecoveryDrillError";
  }
}

export interface BackupSidecar {
  schemaVersion: 1;
  createdAt: Date;
  archive: string;
  archiveSha256: string;
  archiveBytes: number;
  databaseCount: number;
  cipher: string;
}

export interface BackupManifest {
  schemaVersion: 1;
  createdAt: Date;
  databaseCount: number;
}

/** Strip credentials and query material from a DSN so it is log-safe. */
export function redactDsn(dsn: string): string {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    // error-policy:J3 untrusted-input sanitizing — an unparseable DSN must
    // never be echoed back verbatim; the explicit invalid marker replaces it.
    return "<invalid-dsn>";
  }
  const host = url.hostname === "" ? "<no-host>" : url.hostname;
  const port = url.port === "" ? "<default>" : url.port;
  return `postgresql://<redacted>@${host}:${port}/<db>`;
}

function requireString(value: unknown, field: string, source: string): string {
  if (typeof value !== "string" || value === "") {
    throw new RecoveryDrillError(
      "INVALID_METADATA",
      `${source}: missing or empty field '${field}'`,
    );
  }
  return value;
}

function requireCount(value: unknown, field: string, source: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RecoveryDrillError(
      "INVALID_METADATA",
      `${source}: field '${field}' must be a non-negative integer`,
    );
  }
  return value;
}

function requireIsoDate(value: unknown, field: string, source: string): Date {
  const raw = requireString(value, field, source);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new RecoveryDrillError(
      "INVALID_METADATA",
      `${source}: field '${field}' is not a valid ISO timestamp`,
    );
  }
  return parsed;
}

/** Parse and validate the plaintext sidecar uploaded next to each archive. */
export function parseBackupSidecar(json: string): BackupSidecar {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (cause) {
    // error-policy:J3 untrusted sidecar JSON becomes an explicit invalid result.
    throw new RecoveryDrillError(
      "INVALID_METADATA",
      `sidecar is not valid JSON: ${(cause as Error).message}`,
    );
  }
  const record = raw as Record<string, unknown>;
  if (
    record.schema_version !== 1 ||
    record.kind !== "tenant-db-backup-sidecar"
  ) {
    throw new RecoveryDrillError(
      "INVALID_METADATA",
      "sidecar: unsupported schema_version/kind",
    );
  }
  const archiveSha256 = requireString(
    record.archive_sha256,
    "archive_sha256",
    "sidecar",
  );
  if (!SHA256.test(archiveSha256)) {
    throw new RecoveryDrillError(
      "INVALID_METADATA",
      "sidecar: archive_sha256 is not sha256 hex",
    );
  }
  return {
    schemaVersion: 1,
    createdAt: requireIsoDate(record.created_at, "created_at", "sidecar"),
    archive: requireString(record.archive, "archive", "sidecar"),
    archiveSha256,
    archiveBytes: requireCount(
      record.archive_bytes,
      "archive_bytes",
      "sidecar",
    ),
    databaseCount: requireCount(
      record.database_count,
      "database_count",
      "sidecar",
    ),
    cipher: requireString(record.cipher, "cipher", "sidecar"),
  };
}

/** Parse and validate the manifest found inside the decrypted archive. */
export function parseBackupManifest(json: string): BackupManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (cause) {
    // error-policy:J3 untrusted manifest JSON becomes an explicit invalid result.
    throw new RecoveryDrillError(
      "INVALID_METADATA",
      `manifest is not valid JSON: ${(cause as Error).message}`,
    );
  }
  const record = raw as Record<string, unknown>;
  if (record.schema_version !== 1 || record.kind !== "tenant-db-backup") {
    throw new RecoveryDrillError(
      "INVALID_METADATA",
      "manifest: unsupported schema_version/kind",
    );
  }
  return {
    schemaVersion: 1,
    createdAt: requireIsoDate(record.created_at, "created_at", "manifest"),
    databaseCount: requireCount(
      record.database_count,
      "database_count",
      "manifest",
    ),
  };
}

/**
 * Validate only the direct-Postgres transport shape. Isolation authority is
 * established separately from a server-side nonce, never from this hostname.
 */
export function assertDirectTarget(targetDsn: string): URL {
  let url: URL;
  try {
    url = new URL(targetDsn);
  } catch {
    // error-policy:J3 untrusted DSN syntax becomes an explicit invalid target.
    throw new RecoveryDrillError(
      "INVALID_TARGET",
      "target DSN is not a parseable URL",
    );
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new RecoveryDrillError(
      "INVALID_TARGET",
      "target DSN must be a postgresql:// URL",
    );
  }
  if (url.hostname === "" || url.pathname === "" || url.pathname === "/") {
    throw new RecoveryDrillError(
      "INVALID_TARGET",
      "target DSN must include a host and maintenance database",
    );
  }
  if (url.port === String(POOLER_PORT)) {
    throw new RecoveryDrillError(
      "REFUSED_POOLER_TARGET",
      "restore target must be direct Postgres; pgbouncer is a separate probe surface",
    );
  }
  return url;
}

/** Fail closed unless the server itself returns the one-use disposable nonce. */
export function assertRestoreTargetIdentity(
  expectedTargetId: string,
  observedTargetId: string,
): void {
  if (!RESTORE_TARGET_ID.test(expectedTargetId)) {
    throw new RecoveryDrillError(
      "INVALID_TARGET_AUTHORITY",
      "--target-id must be drill- followed by a UUID",
    );
  }
  if (observedTargetId === "" || observedTargetId !== expectedTargetId) {
    throw new RecoveryDrillError(
      "REFUSED_TARGET_AUTHORITY",
      "target did not return the expected disposable restore identity",
    );
  }
}

export interface PgEndpoint {
  host: string;
  port: string;
}

/** Parse the credential-free isolated pgbouncer endpoint. */
export function parsePoolerEndpoint(value: string): PgEndpoint {
  let url: URL;
  try {
    url = new URL(`postgresql://probe@${value}/postgres`);
  } catch {
    // error-policy:J3 untrusted endpoint syntax becomes an explicit invalid argument.
    throw new RecoveryDrillError(
      "INVALID_ARGS",
      "--pooler-endpoint must be host:6432",
    );
  }
  if (
    url.username !== "probe" ||
    url.password !== "" ||
    url.hostname === "" ||
    url.port !== String(POOLER_PORT) ||
    url.pathname !== "/postgres" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new RecoveryDrillError(
      "INVALID_ARGS",
      "--pooler-endpoint must be a credential-free host:6432 endpoint",
    );
  }
  return { host: url.hostname, port: url.port };
}

export interface ChecksumEntry {
  sha256: string;
  file: string;
}

/** Parse a `sha256sum`-format checksum file into typed entries. */
export function parseChecksumFile(text: string): ChecksumEntry[] {
  const entries: ChecksumEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const match = /^([a-f0-9]{64})\s+[* ]?(.+)$/.exec(line);
    if (!match) {
      throw new RecoveryDrillError(
        "INVALID_METADATA",
        "checksums.sha256: malformed line",
      );
    }
    entries.push({ sha256: match[1], file: match[2].trim() });
  }
  if (entries.length === 0) {
    throw new RecoveryDrillError("INVALID_METADATA", "checksums.sha256: empty");
  }
  return entries;
}

/**
 * Verify every checksummed file in the decrypted workspace. Returns the number
 * of verified files; throws on the first mismatch or missing file.
 */
export function verifyChecksums(
  workDir: string,
  entries: ChecksumEntry[],
): number {
  for (const entry of entries) {
    if (entry.file.includes("..") || entry.file.startsWith("/")) {
      throw new RecoveryDrillError(
        "INVALID_METADATA",
        "checksums.sha256: path escapes the workspace",
      );
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(workDir, entry.file));
    } catch (cause) {
      // error-policy:J3 untrusted archive metadata cannot fabricate a missing file.
      throw new RecoveryDrillError(
        "CHECKSUM_MISSING_FILE",
        `checksummed file missing from archive: ${entry.file} (${(cause as Error).message})`,
      );
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== entry.sha256) {
      throw new RecoveryDrillError(
        "CHECKSUM_MISMATCH",
        `checksum mismatch: ${entry.file}`,
      );
    }
  }
  return entries.length;
}

export interface DbMapEntry {
  dumpId: string;
  /** Real tenant database name — restore-side use only; never in reports. */
  databaseName: string;
}

/** Parse dbmap.tsv (truncated-hash dump id <TAB> real database name). */
export function parseDbMap(text: string): DbMapEntry[] {
  const entries: DbMapEntry[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const [dumpId, databaseName, ...rest] = line.split("\t");
    if (!dumpId || !databaseName || rest.length > 0 || !DUMP_ID.test(dumpId)) {
      throw new RecoveryDrillError(
        "INVALID_METADATA",
        "dbmap.tsv: malformed line",
      );
    }
    if (seen.has(dumpId)) {
      throw new RecoveryDrillError(
        "INVALID_METADATA",
        "dbmap.tsv: duplicate dump id",
      );
    }
    seen.add(dumpId);
    entries.push({ dumpId, databaseName });
  }
  return entries;
}

export interface TenantProbe {
  dumpId: string;
  role: string;
  passwordEnv: string;
}

/**
 * Parse credential references for the real tenant-role probes. The document
 * maps opaque dump ids to roles and environment-variable names; it never
 * contains passwords or tenant database names.
 */
export function parseTenantProbes(
  json: string,
  databases: DbMapEntry[],
): TenantProbe[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    // error-policy:J3 untrusted probe JSON becomes an explicit invalid result.
    throw new RecoveryDrillError(
      "INVALID_PROBE_METADATA",
      "tenant probe file is not valid JSON",
    );
  }
  if (typeof raw !== "object" || raw === null) {
    throw new RecoveryDrillError(
      "INVALID_PROBE_METADATA",
      "tenant probe file must be an object",
    );
  }
  const record = raw as Record<string, unknown>;
  if (record.schema_version !== 1 || !Array.isArray(record.tenants)) {
    throw new RecoveryDrillError(
      "INVALID_PROBE_METADATA",
      "tenant probe file has unsupported schema_version/tenants",
    );
  }
  const expected = new Set(databases.map((entry) => entry.dumpId));
  const seen = new Set<string>();
  const probes: TenantProbe[] = [];
  for (const item of record.tenants) {
    if (typeof item !== "object" || item === null) {
      throw new RecoveryDrillError(
        "INVALID_PROBE_METADATA",
        "tenant probe entry must be an object",
      );
    }
    const entry = item as Record<string, unknown>;
    const dumpId = entry.dump_id;
    const role = entry.role;
    const passwordEnv = entry.password_env;
    if (
      typeof dumpId !== "string" ||
      !DUMP_ID.test(dumpId) ||
      !expected.has(dumpId) ||
      seen.has(dumpId) ||
      typeof role !== "string" ||
      role === "" ||
      role.length > 128 ||
      role.includes("\0") ||
      typeof passwordEnv !== "string" ||
      !PASSWORD_ENV.test(passwordEnv)
    ) {
      throw new RecoveryDrillError(
        "INVALID_PROBE_METADATA",
        "tenant probe entry is invalid, duplicated, or not in dbmap",
      );
    }
    seen.add(dumpId);
    probes.push({ dumpId, role, passwordEnv });
  }
  if (seen.size !== expected.size) {
    throw new RecoveryDrillError(
      "INVALID_PROBE_METADATA",
      "tenant probe file must cover every restored database exactly once",
    );
  }
  return probes;
}

export interface RecoveryObjectives {
  rpoHours: number;
  rtoMinutes: number;
}

export interface ObjectiveEvaluation {
  rpoSeconds: number;
  rpoMet: boolean;
  rtoSeconds: number;
  rtoMet: boolean;
  met: boolean;
}

/** Measured RPO (backup age at drill time) and RTO (restore wall time). */
export function evaluateObjectives(
  backupCreatedAt: Date,
  drillStartedAt: Date,
  restoreSeconds: number,
  objectives: RecoveryObjectives,
): ObjectiveEvaluation {
  const rpoSeconds = Math.max(
    0,
    Math.round((drillStartedAt.getTime() - backupCreatedAt.getTime()) / 1000),
  );
  const rpoMet = rpoSeconds <= objectives.rpoHours * 3600;
  const rtoMet = restoreSeconds <= objectives.rtoMinutes * 60;
  return {
    rpoSeconds,
    rpoMet,
    rtoSeconds: restoreSeconds,
    rtoMet,
    met: rpoMet && rtoMet,
  };
}

/**
 * Post-restore isolation probes, mirroring the production boundary: each
 * tenant role must connect to its own database and be REJECTED connecting to
 * every other tenant database. Returns check descriptors keyed by dump id so
 * the report never carries tenant names.
 */
export interface IsolationCheck {
  kind: "own-connect" | "cross-reject";
  subjectDumpId: string;
  objectDumpId: string;
}

export function buildIsolationChecks(entries: DbMapEntry[]): IsolationCheck[] {
  const checks: IsolationCheck[] = [];
  for (const subject of entries) {
    checks.push({
      kind: "own-connect",
      subjectDumpId: subject.dumpId,
      objectDumpId: subject.dumpId,
    });
    for (const object of entries) {
      if (object.dumpId === subject.dumpId) continue;
      checks.push({
        kind: "cross-reject",
        subjectDumpId: subject.dumpId,
        objectDumpId: object.dumpId,
      });
    }
  }
  return checks;
}

export interface CliOptions {
  setDir: string;
  targetDsn: string;
  targetId: string;
  poolerEndpoint: PgEndpoint;
  tenantProbesFile: string;
  passphraseFile: string;
  rpoHours: number;
  rtoMinutes: number;
  output: string | undefined;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      "set-dir": { type: "string" },
      "target-dsn": { type: "string" },
      "target-id": { type: "string" },
      "pooler-endpoint": { type: "string" },
      "tenant-probes-file": { type: "string" },
      "passphrase-file": { type: "string" },
      "rpo-hours": { type: "string", default: "26" },
      "rto-minutes": { type: "string", default: "60" },
      output: { type: "string" },
    },
  });
  const setDir = values["set-dir"];
  const targetDsn = values["target-dsn"];
  const targetId = values["target-id"];
  const poolerEndpoint = values["pooler-endpoint"];
  const tenantProbesFile = values["tenant-probes-file"];
  const passphraseFile = values["passphrase-file"];
  if (
    !setDir ||
    !targetDsn ||
    !targetId ||
    !poolerEndpoint ||
    !tenantProbesFile ||
    !passphraseFile
  ) {
    throw new RecoveryDrillError(
      "INVALID_ARGS",
      "required: --set-dir, --target-dsn, --target-id, --pooler-endpoint, --tenant-probes-file, and --passphrase-file",
    );
  }
  assertRestoreTargetIdentity(targetId, targetId);
  const rpoHours = Number(values["rpo-hours"]);
  const rtoMinutes = Number(values["rto-minutes"]);
  if (
    !Number.isFinite(rpoHours) ||
    rpoHours <= 0 ||
    !Number.isFinite(rtoMinutes) ||
    rtoMinutes <= 0
  ) {
    throw new RecoveryDrillError(
      "INVALID_ARGS",
      "--rpo-hours and --rto-minutes must be positive numbers",
    );
  }
  return {
    setDir,
    targetDsn,
    targetId,
    poolerEndpoint: parsePoolerEndpoint(poolerEndpoint),
    tenantProbesFile,
    passphraseFile,
    rpoHours,
    rtoMinutes,
    output: values.output,
  };
}

function run(
  command: string,
  args: string[],
  opts: { env?: Record<string, string>; input?: string } = {},
): string {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    input: opts.input,
    env: { ...process.env, ...opts.env },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new RecoveryDrillError(
      "TOOL_FAILED",
      `${command} could not be executed: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new RecoveryDrillError(
      "TOOL_FAILED",
      `${command} exited ${result.status}`,
    );
  }
  return result.stdout;
}

function expectCommandFailure(
  command: string,
  args: string[],
  env: Record<string, string>,
): void {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new RecoveryDrillError(
      "TOOL_FAILED",
      `${command} could not be executed: ${result.error.message}`,
    );
  }
  if (result.status === 0) {
    throw new RecoveryDrillError(
      "ISOLATION_VIOLATION",
      "cross-tenant authentication unexpectedly succeeded",
    );
  }
  if (!/permission denied for database/i.test(result.stderr)) {
    throw new RecoveryDrillError(
      "TOOL_FAILED",
      "cross-tenant probe failed without a database CONNECT denial",
    );
  }
}

function tenantConnectionEnv(
  endpoint: PgEndpoint,
  database: string,
  role: string,
  password: string,
): Record<string, string> {
  return {
    PGHOST: endpoint.host,
    PGPORT: endpoint.port,
    PGDATABASE: database,
    PGUSER: role,
    PGPASSWORD: password,
    PGCONNECT_TIMEOUT: "10",
  };
}

interface DrillReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  startedAt: string;
  target: string;
  archiveSha256: string;
  archiveBytes: number;
  databaseCount: number;
  checksummedFiles: number;
  isolation: { total: number; passed: number };
  objectives: ObjectiveEvaluation & RecoveryObjectives;
}

/** Execute the full drill. Requires openssl, tar, psql, pg_restore on PATH. */
function executeDrill(options: CliOptions): DrillReport {
  const targetUrl = assertDirectTarget(options.targetDsn);
  const observedTargetId = run("psql", [
    "--tuples-only",
    "--no-align",
    "--set",
    "ON_ERROR_STOP=1",
    "--dbname",
    options.targetDsn,
    "--command",
    "SELECT current_setting('eliza.restore_target_id', true)",
  ]).trim();
  assertRestoreTargetIdentity(options.targetId, observedTargetId);
  const startedAt = new Date();

  const sidecar = parseBackupSidecar(
    readFileSync(join(options.setDir, "backup.json"), "utf-8"),
  );
  const archivePath = join(options.setDir, sidecar.archive);
  const archiveBytes = statSync(archivePath).size;
  if (archiveBytes !== sidecar.archiveBytes) {
    throw new RecoveryDrillError(
      "ARCHIVE_SIZE_MISMATCH",
      "downloaded archive size differs from sidecar",
    );
  }
  const actualSha = createHash("sha256")
    .update(readFileSync(archivePath))
    .digest("hex");
  if (actualSha !== sidecar.archiveSha256) {
    throw new RecoveryDrillError(
      "ARCHIVE_CHECKSUM_MISMATCH",
      "downloaded archive sha256 differs from sidecar",
    );
  }

  const work = mkdtempSync(join(tmpdir(), "tenant-db-drill-"));
  try {
    run("openssl", [
      "enc",
      "-d",
      "-aes-256-cbc",
      "-pbkdf2",
      "-iter",
      "210000",
      "-in",
      archivePath,
      "-out",
      join(work, "backup.tar.gz"),
      "-pass",
      `file:${options.passphraseFile}`,
    ]);
    run("tar", ["-xzf", join(work, "backup.tar.gz"), "-C", work]);

    const manifest = parseBackupManifest(
      readFileSync(join(work, "manifest.json"), "utf-8"),
    );
    if (manifest.databaseCount !== sidecar.databaseCount) {
      throw new RecoveryDrillError(
        "INVALID_METADATA",
        "manifest/sidecar database_count mismatch",
      );
    }
    const checksums = parseChecksumFile(
      readFileSync(join(work, "checksums.sha256"), "utf-8"),
    );
    const checksummedFiles = verifyChecksums(work, checksums);
    const dbMap = parseDbMap(readFileSync(join(work, "dbmap.tsv"), "utf-8"));
    if (dbMap.length !== manifest.databaseCount) {
      throw new RecoveryDrillError(
        "INVALID_METADATA",
        "dbmap entry count differs from manifest database_count",
      );
    }

    const probes = parseTenantProbes(
      readFileSync(options.tenantProbesFile, "utf-8"),
      dbMap,
    );
    const probeById = new Map(probes.map((probe) => [probe.dumpId, probe]));
    const passwords = new Map<string, string>();
    for (const probe of probes) {
      const password = process.env[probe.passwordEnv];
      if (password === undefined || password === "") {
        throw new RecoveryDrillError(
          "MISSING_PROBE_SECRET",
          `required tenant probe environment variable is absent (dump=${probe.dumpId})`,
        );
      }
      passwords.set(probe.dumpId, password);
    }

    const restoreStart = Date.now();
    run("psql", [
      "--set",
      "ON_ERROR_STOP=1",
      "--dbname",
      options.targetDsn,
      "--file",
      join(work, "globals.sql"),
    ]);
    for (const entry of dbMap) {
      const dumpFile = join(work, "dumps", `${entry.dumpId}.dump`);
      run("psql", [
        "--set",
        "ON_ERROR_STOP=1",
        "--dbname",
        options.targetDsn,
        "--command",
        `DROP DATABASE IF EXISTS "${entry.databaseName.replaceAll('"', '""')}"`,
      ]);
      run("pg_restore", [
        "--create",
        "--exit-on-error",
        "--dbname",
        options.targetDsn,
        dumpFile,
      ]);
    }
    const restoreSeconds = Math.round((Date.now() - restoreStart) / 1000);

    const checks = buildIsolationChecks(dbMap);
    const byId = new Map(
      dbMap.map((entry) => [entry.dumpId, entry.databaseName]),
    );
    const directEndpoint = {
      host: targetUrl.hostname,
      port: targetUrl.port === "" ? "5432" : targetUrl.port,
    };
    const surfaces = [
      { name: "direct", endpoint: directEndpoint },
      { name: "pooler", endpoint: options.poolerEndpoint },
    ] as const;
    let passed = 0;
    for (const check of checks) {
      const objectDb = byId.get(check.objectDumpId);
      const probe = probeById.get(check.subjectDumpId);
      const password = passwords.get(check.subjectDumpId);
      if (
        objectDb === undefined ||
        probe === undefined ||
        password === undefined
      ) {
        throw new RecoveryDrillError(
          "INVALID_PROBE_METADATA",
          "isolation check references unknown dump id",
        );
      }
      for (const surface of surfaces) {
        const env = tenantConnectionEnv(
          surface.endpoint,
          objectDb,
          probe.role,
          password,
        );
        if (check.kind === "own-connect") {
          const out = run(
            "psql",
            [
              "--tuples-only",
              "--no-align",
              "--set",
              "ON_ERROR_STOP=1",
              "--command",
              "SELECT current_user || '|' || current_database() || '|' || current_setting('eliza.restore_target_id', true)",
            ],
            { env },
          ).trim();
          const expected = `${probe.role}|${objectDb}|${options.targetId}`;
          if (out !== expected) {
            throw new RecoveryDrillError(
              "ISOLATION_VIOLATION",
              `tenant authentication did not reach the expected target (surface=${surface.name}, subject=${check.subjectDumpId})`,
            );
          }
        } else {
          expectCommandFailure(
            "psql",
            [
              "--tuples-only",
              "--no-align",
              "--set",
              "ON_ERROR_STOP=1",
              "--command",
              "SELECT 1",
            ],
            env,
          );
        }
        passed += 1;
      }
    }

    const objectives = evaluateObjectives(
      sidecar.createdAt,
      startedAt,
      restoreSeconds,
      {
        rpoHours: options.rpoHours,
        rtoMinutes: options.rtoMinutes,
      },
    );

    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      startedAt: startedAt.toISOString(),
      target: redactDsn(options.targetDsn),
      archiveSha256: sidecar.archiveSha256,
      archiveBytes: sidecar.archiveBytes,
      databaseCount: sidecar.databaseCount,
      checksummedFiles,
      isolation: { total: checks.length * surfaces.length, passed },
      objectives: {
        ...objectives,
        rpoHours: options.rpoHours,
        rtoMinutes: options.rtoMinutes,
      },
    };
  } finally {
    // Decrypted tenant data must not outlive the drill.
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const options = parseCliArgs(process.argv.slice(2));
  const report = executeDrill(options);
  const serialized = JSON.stringify(report, null, 2);
  if (options.output !== undefined) {
    writeFileSync(options.output, `${serialized}\n`);
  }
  process.stdout.write(`${serialized}\n`);
  if (!report.objectives.met) {
    process.exitCode = 2;
  }
}
