/**
 * Continuous restorability verification for hosted-agent backups (#15603 B5).
 *
 * Staging ran `ELIZA_KMS_BACKEND=memory` for weeks; every 6-hourly backup in
 * `agent_sandbox_backups` was permanently undecryptable and nobody noticed
 * until restores failed with "AEAD decrypt failed" (#15310). A boot-refusal on
 * the ephemeral backend now exists, but nothing proved that ALREADY-STORED
 * backups remain decryptable with the CURRENT keys after rotations, repoints,
 * or storage bit-rot. This module closes that gap: the provisioning-worker
 * daemon calls `runBackupVerificationCycle` on its infra-maintenance cadence;
 * each cycle samples the newest backup per agent (bounded batch, re-verify
 * interval so the fleet is covered over time), decrypts the payload with the
 * real KMS, reconstructs incremental chains, and validates the row's
 * `content_hash` plus the full-agent manifest's per-file/per-component sha256s.
 *
 * What verification proves: key availability + AEAD integrity for the stored
 * ciphertext, chain reconstructability, and hash-consistency of the decrypted
 * artifacts. What it does NOT prove: that a container restored from the state
 * would boot — there is deliberately no restore into a sandbox and no write to
 * any agent state; the only writes are the verification stamps on the backup
 * row itself.
 *
 * Failures are stamped on the row (`verification_status` / `verified_at` /
 * `verification_error`), logged at ERROR, and routed through the same ops
 * alert channels as the daemon heartbeat monitor
 * (`provisioning-worker-health-monitor.ts`). When a cycle's failure rate
 * crosses the escalation threshold — the fleet-wide signature of a KMS
 * misconfiguration — a separate, louder alert fires.
 *
 * Manifest hashing here intentionally mirrors the producer in
 * `packages/agent/src/services/agent-backup.ts` (canonical sorted-key JSON →
 * sha256). Cloud-shared cannot import that package, so the canonicalization is
 * reimplemented; if the producer's hash shapes change, this verifier must
 * change in lockstep or the fleet will page with hash-mismatch failures.
 */

import { createHash } from "node:crypto";
import { desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  decryptAgentBackupStateData,
  isEncryptedAgentBackupStateData,
} from "../../db/crypto/agent-backups";
import { dbRead, dbWrite } from "../../db/helpers";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import {
  type AgentBackupFileEntry,
  type AgentBackupFileSet,
  type AgentBackupManifest,
  type AgentBackupStateData,
  type AgentBackupStoredStateData,
  agentSandboxBackups,
  type StoredAgentSandboxBackup,
} from "../../db/schemas/agent-sandboxes";
import { getObjectText, shouldUseObjectStorage } from "../storage/object-store";
import { logger } from "../utils/logger";
import { computeStateHash, requireBackupStateData } from "./agent-backup-diff";
import {
  type DaemonHealthAlert,
  sendProvisioningWorkerAlert,
} from "./provisioning-worker-health-monitor";

// =============================================================================
// Config
// =============================================================================

export interface BackupVerifierConfig {
  /** `BACKUP_VERIFICATION_ENABLED` — opt-out flag; anything but `0`/`false` is on. */
  enabled: boolean;
  /**
   * `BACKUP_VERIFICATION_BATCH_SIZE` — backups verified per cycle. Kept small
   * because each verification decrypts (and for incrementals chain-replays) a
   * potentially R2-offloaded payload inside the daemon's bounded infra phase.
   */
  batchSize: number;
  /**
   * `BACKUP_VERIFICATION_REVERIFY_HOURS` — a backup verified (or failed) more
   * recently than this is not re-sampled. Governs fleet coverage cadence AND
   * keeps a persistently-broken backup from re-alerting every cycle.
   */
  reVerifyIntervalMs: number;
  /**
   * `BACKUP_VERIFICATION_ESCALATION_PCT` — when at least this percentage of a
   * cycle's sample fails, the systemic escalation alert fires (the every-backup-
   * fails signature of a KMS misconfiguration, #15310).
   */
  escalationThresholdPct: number;
}

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_REVERIFY_HOURS = 24;
const DEFAULT_ESCALATION_PCT = 50;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBooleanDefaultTrue(value: string | undefined): boolean {
  if (value === undefined) return true;
  const normalized = value.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
}

export function readBackupVerifierConfig(
  env: NodeJS.ProcessEnv = process.env,
): BackupVerifierConfig {
  return {
    enabled: parseBooleanDefaultTrue(env.BACKUP_VERIFICATION_ENABLED),
    batchSize: parsePositiveInt(env.BACKUP_VERIFICATION_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    reVerifyIntervalMs:
      parsePositiveInt(env.BACKUP_VERIFICATION_REVERIFY_HOURS, DEFAULT_REVERIFY_HOURS) * 3_600_000,
    escalationThresholdPct: parsePositiveInt(
      env.BACKUP_VERIFICATION_ESCALATION_PCT,
      DEFAULT_ESCALATION_PCT,
    ),
  };
}

// =============================================================================
// Failure classification
// =============================================================================

/**
 * Why a backup failed verification. `key-unavailable` is the #15310 signature —
 * the KMS no longer has the key the row was encrypted under (ephemeral backend
 * bounced, root key rotated without re-wrap, wrong KMS pointed at). AEAD auth
 * failures cannot distinguish corrupted ciphertext from wrong key MATERIAL under
 * the same key id, so both classify as `decrypt-failed`.
 */
export type BackupVerificationFailureKind =
  | "key-unavailable"
  | "decrypt-failed"
  | "payload-missing"
  | "invalid-payload"
  | "chain-broken"
  | "hash-mismatch";

export interface BackupVerificationFailure {
  kind: BackupVerificationFailureKind;
  message: string;
}

export interface BackupVerificationResult {
  ok: boolean;
  failure?: BackupVerificationFailure;
  checks: {
    /** The stored payload decrypted under the current KMS keys. */
    decrypted: boolean;
    /** `content_hash` was present and matched the reconstructed state. */
    contentHashChecked: boolean;
    /** A full-agent manifest was present and its hashes all matched. */
    manifestChecked: boolean;
  };
}

/**
 * Map a KMS/crypto throw to a verification failure, or null when the error is
 * not a recognized crypto failure (caller treats it as verifier infrastructure
 * breakage, which must NOT be stamped on the backup row).
 */
export function classifyCryptoError(error: unknown): BackupVerificationFailure | null {
  if (!(error instanceof Error)) return null;
  if (error.name === "KeyNotFoundError" || /key not found/i.test(error.message)) {
    return { kind: "key-unavailable", message: error.message };
  }
  if (error.name === "AeadError" || /AEAD decrypt failed/i.test(error.message)) {
    return { kind: "decrypt-failed", message: error.message };
  }
  return null;
}

/** Chain-reconstruction failures thrown by the repository/diff layer. */
function classifyChainError(error: unknown): BackupVerificationFailure | null {
  const crypto = classifyCryptoError(error);
  if (crypto) return crypto;
  if (!(error instanceof Error)) return null;
  if (/payload not found|missing state_data_key/i.test(error.message)) {
    return { kind: "payload-missing", message: error.message };
  }
  if (
    /backup chain|has no parent|did not contain|mid-reconstruct|reached before a full backup/i.test(
      error.message,
    )
  ) {
    return { kind: "chain-broken", message: error.message };
  }
  return null;
}

// =============================================================================
// Manifest hash validation (mirror of packages/agent/src/services/agent-backup.ts)
// =============================================================================

type JsonRecord = Record<string, unknown>;

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

function sha256Bytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Json(value: unknown): string {
  return sha256Bytes(JSON.stringify(canonicalize(value)));
}

function verifyFileEntry(label: string, entry: AgentBackupFileEntry, mismatches: string[]): void {
  const bytes = Buffer.from(entry.bytesBase64, "base64");
  if (bytes.length !== entry.size) {
    mismatches.push(`${label}/${entry.path}: size ${bytes.length} != manifest ${entry.size}`);
  }
  const actual = sha256Bytes(bytes);
  if (actual !== entry.sha256) {
    mismatches.push(`${label}/${entry.path}: sha256 ${actual} != manifest ${entry.sha256}`);
  }
}

function verifyFileSet(label: string, fileSet: AgentBackupFileSet, mismatches: string[]): void {
  for (const entry of fileSet.files) verifyFileEntry(label, entry, mismatches);
  const expected = sha256Json(
    fileSet.files.map(({ path, sha256, size }) => ({ path, sha256, size })),
  );
  if (expected !== fileSet.sha256) {
    mismatches.push(`${label}: file-set sha256 ${expected} != manifest ${fileSet.sha256}`);
  }
}

/**
 * Newer agent images emit a `pglite-dump` database component the cloud-side
 * manifest type predates; validate it structurally so those backups still get
 * real hash coverage instead of a type-shaped blind spot.
 */
interface PgliteDumpLike {
  kind: string;
  compression: string;
  file: AgentBackupFileEntry;
  sha256: string;
}

function asPgliteDump(value: unknown): PgliteDumpLike | null {
  if (!value || typeof value !== "object") return null;
  const record = value as JsonRecord;
  if (
    typeof record.kind !== "string" ||
    typeof record.compression !== "string" ||
    typeof record.sha256 !== "string" ||
    !record.file ||
    typeof record.file !== "object"
  ) {
    return null;
  }
  return record as unknown as PgliteDumpLike;
}

/**
 * Validate every recomputable hash in a full-agent backup manifest against the
 * decrypted artifacts it describes. Returns human-readable mismatch strings
 * (empty = manifest verified). The payload sits inside the AEAD envelope, so a
 * mismatch here means the capture wrote inconsistent hashes or the hash scheme
 * drifted — both must page before a restore trips over them.
 */
export function verifyManifestIntegrity(manifest: AgentBackupManifest): string[] {
  const mismatches: string[] = [];
  const { components, integrity } = manifest;

  verifyFileSet("media", components.media, mismatches);
  verifyFileSet("vault", components.vault, mismatches);
  verifyFileSet("stateFiles", components.stateFiles, mismatches);

  const database = components.database;
  if (database.pglite) {
    verifyFileSet("database.pglite", database.pglite, mismatches);
    if (database.sha256 !== database.pglite.sha256) {
      mismatches.push("database: component sha256 does not match its pglite file-set");
    }
  }
  if (database.postgres) {
    const expected = sha256Json(
      database.postgres.tables.map(({ name, columns, rows }) => ({ name, columns, rows })),
    );
    if (expected !== database.postgres.sha256) {
      mismatches.push(
        `database.postgres: sha256 ${expected} != manifest ${database.postgres.sha256}`,
      );
    }
    if (database.sha256 !== database.postgres.sha256) {
      mismatches.push("database: component sha256 does not match its postgres dump");
    }
  }
  const pgliteDump = asPgliteDump((database as JsonRecord).pgliteDump);
  if (pgliteDump) {
    verifyFileEntry("database.pgliteDump", pgliteDump.file, mismatches);
    const expected = sha256Json({
      kind: pgliteDump.kind,
      compression: pgliteDump.compression,
      file: {
        path: pgliteDump.file.path,
        sha256: pgliteDump.file.sha256,
        size: pgliteDump.file.size,
      },
    });
    if (expected !== pgliteDump.sha256) {
      mismatches.push(`database.pgliteDump: sha256 ${expected} != manifest ${pgliteDump.sha256}`);
    }
    if (database.sha256 !== pgliteDump.sha256) {
      mismatches.push("database: component sha256 does not match its pglite dump");
    }
  }

  const character = components.character;
  if (character.configFile)
    verifyFileEntry("character.configFile", character.configFile, mismatches);
  const expectedCharacter = sha256Json({
    runtimeCharacter: character.runtimeCharacter,
    configFile: character.configFile,
  });
  if (expectedCharacter !== character.sha256) {
    mismatches.push(`character: sha256 ${expectedCharacter} != manifest ${character.sha256}`);
  }

  const componentSha256: Record<string, string> = {
    database: components.database.sha256,
    media: components.media.sha256,
    vault: components.vault.sha256,
    character: components.character.sha256,
    stateFiles: components.stateFiles.sha256,
  };
  for (const [name, sha] of Object.entries(componentSha256)) {
    if (integrity.componentHashes[name] !== sha) {
      mismatches.push(
        `integrity.componentHashes.${name} ${integrity.componentHashes[name]} != component ${sha}`,
      );
    }
  }

  return mismatches;
}

// =============================================================================
// Single-row verification
// =============================================================================

/**
 * Resolve the stored (still-encrypted) payload for a backup row. Inline rows
 * carry it in `state_data`; offloaded rows fetch from object storage. Throws
 * when the daemon host has NO object storage configured — that is verifier
 * infrastructure breakage, not a bad backup, and must not stamp a failure.
 */
async function resolveStoredPayload(
  row: StoredAgentSandboxBackup,
): Promise<{ payload: AgentBackupStoredStateData } | { failure: BackupVerificationFailure }> {
  if (row.state_data_storage !== "r2") return { payload: row.state_data };
  if (!row.state_data_key) {
    return {
      failure: { kind: "payload-missing", message: "r2-stored backup has no state_data_key" },
    };
  }
  if (!shouldUseObjectStorage()) {
    throw new Error(
      "backup payload is in object storage but no object storage is configured on this host",
    );
  }
  const raw = await getObjectText(row.state_data_key);
  if (raw === null) {
    return {
      failure: {
        kind: "payload-missing",
        message: `object storage returned no payload for ${row.state_data_key}`,
      },
    };
  }
  try {
    return { payload: JSON.parse(raw) as AgentBackupStoredStateData };
  } catch (error) {
    return {
      failure: {
        kind: "invalid-payload",
        message: `offloaded payload is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

/**
 * Verify one stored backup row end to end: fetch payload → decrypt with the
 * real KMS → reconstruct the full state (chain replay for incrementals) →
 * validate `content_hash` and manifest hashes. Read-only against backup
 * storage; never touches agent state. Throws only on verifier-infrastructure
 * errors (DB/storage unreachable) — every backup-is-broken condition returns a
 * classified failure instead.
 */
export async function verifyBackupRestorability(
  row: StoredAgentSandboxBackup,
): Promise<BackupVerificationResult> {
  const checks = { decrypted: false, contentHashChecked: false, manifestChecked: false };
  const fail = (failure: BackupVerificationFailure): BackupVerificationResult => ({
    ok: false,
    failure,
    checks,
  });

  const resolved = await resolveStoredPayload(row);
  if ("failure" in resolved) return fail(resolved.failure);

  // Decrypt the sampled row itself. This is the check that would have caught
  // #15310: it exercises the CURRENT KMS against ciphertext written earlier.
  // Legacy plaintext rows (pre-encryption) pass through and are still
  // hash-verified below.
  let plain: Awaited<ReturnType<typeof decryptAgentBackupStateData>>;
  if (isEncryptedAgentBackupStateData(resolved.payload)) {
    try {
      plain = await decryptAgentBackupStateData(row.id, resolved.payload);
    } catch (error) {
      const classified = classifyCryptoError(error);
      if (classified) return fail(classified);
      throw error;
    }
  } else {
    plain = resolved.payload;
  }
  checks.decrypted = true;

  // Reconstruct the full state a restore would apply. Incremental rows replay
  // their parent chain through the repository (decrypting every ancestor —
  // exactly the work a real restore performs, minus the container).
  let state: AgentBackupStateData;
  if (row.backup_kind === "incremental") {
    try {
      const reconstructed = await agentSandboxesRepository.getReconstructedBackupState(row.id);
      if (!reconstructed) {
        return fail({ kind: "chain-broken", message: "backup vanished during reconstruction" });
      }
      state = reconstructed;
    } catch (error) {
      const classified = classifyChainError(error);
      if (classified) return fail(classified);
      throw error;
    }
  } else {
    try {
      state = requireBackupStateData(plain, row.id);
    } catch (error) {
      return fail({
        kind: "invalid-payload",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (row.content_hash) {
    const actual = computeStateHash(state);
    if (actual !== row.content_hash) {
      return fail({
        kind: "hash-mismatch",
        message: `content_hash ${row.content_hash} != reconstructed ${actual}`,
      });
    }
    checks.contentHashChecked = true;
  }

  if (state.manifest) {
    const mismatches = verifyManifestIntegrity(state.manifest);
    if (mismatches.length > 0) {
      return fail({
        kind: "hash-mismatch",
        message: `manifest integrity: ${mismatches.slice(0, 5).join("; ")}`,
      });
    }
    checks.manifestChecked = true;
  }

  return { ok: true, checks };
}

// =============================================================================
// Fleet sampling cycle
// =============================================================================

export interface BackupVerificationFailureRecord {
  backupId: string;
  sandboxRecordId: string;
  kind: BackupVerificationFailureKind;
  message: string;
}

export interface BackupVerificationCycleSummary {
  enabled: boolean;
  sampled: number;
  verified: number;
  failed: number;
  /** Verifier-infrastructure errors — logged, NOT stamped as backup failures. */
  errored: number;
  escalated: boolean;
  failures: BackupVerificationFailureRecord[];
}

const FAILURE_ALERT_DEDUP_KEY = "agent-backup-verification-failure";
const SYSTEMIC_ALERT_DEDUP_KEY = "agent-backup-verification-systemic";

/**
 * Sample the newest backup per agent that has not been verified within the
 * re-verify interval, verify each, stamp the outcome on the row, and alert on
 * failures. Only the LATEST backup per sandbox is sampled because that is what
 * a restore reaches for first (and incremental verification transitively
 * exercises the ancestors it depends on).
 *
 * `now` and `alert` are injectable for tests; production uses the wall clock
 * and the shared provisioning ops alert channels.
 */
export async function runBackupVerificationCycle(
  deps: {
    config?: BackupVerifierConfig;
    now?: () => Date;
    alert?: (alert: DaemonHealthAlert) => void | Promise<void>;
  } = {},
): Promise<BackupVerificationCycleSummary> {
  const config = deps.config ?? readBackupVerifierConfig();
  const alert = deps.alert ?? sendProvisioningWorkerAlert;
  const summary: BackupVerificationCycleSummary = {
    enabled: config.enabled,
    sampled: 0,
    verified: 0,
    failed: 0,
    errored: 0,
    escalated: false,
    failures: [],
  };
  if (!config.enabled) return summary;

  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - config.reVerifyIntervalMs);

  const latest = dbRead
    .selectDistinctOn([agentSandboxBackups.sandbox_record_id])
    .from(agentSandboxBackups)
    .orderBy(agentSandboxBackups.sandbox_record_id, desc(agentSandboxBackups.created_at))
    .as("latest_backup_per_agent");

  const candidates = await dbRead
    .select()
    .from(latest)
    .where(or(isNull(latest.verified_at), lt(latest.verified_at, cutoff)))
    // Never-verified rows first, then the longest-stale, so the whole fleet
    // converges to coverage instead of re-polishing recently-checked agents.
    .orderBy(sql`${latest.verified_at} asc nulls first`, latest.created_at)
    .limit(config.batchSize);

  for (const row of candidates) {
    summary.sampled += 1;
    let result: BackupVerificationResult;
    try {
      result = await verifyBackupRestorability(row);
    } catch (error) {
      // error-policy:J7 diagnostics-must-not-kill-the-loop — verifier infra
      // breakage (DB/object-storage unreachable) is logged loudly but must not
      // stamp a healthy backup as failed nor abort the rest of the batch.
      summary.errored += 1;
      logger.error("[AgentBackupVerifier] verification errored (infrastructure, not stamped)", {
        backupId: row.id,
        sandboxRecordId: row.sandbox_record_id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    await dbWrite
      .update(agentSandboxBackups)
      .set({
        verification_status: result.ok ? "verified" : "failed",
        verified_at: now,
        verification_error: result.ok
          ? null
          : `${result.failure?.kind}: ${result.failure?.message}`,
      })
      .where(eq(agentSandboxBackups.id, row.id));

    if (result.ok) {
      summary.verified += 1;
      continue;
    }

    summary.failed += 1;
    const failure = result.failure ?? { kind: "invalid-payload" as const, message: "unknown" };
    summary.failures.push({
      backupId: row.id,
      sandboxRecordId: row.sandbox_record_id,
      kind: failure.kind,
      message: failure.message,
    });
    logger.error("[AgentBackupVerifier] backup failed restorability verification", {
      backupId: row.id,
      sandboxRecordId: row.sandbox_record_id,
      snapshotType: row.snapshot_type,
      backupKind: row.backup_kind,
      createdAt: row.created_at.toISOString(),
      failureKind: failure.kind,
      error: failure.message,
    });
  }

  if (summary.failed > 0) {
    await alert({
      title: `${summary.failed}/${summary.sampled} sampled agent backups are NOT restorable`,
      message:
        "Restorability verification decrypts stored agent backups with the current KMS keys " +
        "and validates content hashes; these backups would fail a real restore. " +
        "Failed rows are stamped in agent_sandbox_backups (verification_error).",
      details: {
        failures: summary.failures.slice(0, 10),
        sampled: summary.sampled,
        failed: summary.failed,
      },
      dedupKey: FAILURE_ALERT_DEDUP_KEY,
    });

    const failurePct = (summary.failed / summary.sampled) * 100;
    if (failurePct >= config.escalationThresholdPct) {
      summary.escalated = true;
      const keyUnavailable = summary.failures.filter((f) => f.kind === "key-unavailable").length;
      await alert({
        title: "SYSTEMIC agent-backup verification failure — check KMS configuration",
        message:
          `${summary.failed}/${summary.sampled} (${failurePct.toFixed(0)}%) of this cycle's ` +
          `sample failed (${keyUnavailable} key-unavailable). A fleet-wide failure is the ` +
          "signature of a KMS misconfiguration (#15310: ephemeral memory backend silently " +
          "orphaned every staging backup). Verify ELIZA_KMS_BACKEND and the root key on the " +
          "hosts that WRITE backups before the retention window prunes the last good ones.",
        details: {
          sampled: summary.sampled,
          failed: summary.failed,
          keyUnavailable,
          escalationThresholdPct: config.escalationThresholdPct,
          failures: summary.failures.slice(0, 10),
        },
        dedupKey: SYSTEMIC_ALERT_DEDUP_KEY,
      });
    }
  }

  return summary;
}
