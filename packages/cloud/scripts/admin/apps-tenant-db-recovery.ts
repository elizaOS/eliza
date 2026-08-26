/**
 * Restore-drill harness for the apps tenant Postgres off-host backups
 * (#21729, authority redesign #23453). Consumes one dated backup set
 * produced by the node's tenant-db-backup timer (encrypted archive +
 * plaintext sidecar), verifies archive integrity and freshness, decrypts and
 * checksums the contents, and plans/executes a restore into an ISOLATED
 * verification target — never the production node. Emits a redacted JSON
 * drill report with measured RPO (backup age) and RTO (restore duration)
 * against the declared objectives.
 *
 * Authority model (#23453): destructive work is authorized by a signed,
 * expiring capability (see restore-capability.ts) that pins exactly one
 * archive sha256 to exactly one disposable target id. Before any destructive
 * SQL the drill verifies the capability signature, the archive hash pin, and
 * a server-side twin setting pair; every destructive session re-checks both
 * settings through the psql guard; exclusivity is claimed transactionally
 * (advisory lock + claim record) so two different capabilities cannot drive
 * the same target; and both settings are consumed (ALTER SYSTEM RESET +
 * reload + verified unset) only after the drill completes, so a completed
 * drill's nonce is dead while a crashed drill's target remains recoverable
 * within the capability TTL.
 *
 * RPO is derived from the manifest inside the encrypted, checksummed
 * archive; the plaintext sidecar's timestamp is only a cross-check and a
 * tampered or stale sidecar fails closed rather than understating data loss.
 * The isolation proof is linear: each tenant authenticates to its own
 * database through both direct Postgres and the isolated pgbouncer, an
 * admin-side ACL assertion proves PUBLIC is denied and the owner granted on
 * every restored database, and one pairwise cross-reject sample is retained
 * as a cross-check. DSNs, credentials, and tenant names never reach reports
 * or logs (reports reference truncated dump ids only).
 *
 * Usage (operator drill, needs openssl + tar + psql client tools):
 *   ELIZA_RESTORE_CAPABILITY_KEY=... \
 *   bun packages/cloud/scripts/admin/apps-tenant-db-recovery.ts \
 *     --set-dir /path/to/downloaded/<stamp> \
 *     --target-dsn postgresql://postgres:***@127.0.0.1:5433/postgres \
 *     --target-id drill-11111111-2222-4333-8444-555555555555 \
 *     --capability-file /path/to/capability.txt \
 *     --pooler-endpoint 127.0.0.1:6432 \
 *     --tenant-probes-file /path/to/tenant-probes.json \
 *     --passphrase-file /path/to/passphrase \
 *     --rpo-hours 26 --rto-minutes 60 --output /tmp/drill-report.json
 *
 * Minting a capability (after downloading the set and hashing the archive):
 *   ELIZA_RESTORE_CAPABILITY_KEY=... \
 *   bun packages/cloud/scripts/admin/apps-tenant-db-recovery.ts mint \
 *     --target-id drill-... --archive-sha256 <sha256> --ttl-minutes 120
 *
 * Target provisioning (operator, on the DISPOSABLE target only): the
 * `provision` subcommand verifies a minted capability file and installs both
 * twin settings. PostgreSQL 14 rejects ALTER SYSTEM SET for undeclared
 * custom GUCs, so provisioning writes postgresql.auto.conf directly (the
 * exact file ALTER SYSTEM SET itself writes), reloads, and verifies through
 * a fresh session:
 *   ELIZA_RESTORE_CAPABILITY_KEY=... \
 *   bun packages/cloud/scripts/admin/apps-tenant-db-recovery.ts provision \
 *     --target-dsn postgresql://postgres:***@127.0.0.1:5433/postgres \
 *     --target-id drill-... --capability-file /path/to/capability.txt
 */

import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  assertRecoveryPointConsistency,
  mintRestoreCapability,
  parseRestoreCapability,
  type RestoreCapability,
  serializeRestoreCapability,
  verifyRestoreCapability,
} from "./restore-capability";

const SHA256 = /^[a-f0-9]{64}$/;
const DUMP_ID = /^[a-f0-9]{12}$/;
export const REPORT_SCHEMA_VERSION = 2 as const;

const RESTORE_TARGET_ID =
  /^drill-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASSWORD_ENV = /^[A-Z][A-Z0-9_]*$/;
export const POOLER_PORT = 6432;
/** Server-side twin settings: the disposable target id and its capability. */
const SETTING_TARGET_ID = "eliza.restore_target_id";
const SETTING_CAPABILITY = "eliza.restore_capability";
/** Advisory key held as a SESSION lock by the drill process for the whole run. */
export const DRILL_ADVISORY_LOCK_KEY = 0x4552_5a44;
/**
 * Distinct advisory key for the transactional claim record. It MUST differ
 * from DRILL_ADVISORY_LOCK_KEY: the session lock is held by a dedicated
 * connection while the claim runs in another session, and two sessions
 * requesting the same advisory key would deadlock (session lock held by the
 * holder blocks the claim's xact lock until the 24h hold expires).
 */
export const DRILL_CLAIM_LOCK_KEY = 0x4552_5a45;
const SIGNING_KEY_ENV = "ELIZA_RESTORE_CAPABILITY_KEY";

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

export interface RestoreTargetAuthority {
  targetId: string;
  /** Server-side twin of the serialized capability envelope; '' when unset. */
  capability: string;
  existingRoles: string[];
}

/** Parse the target identity and role inventory returned by one server session. */
export function parseRestoreTargetAuthority(
  json: string,
): RestoreTargetAuthority {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    // error-policy:J3 untrusted server output becomes an explicit invalid target.
    throw new RecoveryDrillError(
      "REFUSED_TARGET_AUTHORITY",
      "target authority response is not valid JSON",
    );
  }
  if (typeof raw !== "object" || raw === null) {
    throw new RecoveryDrillError(
      "REFUSED_TARGET_AUTHORITY",
      "target authority response is not an object",
    );
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record.target_id !== "string" ||
    typeof record.capability !== "string" ||
    !Array.isArray(record.existing_roles) ||
    record.existing_roles.some((role) => typeof role !== "string")
  ) {
    throw new RecoveryDrillError(
      "REFUSED_TARGET_AUTHORITY",
      "target authority response has invalid fields",
    );
  }
  return {
    targetId: record.target_id,
    capability: record.capability,
    existingRoles: record.existing_roles as string[],
  };
}

/** Extract the exact role names emitted by pg_dumpall's CREATE ROLE records. */
export function parseGlobalRoleNames(globalsSql: string): string[] {
  const roles: string[] = [];
  for (const line of globalsSql.split("\n")) {
    if (!line.startsWith("CREATE ROLE ")) continue;
    const match =
      /^CREATE ROLE (?:(?:"((?:[^"]|"")*)")|([a-z_][a-z0-9_$]*));$/.exec(line);
    if (!match) {
      throw new RecoveryDrillError(
        "INVALID_METADATA",
        "globals.sql contains an unsupported CREATE ROLE record",
      );
    }
    roles.push(
      match[1] === undefined ? match[2] : match[1].replaceAll('""', '"'),
    );
  }
  return roles;
}

/**
 * Refuse a nonempty target whose existing roles collide with the archive —
 * EXCEPT roles the archive itself defines when the target is provisioned for
 * this same capability: those are remnants of a failed prior run of this
 * exact drill (the twin settings match the capability), and the retry is
 * idempotent via makeGlobalsIdempotent. Foreign roles always refuse.
 */
export function assertNoGlobalRoleCollisions(
  globalsSql: string,
  existingRoles: string[],
  archiveRoles: readonly string[] = [],
): void {
  const existing = new Set(existingRoles);
  const ownedByArchive = new Set(archiveRoles);
  const colliding = parseGlobalRoleNames(globalsSql).filter(
    (role) => existing.has(role) && !ownedByArchive.has(role),
  );
  if (colliding.length > 0) {
    throw new RecoveryDrillError(
      "REFUSED_NONEMPTY_TARGET",
      "restore target already contains a role not owned by this archive's globals.sql",
    );
  }
}

const CREATE_ROLE_RE = /(^|\n)CREATE ROLE ([a-z_][a-z0-9_$]*);\n?/g;

/**
 * Make globals.sql re-runnable against the same disposable target (#23453
 * review): a failed first run may already have created some roles, and a bare
 * CREATE ROLE would abort the idempotent retry. Each CREATE ROLE becomes a
 * conditional DO block (no-op when the role exists); ALTER ROLE statements
 * are already idempotent. Only simple `CREATE ROLE name;` forms produced by
 * pg_dump's globals output are rewritten — anything else fails the strict
 * parse in parseGlobalRoleNames first.
 */
export function makeGlobalsIdempotent(globalsSql: string): string {
  return globalsSql.replace(
    CREATE_ROLE_RE,
    (_match, lead: string, role: string) => {
      return `${lead}${[
        "DO $$",
        "BEGIN",
        `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteSqlLiteral(role)}) THEN`,
        `    CREATE ROLE ${role};`,
        "  END IF;",
        "END",
        "$$;\n",
      ].join("\n")}`;
    },
  );
}

/**
 * Every artifact the drill consumes must be checksummed. The manifest is the
 * authenticated RPO source and globals.sql/dbmap/dumps are executed against
 * the target, so an archive whose checksums omit any of them would run
 * unverified bytes (#23453). Dump ids come from the (checksummed) dbmap.
 */
export function assertChecksumCoverage(
  entries: ChecksumEntry[],
  dumpIds: string[],
): void {
  const listed = new Set(entries.map((entry) => entry.file));
  const required = [
    "manifest.json",
    "globals.sql",
    "dbmap.tsv",
    ...dumpIds.map((dumpId) => `dumps/${dumpId}.dump`),
  ];
  const missing = required.filter((file) => !listed.has(file));
  if (missing.length > 0) {
    throw new RecoveryDrillError(
      "INVALID_METADATA",
      `checksums.sha256 does not cover required archive artifacts: ${missing.join(", ")}`,
    );
  }
}

/**
 * Probe roles must come from the archive's authenticated role inventory, not
 * from the operator-local (unauthenticated) probes file: globals.sql is
 * checksummed inside the encrypted archive, so its CREATE ROLE set is the
 * only trustworthy owner list (#23453).
 */
export function assertProbesCoverArchiveRoles(
  probes: TenantProbe[],
  archiveRoles: string[],
): void {
  const authenticated = new Set(archiveRoles);
  const unauthenticated = probes
    .filter((probe) => !authenticated.has(probe.role))
    .map((probe) => probe.dumpId);
  if (unauthenticated.length > 0) {
    throw new RecoveryDrillError(
      "INVALID_PROBE_METADATA",
      `tenant probe names a role absent from the archive's globals.sql (dump=${unauthenticated.join(",")})`,
    );
  }
}

const TARGET_GUARD_SQL = `\\set ON_ERROR_STOP on
SELECT (COALESCE(current_setting('${SETTING_TARGET_ID}', true), '') = :'expected_target_id' AND COALESCE(current_setting('${SETTING_CAPABILITY}', true), '') = :'expected_capability') AS eliza_restore_target_ok \\gset
\\if :eliza_restore_target_ok
\\else
\\echo 'restore target authority mismatch'
DO $$ BEGIN RAISE EXCEPTION 'restore target authority mismatch'; END $$;
\\endif
`;

const CONSUME_AUTHORITY_SQL = `ALTER SYSTEM RESET ${SETTING_TARGET_ID};
ALTER SYSTEM RESET ${SETTING_CAPABILITY};
SELECT pg_reload_conf();
`;

/**
 * Server-side expiry enforcement embedded in every guarded psql session
 * (#23453 review r4): the locally verified capability's expiry — signed
 * bytes the HMAC covers — is passed as an epoch-millisecond cutoff, and the
 * session ABORTS unless the SERVER clock is still inside the capability
 * window. The local assertCapabilityLive() checks are advisory; only this
 * check closes the expiry TOCTOU between the local check and the SQL
 * executing on the server. An arbitrary skew between the drill host and the
 * server can only shrink or (bounded by the signed TTL) widen the window.
 */
function expiryGuardSql(expiresAtEpochMs: number): string {
  if (!Number.isSafeInteger(expiresAtEpochMs) || expiresAtEpochMs <= 0) {
    throw new RecoveryDrillError(
      "INVALID_CAPABILITY",
      "capability expiry is not a safe positive epoch-millisecond value",
    );
  }
  return `SELECT (extract(epoch FROM clock_timestamp()) * 1000) <= ${expiresAtEpochMs} AS eliza_capability_live \\gset
\\if :eliza_capability_live
\\else
\\echo 'restore capability has expired on the server clock'
DO $$ BEGIN RAISE EXCEPTION 'restore capability has expired on the server clock'; END $$;
\\endif
`;
}

/**
 * Guard one psql session before its first destructive statement. Both twin
 * settings — the disposable target id and the serialized capability — must
 * still be present and exactly equal (supplied via psql --set variables at
 * invocation), and the server clock must still be inside the capability
 * window, so every destructive session of the drill is individually
 * authority-checked with no local-check/SQL-execution TOCTOU. The expiry is
 * a REQUIRED parameter (#23453 review r8): the server-clock check is a
 * property of this function's type signature, not of its call sites, so a
 * destructive session cannot be constructed without it and each guarded
 * script carries the expiry guard exactly once (guardedPsqlFile executes
 * scripts as written and never re-wraps).
 */
export function guardPsqlScript(sql: string, expiresAtEpochMs: number): string {
  return `${TARGET_GUARD_SQL}${expiryGuardSql(expiresAtEpochMs)}${sql}`;
}

/**
 * Guarded script that spends the target authority at the END of the drill:
 * it re-checks both twin settings through the same guard used for every
 * destructive statement, then clears both and reloads. After this runs,
 * `current_setting` returns unset for both and the very next authority read
 * fails closed, so a completed drill cannot be replayed. A failed drill does
 * NOT consume the settings — the disposable target stays recoverable for an
 * idempotent re-run inside the capability TTL.
 */
export function guardedConsumeAuthoritySql(expiresAtEpochMs: number): string {
  return guardPsqlScript(CONSUME_AUTHORITY_SQL, expiresAtEpochMs);
}

/**
 * Transactional exclusivity claim, taken before the first destructive
 * statement: under the drill advisory lock, a one-row claim record refuses a
 * DIFFERENT capability against the same target while remaining idempotent
 * for the same capability (crash recovery re-runs).
 */
export function buildClaimExclusivitySql(
  capability: RestoreCapability,
): string {
  const claimId = createHash("sha256")
    .update(serializeRestoreCapability(capability))
    .digest("hex");
  return guardPsqlScript(
    `BEGIN;
SELECT pg_advisory_xact_lock(${DRILL_CLAIM_LOCK_KEY});
CREATE TABLE IF NOT EXISTS public.eliza_restore_drill_claim (
  capability_sha256 text PRIMARY KEY,
  claimed_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.eliza_restore_drill_claim WHERE capability_sha256 <> '${claimId}') THEN
    RAISE EXCEPTION 'a different restore capability already claims this target';
  END IF;
END $$;
DELETE FROM public.eliza_restore_drill_claim WHERE capability_sha256 = '${claimId}';
INSERT INTO public.eliza_restore_drill_claim (capability_sha256) VALUES ('${claimId}');
COMMIT;
`,
    capability.expiresAtEpochMs,
  );
}

/** Quote an archive-provided PostgreSQL identifier for generated drill SQL. */
export function quoteSqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Point a guarded restore session at one database on the same target. */
export function targetDatabaseDsn(targetDsn: string, database: string): string {
  const url = new URL(targetDsn);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
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
  // One-to-one tenant↔role mapping (#23453 review r2): two restored tenant
  // databases sharing one probe role would collapse their credentials — each
  // own-connect would pass while one role could reach both databases. Every
  // role must be claimed by exactly one tenant.
  const rolesTaken = new Set<string>();
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
    if (rolesTaken.has(role)) {
      throw new RecoveryDrillError(
        "INVALID_PROBE_METADATA",
        `probe role '${role.slice(0, 64)}' is used by more than one tenant; the tenant-to-role mapping must be one-to-one`,
      );
    }
    rolesTaken.add(role);
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
 * Linear isolation plan (#23453): one own-connect per tenant on the direct
 * surface, plus ONE pairwise cross-reject sample (the first two tenants)
 * through both surfaces, retained as a cross-check of the ACL assertion.
 * Cross-tenant denial for the remaining pairs is proven by the admin-side
 * ACL assertion instead of O(n^2) probe pairs.
 */
export interface IsolationCheck {
  kind: "own-connect" | "cross-reject";
  subjectDumpId: string;
  objectDumpId: string;
}

export function buildIsolationChecks(entries: DbMapEntry[]): IsolationCheck[] {
  const checks: IsolationCheck[] = entries.map((entry) => ({
    kind: "own-connect" as const,
    subjectDumpId: entry.dumpId,
    objectDumpId: entry.dumpId,
  }));
  if (entries.length >= 2) {
    checks.push({
      kind: "cross-reject",
      subjectDumpId: entries[0].dumpId,
      objectDumpId: entries[1].dumpId,
    });
  }
  return checks;
}

export interface CliOptions {
  setDir: string;
  targetDsn: string;
  targetId: string;
  capabilityFile: string;
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
      "capability-file": { type: "string" },
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
  const capabilityFile = values["capability-file"];
  const poolerEndpoint = values["pooler-endpoint"];
  const tenantProbesFile = values["tenant-probes-file"];
  const passphraseFile = values["passphrase-file"];
  if (
    !setDir ||
    !targetDsn ||
    !targetId ||
    !capabilityFile ||
    !poolerEndpoint ||
    !tenantProbesFile ||
    !passphraseFile
  ) {
    throw new RecoveryDrillError(
      "INVALID_ARGS",
      "required: --set-dir, --target-dsn, --target-id, --capability-file, --pooler-endpoint, --tenant-probes-file, and --passphrase-file",
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
    capabilityFile,
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
  opts: {
    env?: Record<string, string>;
    input?: string;
    /** Treat a relation-does-not-exist failure as empty output instead of an error. */
    allowMissingTable?: boolean;
  } = {},
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
    // error-policy:J3 a missing relation is an explicit benign-absence case
    // for the caller that opted in; every other failure stays an error.
    if (
      opts.allowMissingTable === true &&
      /relation ".+" does not exist/.test(result.stderr)
    ) {
      return "0";
    }
    throw new RecoveryDrillError(
      "TOOL_FAILED",
      `${command} exited ${result.status}: ${result.stderr.slice(-400)}`,
    );
  }
  return result.stdout;
}

/**
 * True when `stderr` carries a recognized cross-tenant connection denial.
 * Two shapes are both correct, depending on which layer sees the probe
 * first: direct Postgres always answers with its own REVOKE-CONNECT denial
 * ("permission denied for database"); through pgbouncer, a database absent
 * from the pooler's own config is refused by pgbouncer itself before the
 * request ever reaches Postgres ("no such database"). Accepting only the
 * first shape makes a correctly-configured pgbouncer probe surface as
 * TOOL_FAILED instead of a clean pass — both shapes prove the probed
 * database was never reachable, so both count as the isolation guarantee
 * holding.
 */
export function isCrossTenantDenial(stderr: string): boolean {
  return /permission denied for database|no such database/i.test(stderr);
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
  if (!isCrossTenantDenial(result.stderr)) {
    throw new RecoveryDrillError(
      "TOOL_FAILED",
      "cross-tenant probe failed without a recognized cross-tenant denial (expected a Postgres CONNECT-privilege denial or a pgbouncer unlisted-database denial)",
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
  isolation: { total: number; passed: number; plan: string };
  /** Where the RPO input came from — always the authenticated manifest. */
  rpoSource: "manifest";
  objectives: ObjectiveEvaluation & RecoveryObjectives;
}

function readSigningKey(): string {
  const key = process.env[SIGNING_KEY_ENV];
  if (key === undefined || key === "") {
    throw new RecoveryDrillError(
      "MISSING_SIGNING_KEY",
      `${SIGNING_KEY_ENV} must be set to the restore-capability signing key`,
    );
  }
  return key;
}

/**
 * Read the server-side target authority for one guarded session: both twin
 * settings plus the role inventory.
 */
function readRestoreTargetAuthority(targetDsn: string): RestoreTargetAuthority {
  return parseRestoreTargetAuthority(
    run("psql", [
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--set",
      "ON_ERROR_STOP=1",
      "--dbname",
      targetDsn,
      "--command",
      `SELECT json_build_object('target_id', COALESCE(current_setting('${SETTING_TARGET_ID}', true), ''), 'capability', COALESCE(current_setting('${SETTING_CAPABILITY}', true), ''), 'existing_roles', (SELECT json_agg(rolname ORDER BY rolname) FROM pg_roles))::text`,
    ]).trim(),
  );
}

/**
 * Verify the full authority chain before any destructive work: the
 * capability file's signature, its expiry, the server-returned target id,
 * and byte-for-byte equality between the client capability and the
 * server-side twin. Exported so the reuse/refusal behavior is directly
 * testable against a scripted psql double (see the nonce suite).
 */
export function verifyRestoreAuthority(
  targetDsn: string,
  targetId: string,
  capability: RestoreCapability,
  signingKey: string,
  nowEpochMs: number,
): RestoreTargetAuthority {
  const authority = readRestoreTargetAuthority(targetDsn);
  assertRestoreTargetIdentity(targetId, authority.targetId);
  const twin = authority.capability;
  if (twin === "" || twin !== serializeRestoreCapability(capability)) {
    throw new RecoveryDrillError(
      "REFUSED_TARGET_AUTHORITY",
      "target did not return the matching restore capability twin",
    );
  }
  verifyRestoreCapability(capability, signingKey, nowEpochMs);
  return authority;
}

/**
 * Spend the target authority at the end of a completed drill: guarded on
 * both twin settings, reset both, reload, then re-read and require both to
 * be unset. The re-read is part of the same exported sequence so a half-run
 * consumption cannot masquerade as success.
 */
export function consumeRestoreAuthority(
  targetDsn: string,
  targetId: string,
  capability: RestoreCapability,
  work: string,
): void {
  const script = join(work, "consume-authority.sql");
  writeFileSync(
    script,
    guardedConsumeAuthoritySql(capability.expiresAtEpochMs),
  );
  run("psql", [
    "--no-psqlrc",
    "--set",
    `expected_target_id=${targetId}`,
    "--set",
    `expected_capability=${serializeRestoreCapability(capability)}`,
    "--dbname",
    targetDsn,
    "--file",
    script,
  ]);
  const after = readRestoreTargetAuthority(targetDsn);
  if (after.targetId !== "" || after.capability !== "") {
    throw new RecoveryDrillError(
      "REFUSED_TARGET_AUTHORITY",
      "target authority was not fully consumed (settings still present after reset)",
    );
  }
}

/** Admin-side linear isolation assertion for one restored database. */
function assertTenantAcl(
  targetDsn: string,
  database: string,
  ownerRole: string,
  allTenantRoles: readonly string[],
): void {
  // OID 0 is the canonical way to probe PUBLIC's privilege (role "PUBLIC"
  // does not exist as a pg_roles row). The assertion is stronger than
  // PUBLIC-denied/owner-granted (#23453 review): the owner must also BE the
  // recorded datdba, the ACL must carry no grant to any other tenant role
  // (which membership-based privilege cannot bypass, because
  // has_database_privilege for a non-grantee still returns false when the
  // ACL has no entry for that role), and every OTHER tenant role is probed
  // for CONNECT and must be refused. Variables are supplied on stdin:
  // psql -c does not interpolate :'var', but stdin scripts do.
  const rolesList = allTenantRoles
    .filter((role) => role !== ownerRole)
    .map((role) => quoteSqlLiteral(role))
    .join(", ");
  const rolesArray = `ARRAY[${rolesList}]::name[]`;
  const sql = [
    "SELECT json_build_object(",
    "  'datdba_is_owner', (SELECT datdba = (SELECT oid FROM pg_roles WHERE rolname = :'owner') FROM pg_database WHERE datname = :'db'),",
    "  'public_connect', has_database_privilege(0, :'db', 'CONNECT'),",
    "  'owner_connect', has_database_privilege(:'owner', :'db', 'CONNECT'),",
    "  'foreign_grantees', (SELECT count(*) FROM aclexplode((SELECT datacl FROM pg_database WHERE datname = :'db')) acl WHERE acl.grantee <> 0 AND acl.grantee <> (SELECT oid FROM pg_roles WHERE rolname = :'owner'))::int",
    ")::text",
    rolesList
      ? `UNION ALL SELECT json_build_object('other_role', r.rn, 'connect_refused', NOT has_database_privilege(r.rn, :'db', 'CONNECT'))::text FROM (SELECT unnest(${rolesArray}) AS rn) r`
      : "",
    "ORDER BY 1",
  ]
    .filter((line) => line !== "")
    .join("\n");
  const out = run(
    "psql",
    [
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--set",
      "ON_ERROR_STOP=1",
      "--set",
      `db=${database}`,
      "--set",
      `owner=${ownerRole}`,
      "--dbname",
      targetDsn,
    ],
    { input: sql },
  ).trim();
  if (out.length === 0) {
    throw new RecoveryDrillError(
      "ISOLATION_VIOLATION",
      "target ACL assertion returned no rows",
    );
  }
  for (const line of out.split("\n")) {
    let parsed: Record<string, unknown>;
    try {
      // error-policy:J3 untrusted DB output becomes an explicit violation, never a defaulted pass.
      parsed = JSON.parse(line.trim()) as Record<string, unknown>;
    } catch {
      // error-policy:J3 untrusted DB output becomes an explicit violation, never a defaulted pass.
      throw new RecoveryDrillError(
        "ISOLATION_VIOLATION",
        "target ACL assertion response was not valid JSON",
      );
    }
    if ("datdba_is_owner" in parsed) {
      if (
        parsed.datdba_is_owner !== true ||
        parsed.public_connect !== false ||
        parsed.owner_connect !== true ||
        parsed.foreign_grantees !== 0
      ) {
        throw new RecoveryDrillError(
          "ISOLATION_VIOLATION",
          `restored database ACL is not owner-exclusive (${database}: datdba mismatch, PUBLIC grant, owner denial, or a foreign ACL grantee)`,
        );
      }
    } else if ("connect_refused" in parsed) {
      if (parsed.connect_refused !== true) {
        throw new RecoveryDrillError(
          "ISOLATION_VIOLATION",
          `another tenant role can CONNECT to a restored database (${database})`,
        );
      }
    } else {
      throw new RecoveryDrillError(
        "ISOLATION_VIOLATION",
        "target ACL assertion returned an unrecognized row shape",
      );
    }
  }
}

/**
 * Durable same-capability retry marker: true when the target's claim table
 * holds a row for exactly this capability's serialized bytes. Role remnants
 * are exempted from the clean-target collision check ONLY when this returns
 * true — a fresh target carrying archive-named roles still refuses.
 */
export function targetHasDrillClaim(
  targetDsn: string,
  capabilityEnvelope: string,
): boolean {
  const claimId = createHash("sha256").update(capabilityEnvelope).digest("hex");
  // A missing claim table (fresh target) is not an error: it simply means no
  // capability ever claimed this target. Every other failure still throws.
  const out = run(
    "psql",
    [
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--dbname",
      targetDsn,
      "--command",
      `SELECT count(*) FROM public.eliza_restore_drill_claim WHERE capability_sha256 = '${claimId}'`,
    ],
    { allowMissingTable: true },
  ).trim();
  return Number(out) > 0;
}

/** Quote a value as a SQL string literal for generated drill SQL. */
export function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Session-held drill exclusivity (#23453 review): opens a dedicated psql
 * session that takes the session-level advisory lock with pg_try_advisory_lock
 * and then holds it via a bounded pg_sleep, staying alive for the whole drill.
 * A second drill against the same target fails its try-lock, its psql exits
 * nonzero, and this function surfaces LOCK_FAILED — so destructive statements
 * and authority consumption can never interleave. Implemented over a
 * long-lived psql process (not a node pg Client) to keep the script sync and
 * dependency-free; killing the process releases the lock (session-scoped).
 */
export const DRILL_LOCK_SETTLE_MS = 1500;
/** How long the lock-holder may sleep: bounded so a crashed drill (killed
 * holder) cannot pin the lock longer than the capability TTL ceiling. */
export const DRILL_LOCK_MAX_SECONDS = 24 * 60 * 60;
/** Handshake row the holder writes on successful lock acquisition. */
export const DRILL_LOCK_HANDSHAKE = "drill-lock-held";
/** Refusal sentinel: a granted lock exists elsewhere, so this holder exits. */
export const DRILL_LOCK_REFUSED = "drill-lock-refused";

export interface DrillLock {
  child: ChildProcess;
  handshakePath: string;
  targetDsn: string;
  /** Advisory-lock key this holder session owns (drill or provision). */
  lockKey: number;
  backendPid?: number;
}

/**
 * Acquire the whole-run session lock with a PROVEN handshake: the holder
 * writes a sentinel row to stdout only after pg_try_advisory_lock succeeds,
 * stdout is redirected to a file (no event-loop dependency), and acquisition
 * is only reported after the sentinel bytes are observed AND the holder
 * process is confirmed alive. A refused lock emits a distinct refusal
 * sentinel and exits (its pg_sleep result never runs), so refusal is
 * observable on disk and never mistaken for acquisition.
 * The sentinel and the hold-sleep MUST be separate --command args: psql
 * pipelines each -c as its own PQexec, so the sentinel row streams to
 * stdout (and onto disk) only after its statement completes, before the
 * 24h sleep starts. A single -c would buffer both statements' results
 * until the sleep finished. And the refusal branch must be a string, not
 * 1/0: Postgres constant-folds an untaken ELSE 1/0 at plan time (the
 * CASE result type becomes integer, erroring before pg_try_advisory_lock
 * even runs), which would deadlock the drill on every attempt.
 */
export function acquireDrillLock(
  targetDsn: string,
  handshakePath: string,
): DrillLock {
  return acquireSessionAdvisoryLock(
    targetDsn,
    handshakePath,
    DRILL_ADVISORY_LOCK_KEY,
  );
}

/**
 * Acquire a session-held advisory lock under an arbitrary key with the same
 * proven file handshake as the drill lock. Used by the drill itself and by
 * the postgresql.auto.conf provisioner, whose exclusivity must not depend
 * on pathname-rename races a crashed holder cannot clean up (#23453
 * review r6: POSIX rename is not conditional on a previously observed
 * inode, so a stale-takeover or a late release can destroy a successor's
 * fresh claim; a held server session cannot be stolen by another process).
 */
export function acquireSessionAdvisoryLock(
  targetDsn: string,
  handshakePath: string,
  lockKey: number,
): DrillLock {
  // stdout of the holder is redirected to the handshake file: the sentinel
  // row lands on disk the moment the lock is granted, independent of the
  // node event loop.
  const outFd = openSync(handshakePath, "w");
  const child = spawn(
    "psql",
    [
      "--no-psqlrc",
      "--quiet",
      "--tuples-only",
      "--no-align",
      "--set",
      "ON_ERROR_STOP=1",
      "--dbname",
      targetDsn,
      "--command",
      `SELECT CASE WHEN pg_try_advisory_lock(${lockKey}) THEN '${DRILL_LOCK_HANDSHAKE}:' || pg_backend_pid() ELSE '${DRILL_LOCK_REFUSED}' END;`,
      // A refused lock must NOT fall through to the hold-sleep: the refusal
      // sentinel is not a SQL error, so ON_ERROR_STOP does not stop psql and
      // the second --command WOULD execute — leaking a 24h pg_sleep backend
      // with no lock to its name (#23453 review r4). A CASE cannot mix
      // pg_sleep (void) with 1/0 (integer) — PG rejects "CASE types integer
      // and void cannot be matched" and the holder would die even on
      // SUCCESS, releasing the lock while the drill still relied on it
      // (#23453 review r5). The DO block type-checks on both paths: it
      // re-proves this session holds the advisory lock (aborting a refused
      // holder before any sleep) and then holds it for the bounded window.
      "--command",
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = ${lockKey} AND objsubid = 1 AND pid = pg_backend_pid()) THEN RAISE EXCEPTION 'drill lock lost before hold'; END IF; PERFORM pg_sleep(${DRILL_LOCK_MAX_SECONDS}); END $$;`,
    ],
    { stdio: ["ignore", outFd, "pipe"] },
  );
  // Proof, not hope: poll the handshake file and the holder PID until the
  // sentinel is on disk and the process still exists. A refused lock, bad
  // DSN, or missing psql all exit before writing the sentinel.
  const deadline = Date.now() + DRILL_LOCK_SETTLE_MS * 4;
  let stderrTail = "";
  child.stderr?.on("data", (chunk: unknown) => {
    stderrTail = `${stderrTail}${String(chunk)}`.slice(-500);
  });
  let acquired = false;
  let backendPid: number | undefined;
  while (Date.now() < deadline) {
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      DRILL_LOCK_SETTLE_MS / 4,
    );
    let observed = "";
    try {
      observed = readFileSync(handshakePath, "utf-8");
    } catch {
      // error-policy:J3 the sentinel file may not exist yet — keep polling.
      observed = "";
    }
    if (observed.includes(DRILL_LOCK_HANDSHAKE)) {
      acquired = true;
      // The sentinel carries the holder's backend pid: pg_terminate_backend
      // releases the session lock deterministically at release time. A
      // client-side SIGKILL alone does NOT reach a backend blocked in
      // pg_sleep — the backend notices the dropped client only at its next
      // socket read/write, so the lock would stay pinned for the whole
      // DRILL_LOCK_MAX_SECONDS sleep and refuse the documented idempotent
      // re-run within the capability TTL.
      const pidMatch = observed.match(
        new RegExp(`${DRILL_LOCK_HANDSHAKE}:(\\d+)`),
      );
      backendPid = pidMatch?.[1] ? Number(pidMatch[1]) : undefined;
      break;
    }
    if (observed.includes(DRILL_LOCK_REFUSED)) {
      // Another session holds the advisory lock. The holder will exit on its
      // own (ON_ERROR_STOP stops after the refusal row); no sentinel race.
      child.kill("SIGKILL");
      throw new RecoveryDrillError(
        "LOCK_FAILED",
        "drill lock is held by another session (refusal sentinel observed)",
      );
    }
    // Holder died before writing the sentinel: the lock was NOT taken.
    try {
      if (child.pid !== undefined) process.kill(child.pid, 0);
    } catch {
      // error-policy:J3 signal-zero probe failure proves the holder is gone.
      child.kill("SIGKILL");
      throw new RecoveryDrillError(
        "LOCK_FAILED",
        `drill lock holder exited before confirming acquisition: ${stderrTail.trim().slice(0, 200)}`,
      );
    }
  }
  if (!acquired) {
    child.kill("SIGKILL");
    throw new RecoveryDrillError(
      "LOCK_FAILED",
      `drill lock acquisition was not confirmed within the settle window: ${stderrTail.trim().slice(0, 200)}`,
    );
  }
  return { child, handshakePath, targetDsn, lockKey, backendPid };
}

/**
 * Fail the drill if the lock holder has died mid-run: a released session
 * lock means exclusivity no longer holds and destructive work must stop.
 */
export function assertDrillLockHeld(lock: DrillLock): void {
  let observed = "";
  try {
    observed = readFileSync(lock.handshakePath, "utf-8");
  } catch {
    // error-policy:J3 a vanished sentinel means the holder is gone.
    observed = "";
  }
  let alive = false;
  try {
    if (lock.child.pid !== undefined) process.kill(lock.child.pid, 0);
    alive = true;
  } catch {
    // error-policy:J3 signal-zero probe failure means the holder is gone.
    alive = false;
  }
  if (!alive || !observed.includes(DRILL_LOCK_HANDSHAKE)) {
    throw new RecoveryDrillError(
      "LOCK_FAILED",
      "drill lock holder exited mid-run; exclusivity no longer holds",
    );
  }
}

export function releaseDrillLock(lock: DrillLock): void {
  // Server-side release: terminate the holder's backend so the session lock
  // drops immediately. SIGKILL on the client alone does not interrupt a
  // backend blocked in pg_sleep — it only notices the closed socket at its
  // next read/write, so the lock would stay held for the full
  // DRILL_LOCK_MAX_SECONDS sleep and refuse every idempotent re-run within
  // the capability TTL (proven by the claim-order regression test: a failed
  // first invocation must leave the target retryable, not lock-pinned).
  // Termination is gated on pg_locks proving the pid STILL holds this drill's
  // exact advisory lock (#23453 review r4): a recycled OS pid would otherwise
  // point at an unrelated backend, and terminating it would be collateral
  // damage. The same query proves termination succeeded (returns true), not
  // merely that psql exited cleanly.
  if (lock.backendPid !== undefined) {
    const terminated = spawnSync(
      "psql",
      [
        "--no-psqlrc",
        "--quiet",
        "--tuples-only",
        "--no-align",
        "--dbname",
        lock.targetDsn,
        "--command",
        `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = ${lock.lockKey} AND objsubid = 1 AND pid = ${lock.backendPid} AND pid <> pg_backend_pid()) THEN pg_terminate_backend(${lock.backendPid}) ELSE false END;`,
      ],
      { encoding: "utf-8" },
    );
    const released =
      terminated.status === 0 && (terminated.stdout ?? "").trim() === "t";
    if (!released) {
      // error-policy:J6 teardown-only: the SIGKILL fallback below still drops
      // the client; a termination miss here never masks the drill outcome.
      process.stderr.write(
        `drill lock backend termination not confirmed: ${(terminated.stderr ?? terminated.stdout ?? "unknown").slice(-200)}\n`,
      );
    }
  }
  // Client-side kill: drops the local process and its socket even when the
  // backend pid could not be parsed from the sentinel.
  lock.child.kill("SIGKILL");
  try {
    // error-policy:J6 best-effort cleanup of the handshake file.
    rmSync(lock.handshakePath, { force: true });
  } catch {
    // error-policy:J6 handshake cleanup must not mask the drill outcome.
  }
}

/**
 * Execute an already-guarded script file against the target with the twin
 * settings supplied as psql --set variables. The script must have been
 * built through guardPsqlScript at construction time (#23453 review r8);
 * this executor never re-wraps, so every guarded script carries the
 * twin-settings and expiry guards exactly once.
 */
function guardedPsqlFile(
  targetDsn: string,
  targetId: string,
  capability: string,
  script: string,
): void {
  run("psql", [
    "--no-psqlrc",
    "--set",
    `expected_target_id=${targetId}`,
    "--set",
    `expected_capability=${capability}`,
    "--dbname",
    targetDsn,
    "--file",
    script,
  ]);
}

/** Execute the full drill. Requires openssl, tar, psql, pg_restore on PATH. */
export function executeDrill(options: CliOptions): DrillReport {
  const signingKey = readSigningKey();
  let capabilityText: string;
  try {
    capabilityText = readFileSync(options.capabilityFile, "utf-8").trim();
  } catch (cause) {
    // error-policy:J3 an unreadable capability file becomes an explicit invalid argument.
    throw new RecoveryDrillError(
      "INVALID_ARGS",
      `--capability-file could not be read: ${(cause as Error).message}`,
    );
  }
  const parsed = parseRestoreCapability(capabilityText);
  // verifyRestoreCapability returns the fields re-derived from the SIGNED
  // bytes; every downstream use goes through this authenticated value, so a
  // divergent mutable field on the parsed object can never reach the drill.
  let capability = verifyRestoreCapability(parsed, signingKey, Date.now());
  if (capability.targetId !== options.targetId) {
    throw new RecoveryDrillError(
      "REFUSED_TARGET_AUTHORITY",
      "capability does not pin the requested target id",
    );
  }
  const targetUrl = assertDirectTarget(options.targetDsn);
  const capabilityEnvelope = serializeRestoreCapability(capability);
  const work = mkdtempSync(join(tmpdir(), "tenant-db-drill-"));
  let consumed = false;
  try {
    const authority = verifyRestoreAuthority(
      options.targetDsn,
      options.targetId,
      capability,
      signingKey,
      Date.now(),
    );
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
    if (actualSha !== capability.archiveSha256) {
      throw new RecoveryDrillError(
        "REFUSED_ARCHIVE_MISMATCH",
        "archive on disk is not the archive pinned by the restore capability",
      );
    }
    // Hash and decrypt must consume the SAME bytes: hash a private copy first
    // and decrypt that copy, so a local actor swapping the set-dir archive
    // between the hash and the openssl open cannot deliver different bytes
    // to the two operations (#23453 review).
    const pinnedArchive = join(work, "pinned-archive.bin");
    copyFileSync(archivePath, pinnedArchive);
    const pinnedSha = createHash("sha256")
      .update(readFileSync(pinnedArchive))
      .digest("hex");
    if (pinnedSha !== actualSha) {
      throw new RecoveryDrillError(
        "REFUSED_ARCHIVE_MISMATCH",
        "archive bytes changed while being pinned for decryption",
      );
    }

    // Session-held exclusivity: a session-level advisory lock held on a
    // dedicated connection for the whole drill, plus the transactional claim,
    // so two drills against the same target cannot interleave destructive
    // statements and consumption (#23453 review). Acquisition is proven by a
    // file handshake before any destructive work starts.
    const drillLock = acquireDrillLock(
      options.targetDsn,
      join(work, "drill-lock-handshake.txt"),
    );
    try {
      // Expiry rechecked at the destructive boundary, immediately after the
      // lock is proven held: a capability that expired during archive
      // verification/hashing must not arm destructive SQL. The returned
      // object is the signed-bytes-derived view, so this re-assignment also
      // drops any field divergence from the originally parsed envelope.
      capability = verifyRestoreCapability(capability, signingKey, Date.now());
      assertDrillLockHeld(drillLock);
      // Expiry is re-proven before every destructive phase boundary, not
      // once up front: a drill that outlives its capability must stop
      // instead of continuing destructive work after expiry (#23453
      // review).
      const assertCapabilityLive = (): void => {
        capability = verifyRestoreCapability(
          capability,
          signingKey,
          Date.now(),
        );
      };
      // Same-capability retry detection is read BEFORE the claim transaction
      // runs (the claim script upserts the row, so asking after it would
      // always answer true), but the claim itself is PERSISTED ONLY AFTER the
      // clean-target collision check below has passed (#23453 review r3): a
      // first invocation that refuses a pre-existing archive-named role must
      // not leave a claim behind that a retry would treat as a legitimate
      // same-capability retry, exempting every archive role from collision
      // checking and proceeding to ALTER ROLE.
      const capabilityEnvelopeLocal = serializeRestoreCapability(capability);
      assertCapabilityLive();
      assertDrillLockHeld(drillLock);
      const isSameCapabilityRetry = targetHasDrillClaim(
        options.targetDsn,
        capabilityEnvelopeLocal,
      );

      run("openssl", [
        "enc",
        "-d",
        "-aes-256-cbc",
        "-pbkdf2",
        "-iter",
        "210000",
        "-in",
        pinnedArchive,
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
      // Authenticated recovery point: the manifest inside the encrypted,
      // checksummed archive is authoritative; a drifted or future-dated
      // sidecar/manifest pair fails closed instead of understating loss.
      assertRecoveryPointConsistency({
        sidecarCreatedAt: sidecar.createdAt,
        manifestCreatedAt: manifest.createdAt,
        nowEpochMs: Date.now(),
      });
      const checksums = parseChecksumFile(
        readFileSync(join(work, "checksums.sha256"), "utf-8"),
      );
      const globalsSql = readFileSync(join(work, "globals.sql"), "utf-8");
      const archiveRoles = parseGlobalRoleNames(globalsSql);
      assertNoGlobalRoleCollisions(
        globalsSql,
        authority.existingRoles,
        isSameCapabilityRetry ? archiveRoles : [],
      );
      // The clean-target collision check has now passed (or the retry
      // exemption is legitimate): persist the claim. Liveness and lock hold
      // are re-proven immediately before this destructive statement — the
      // pre-claim read above is a network round trip that can cross expiry
      // or lock loss (#23453 review r3).
      assertCapabilityLive();
      assertDrillLockHeld(drillLock);
      const claimScript = join(work, "claim-exclusivity.sql");
      writeFileSync(claimScript, buildClaimExclusivitySql(capability));
      guardedPsqlFile(
        options.targetDsn,
        options.targetId,
        capabilityEnvelope,
        claimScript,
      );
      const dbMap = parseDbMap(readFileSync(join(work, "dbmap.tsv"), "utf-8"));
      if (dbMap.length !== manifest.databaseCount) {
        throw new RecoveryDrillError(
          "INVALID_METADATA",
          "dbmap entry count differs from manifest database_count",
        );
      }
      // Checksum coverage is a load-bearing assumption: the manifest is the
      // authenticated RPO source and globals.sql/dbmap/dumps are executed, so
      // every consumed artifact must be listed — an archive whose checksums
      // omit them would run unverified bytes (#23453).
      assertChecksumCoverage(
        checksums,
        dbMap.map((entry) => entry.dumpId),
      );
      const checksummedFiles = verifyChecksums(work, checksums);

      const probes = parseTenantProbes(
        readFileSync(options.tenantProbesFile, "utf-8"),
        dbMap,
      );
      // The probes file is operator-local and unauthenticated; the archive's
      // globals.sql is the authenticated role inventory. A probe naming a role
      // absent from globals.sql would let a tampered probes file decide who
      // owns (and can CONNECT to) every restored database (#23453).
      assertProbesCoverArchiveRoles(probes, archiveRoles);
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
      // Lock liveness is re-proven before each destructive phase: if the
      // session-lock holder dies mid-run, exclusivity no longer holds and the
      // remaining destructive statements must not run (#23453 review).
      assertDrillLockHeld(drillLock);
      assertCapabilityLive();
      const guardedGlobals = join(work, "guarded-globals.sql");
      writeFileSync(
        guardedGlobals,
        guardPsqlScript(
          makeGlobalsIdempotent(globalsSql),
          capability.expiresAtEpochMs,
        ),
      );
      guardedPsqlFile(
        options.targetDsn,
        options.targetId,
        capabilityEnvelope,
        guardedGlobals,
      );
      for (const entry of dbMap) {
        const dumpFile = join(work, "dumps", `${entry.dumpId}.dump`);
        const probe = probeById.get(entry.dumpId);
        if (probe === undefined) {
          throw new RecoveryDrillError(
            "INVALID_PROBE_METADATA",
            "database has no tenant role probe",
          );
        }
        const databaseIdentifier = quoteSqlIdentifier(entry.databaseName);
        const ownerIdentifier = quoteSqlIdentifier(probe.role);
        assertDrillLockHeld(drillLock);
        assertCapabilityLive();
        const guardedDrop = join(work, `${entry.dumpId}.drop.sql`);
        writeFileSync(
          guardedDrop,
          guardPsqlScript(
            [
              `DROP DATABASE IF EXISTS ${databaseIdentifier};`,
              `CREATE DATABASE ${databaseIdentifier} OWNER ${ownerIdentifier};`,
              `REVOKE CONNECT ON DATABASE ${databaseIdentifier} FROM PUBLIC;`,
              `GRANT CONNECT ON DATABASE ${databaseIdentifier} TO ${ownerIdentifier};`,
              "",
            ].join("\n"),
            capability.expiresAtEpochMs,
          ),
        );
        guardedPsqlFile(
          options.targetDsn,
          options.targetId,
          capabilityEnvelope,
          guardedDrop,
        );
        const rawRestore = join(work, `${entry.dumpId}.restore.sql`);
        run("pg_restore", ["--file", rawRestore, dumpFile]);
        // pg_restore can run long enough for the capability to expire or the
        // lock holder to die mid-extraction; re-prove both immediately
        // before the extracted destructive SQL executes (#23453 review r2).
        assertCapabilityLive();
        assertDrillLockHeld(drillLock);
        const guardedRestore = join(
          work,
          `${entry.dumpId}.guarded-restore.sql`,
        );
        writeFileSync(
          guardedRestore,
          guardPsqlScript(
            readFileSync(rawRestore, "utf-8"),
            capability.expiresAtEpochMs,
          ),
        );
        run("psql", [
          "--no-psqlrc",
          "--set",
          `expected_target_id=${options.targetId}`,
          "--set",
          `expected_capability=${capabilityEnvelope}`,
          "--dbname",
          targetDatabaseDsn(options.targetDsn, entry.databaseName),
          "--file",
          guardedRestore,
        ]);
        // Ownership handoff (#23453 review r3): the dumps are restored with
        // --no-owner, so restored objects are owned by the restore
        // administrator — CONNECT alone would not give the tenant access to
        // its own restored data. Hand the database, the public schema, and
        // every restored relation to the tenant role. REASSIGN OWNED BY
        // CURRENT_USER would also touch system-required objects when the
        // restore admin is a superuser, so ownership transfers relation by
        // relation: psql's \gexec runs one generated ALTER per row, %I
        // quotes every identifier, and :'owner' interpolates the role
        // outside any dollar-quoted context.
        const guardedHandoff = join(work, `${entry.dumpId}.handoff.sql`);
        writeFileSync(
          guardedHandoff,
          guardPsqlScript(
            [
              `ALTER DATABASE ${databaseIdentifier} OWNER TO ${ownerIdentifier};`,
              `ALTER SCHEMA public OWNER TO ${ownerIdentifier};`,
              `GRANT ALL ON SCHEMA public TO ${ownerIdentifier};`,
              `SELECT format('ALTER %s %I.%I OWNER TO %I',`,
              `         CASE c.relkind WHEN 'r' THEN 'TABLE' WHEN 'p' THEN 'TABLE'`,
              `              WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'`,
              `              WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE' END,`,
              `         n.nspname, c.relname, :'owner')`,
              `  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace`,
              ` WHERE c.relkind IN ('r','p','v','m','S','f')`,
              `   AND n.nspname NOT IN ('pg_catalog','information_schema')`,
              `   AND pg_get_userbyid(c.relowner) = current_user ` +
                String.fromCharCode(92) +
                `gexec`,
              "",
            ].join("\n"),
            capability.expiresAtEpochMs,
          ),
        );
        // The restore SQL can run long enough for the capability to expire
        // or the lock holder to die mid-restore; re-prove both immediately
        // before the handoff session executes (#23453 review r4).
        assertCapabilityLive();
        assertDrillLockHeld(drillLock);
        run("psql", [
          "--no-psqlrc",
          "--set",
          `expected_target_id=${options.targetId}`,
          "--set",
          `expected_capability=${capabilityEnvelope}`,
          "--dbname",
          targetDatabaseDsn(options.targetDsn, entry.databaseName),
          "--set",
          `owner=${probe.role}`,
          "--file",
          guardedHandoff,
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
          // Own-connect runs through BOTH surfaces for every tenant: through
          // the isolated pooler it doubles as the per-tenant routing
          // assertion — a pooler mapping that pointed tenant A at tenant B's
          // database (or a force_user mistake) fails the identity check even
          // though the credentials are correct (#23453 review).
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
                "--no-psqlrc",
                "--tuples-only",
                "--no-align",
                "--set",
                "ON_ERROR_STOP=1",
                "--command",
                `SELECT current_user || '|' || current_database() || '|' || current_setting('${SETTING_TARGET_ID}', true)`,
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
                "--no-psqlrc",
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
      // Linear admin-side isolation proof: PUBLIC denied, owner granted, for
      // every restored database — replaces the remaining O(n^2) probe pairs.
      for (const entry of dbMap) {
        const probe = probeById.get(entry.dumpId);
        if (probe === undefined) {
          throw new RecoveryDrillError(
            "INVALID_PROBE_METADATA",
            "ACL assertion references unknown dump id",
          );
        }
        assertTenantAcl(
          options.targetDsn,
          entry.databaseName,
          probe.role,
          archiveRoles,
        );
        passed += 1;
      }

      const objectives = evaluateObjectives(
        manifest.createdAt,
        startedAt,
        restoreSeconds,
        {
          rpoHours: options.rpoHours,
          rtoMinutes: options.rtoMinutes,
        },
      );

      // Executed probe count: every own-connect and every cross-reject
      // sample runs once per surface (direct + pooler); plus one admin-side
      // ACL assertion per restored database.
      const total = checks.length * surfaces.length + dbMap.length;
      const report: DrillReport = {
        schemaVersion: REPORT_SCHEMA_VERSION,
        startedAt: startedAt.toISOString(),
        target: redactDsn(options.targetDsn),
        archiveSha256: sidecar.archiveSha256,
        archiveBytes: sidecar.archiveBytes,
        databaseCount: sidecar.databaseCount,
        checksummedFiles,
        isolation: {
          total,
          passed,
          plan: "linear",
        },
        rpoSource: "manifest",
        objectives: {
          ...objectives,
          rpoHours: options.rpoHours,
          rtoMinutes: options.rtoMinutes,
        },
      };

      // Success path only: spend the authority so the completed drill cannot
      // be replayed. A failed drill above leaves the target recoverable.
      // Consuming the authority is itself a destructive, irrevocable act on
      // the target: it must be authorized by a still-live capability and a
      // still-held lock, exactly like every other destructive phase.
      assertDrillLockHeld(drillLock);
      assertCapabilityLive();
      consumeRestoreAuthority(
        options.targetDsn,
        options.targetId,
        capability,
        work,
      );
      consumed = true;
      return report;
    } finally {
      // Release the session-held drill lock before the workspace is cleaned.
      releaseDrillLock(drillLock);
    }
  } finally {
    // Decrypted tenant data must not outlive the drill. If consumption did
    // not run (failure path), the target settings remain provisioned for an
    // idempotent re-run inside the capability TTL — mirrored in stderr so
    // operators see the recovery path without leaking secrets.
    if (!consumed) {
      process.stderr.write(
        "drill failed before authority consumption; target settings remain for an idempotent re-run within the capability TTL\n",
      );
    }
    rmSync(work, { recursive: true, force: true });
  }
}

/** Mint a serialized restore capability (operator side, needs signing key). */
export function runMintCommand(argv: string[]): string {
  const { values } = parseArgs({
    args: argv,
    options: {
      "target-id": { type: "string" },
      "archive-sha256": { type: "string" },
      "ttl-minutes": { type: "string", default: "120" },
    },
  });
  const targetId = values["target-id"];
  const archiveSha256 = values["archive-sha256"];
  const ttlMinutes = Number(values["ttl-minutes"]);
  if (!targetId || !archiveSha256) {
    throw new RecoveryDrillError(
      "INVALID_ARGS",
      "mint requires --target-id and --archive-sha256",
    );
  }
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
    throw new RecoveryDrillError(
      "INVALID_ARGS",
      "--ttl-minutes must be a positive number",
    );
  }
  const signingKey = readSigningKey();
  const minted = mintRestoreCapability({
    signingKey,
    targetId,
    archiveSha256,
    expiresAtEpochMs: Date.now() + Math.round(ttlMinutes * 60_000),
  });
  return serializeRestoreCapability(minted);
}

/**
 * Provision the twin settings on the DISPOSABLE drill target from a minted
 * capability file. PostgreSQL 14 rejects ALTER SYSTEM SET for undeclared
 * custom GUCs ("unrecognized configuration parameter"), so this writes both
 * settings to postgresql.auto.conf — the exact file ALTER SYSTEM SET itself
 * writes — and reloads. The write is idempotent (prior eliza.* lines are
 * replaced) and verified through a FRESH session afterwards: a session
 * opened before the reload may still hold the previous (unset) placeholder
 * value.
 */
/** Advisory-lock key for the postgresql.auto.conf provision critical section. */
export const PROVISION_ADVISORY_LOCK_KEY = 0x4552_5a50;

/**
 * Serialize the postgresql.auto.conf provision critical section with a
 * held PostgreSQL session advisory lock (#23453 review r6): a server-held
 * session cannot be stolen or destroyed by another process's pathname
 * operations, so there is no stale-takeover TOCTOU at all. A crashed
 * provisioner's backend dies with it, releasing the lock; the
 * handshake-file sentinel and client-side SIGKILL in acquire/
 * releaseSessionAdvisoryLock cover liveness proof and cleanup.
 */
function withProvisionLock(targetDsn: string, body: () => void): void {
  const handshakePath = join(
    tmpdir(),
    `eliza-provision-lock-${process.pid}-${Date.now()}.txt`,
  );
  const lock = acquireSessionAdvisoryLock(
    // Advisory locks are DATABASE-local, but postgresql.auto.conf is
    // CLUSTER-wide: two provisioners connected to different maintenance
    // databases on the same cluster would each hold their own lock and
    // race on the file anyway. Canonicalize every caller onto the
    // postgres database so the lock is one cluster-wide registry
    // (#23453 review r7).
    targetDatabaseDsn(targetDsn, "postgres"),
    handshakePath,
    PROVISION_ADVISORY_LOCK_KEY,
  );
  try {
    body();
  } finally {
    releaseDrillLock(lock);
  }
}

/**
 * The locked read-modify-write of postgresql.auto.conf: strip prior eliza.*
 * lines, append the fresh twins, and replace the file atomically (sibling
 * temp file + fsync + rename — the same crash-consistency shape ALTER
 * SYSTEM SET itself uses). Caller holds the provision lock.
 */
function writeAutoConfAtomic(
  autoConf: string,
  targetId: string,
  capabilityText: string,
): void {
  const current = readFileSync(autoConf, "utf-8");
  const kept = current
    .split("\n")
    .filter(
      (line: string) =>
        !line.startsWith("eliza.restore_target_id") &&
        !line.startsWith("eliza.restore_capability"),
    );
  kept.push(`eliza.restore_target_id = '${targetId}'`);
  // The serialized capability contains no single quotes (pipe-delimited
  // envelope over UUID/hex ids and a hex signature), so this literal is safe.
  kept.push(`eliza.restore_capability = '${capabilityText}'`);
  const tmpConf = `${autoConf}.eliza-provision-${process.pid}.tmp`;
  const fd = openSync(tmpConf, "w");
  try {
    writeSync(fd, `${kept.join("\n").trimEnd()}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpConf, autoConf);
}

export function runProvisionCommand(
  targetDsn: string,
  targetId: string,
  capabilityFile: string,
): void {
  const capabilityText = readFileSync(capabilityFile, "utf-8").trim();
  const capability = verifyRestoreCapability(
    parseRestoreCapability(capabilityText),
    readSigningKey(),
    Date.now(),
  );
  if (capability.targetId !== targetId) {
    throw new RecoveryDrillError(
      "INVALID_ARGS",
      "capability target id does not match --target-id",
    );
  }
  const dataDir = run("psql", [
    "--no-psqlrc",
    "--tuples-only",
    "--no-align",
    "--set",
    "ON_ERROR_STOP=1",
    "--dbname",
    targetDsn,
    "--command",
    "SHOW data_directory",
  ]).trim();
  const autoConf = join(dataDir, "postgresql.auto.conf");
  // Serialize the read/modify/replace against competing writers (#23453
  // review r3): an exclusive advisory lock beside postgresql.auto.conf means
  // a concurrent provisioner (or operator script following the same
  // convention) cannot interleave its own read-modify-write between ours.
  // ALTER SYSTEM SET takes no user-visible lock, so an interleaved ALTER
  // SYSTEM can still race — the fresh-session verification below proves OUR
  // settings landed, and the lock closes the provisioner-vs-provisioner
  // lost-update race entirely.
  // A POSIX O_EXCL lock file cannot be taken over safely: rename is not
  // conditional on a previously observed inode, so stale takeover and late
  // release can each destroy a successor's fresh claim (#23453 reviews
  // r4-r6). Exclusivity therefore lives in the server: a held advisory
  // session released only by this process exiting or terminating its own
  // backend.
  withProvisionLock(targetDsn, () => {
    writeAutoConfAtomic(autoConf, targetId, capabilityText);
  });
  run("psql", [
    "--no-psqlrc",
    "--set",
    "ON_ERROR_STOP=1",
    "--dbname",
    targetDsn,
    "--command",
    "SELECT pg_reload_conf()",
  ]);
  // Verify through a FRESH session: current_setting of an unset custom
  // placeholder returns an empty string, so equality proves the reload
  // landed for every future session, not just the pre-reload ones.
  const observed = run("psql", [
    "--no-psqlrc",
    "--tuples-only",
    "--no-align",
    "--set",
    "ON_ERROR_STOP=1",
    "--dbname",
    targetDsn,
    "--command",
    `SELECT COALESCE(current_setting('${SETTING_TARGET_ID}', true), '') || '|' || COALESCE(current_setting('${SETTING_CAPABILITY}', true), '')`,
  ]).trim();
  const expected = `${targetId}|${capabilityText}`;
  if (observed !== expected) {
    throw new RecoveryDrillError(
      "REFUSED_TARGET_AUTHORITY",
      "twin settings did not apply after reload (fresh-session verification failed)",
    );
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === "mint") {
    const serialized = runMintCommand(argv.slice(1));
    process.stdout.write(`${serialized}\n`);
  } else if (argv[0] === "provision") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        "target-dsn": { type: "string" },
        "target-id": { type: "string" },
        "capability-file": { type: "string" },
      },
    });
    const targetDsn = values["target-dsn"];
    const targetId = values["target-id"];
    const capabilityFile = values["capability-file"];
    if (!targetDsn || !targetId || !capabilityFile) {
      throw new RecoveryDrillError(
        "INVALID_ARGS",
        "provision requires --target-dsn, --target-id, and --capability-file",
      );
    }
    runProvisionCommand(targetDsn, targetId, capabilityFile);
    process.stderr.write("twin settings provisioned and verified\n");
  } else {
    const options = parseCliArgs(argv);
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
}
