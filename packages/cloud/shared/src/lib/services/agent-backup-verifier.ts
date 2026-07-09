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
 * misconfiguration — a separate, louder alert fires, gated by a minimum
 * sample floor so a 1-of-1 cycle cannot page as "systemic".
 *
 * Verifier-infrastructure errors (DB/object-storage/KMS transport breakage)
 * are stamped `errored` with the attempt timestamp so a persistently-broken
 * row cannot occupy the head of the nulls-first sampler forever (#15626).
 * Two alerts cover them: a cycle-level alert whenever a sweep hit infra
 * errors (immediate signal that the verifier host is broken), and a per-row
 * alert when the SAME row keeps erroring across consecutive attempts.
 * Incremental chains are reconstructed here chain-only and sequentially —
 * NOT via the repository's `getReconstructedBackupState`, which hydrates and
 * decrypts every retained backup in parallel for the restore path — and all
 * decryption in a cycle is capped by a byte budget so a pathological sandbox
 * cannot OOM the provisioning daemon.
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
  type AgentBackupPlainStateData,
  type AgentBackupStateData,
  type AgentBackupStoredStateData,
  agentSandboxBackups,
  type StoredAgentSandboxBackup,
} from "../../db/schemas/agent-sandboxes";
import { getObjectText, shouldUseObjectStorage } from "../storage/object-store";
import { logger } from "../utils/logger";
import {
  applyBackupDelta,
  type BackupChainNode,
  computeStateHash,
  requireBackupDelta,
  requireBackupStateData,
  resolveBackupChain,
} from "./agent-backup-diff";
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
  /**
   * `BACKUP_VERIFICATION_MIN_SYSTEMIC_SAMPLE` — the systemic escalation only
   * fires when at least this many backups were sampled in the cycle. A single
   * bad backup in a 1-row cycle is 100% "failure rate" but not a fleet-wide
   * signature; per-row failure alerts still fire regardless of sample size.
   */
  minSystemicSample: number;
  /**
   * `BACKUP_VERIFICATION_MAX_DECRYPT_BYTES` — total stored-payload bytes the
   * verifier may download+decrypt in one cycle. Bounds daemon memory: a cycle
   * stops sampling when the budget runs out (deferred rows are re-sampled
   * first next cycle), and a single payload larger than the whole budget is
   * stamped `errored` as a bounded skip instead of being decrypted at all.
   */
  maxDecryptBytesPerCycle: number;
  /**
   * `BACKUP_VERIFICATION_ERRORED_ALERT_STREAK` — alert when the same backup
   * row hits a verifier-infrastructure error this many verification attempts
   * in a row. The cycle-level infra alert says "this sweep hit errors"; this
   * one says "this specific backup has been unverifiable for N attempts".
   */
  erroredAlertStreak: number;
}

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_REVERIFY_HOURS = 24;
const DEFAULT_ESCALATION_PCT = 50;
const DEFAULT_MIN_SYSTEMIC_SAMPLE = 5;
const DEFAULT_MAX_DECRYPT_BYTES = 256 * 1024 * 1024;
const DEFAULT_ERRORED_ALERT_STREAK = 3;
/** Matches the repository's historical retained-backups lookup cap. */
const CHAIN_LOOKUP_LIMIT = 1000;

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
    minSystemicSample: parsePositiveInt(
      env.BACKUP_VERIFICATION_MIN_SYSTEMIC_SAMPLE,
      DEFAULT_MIN_SYSTEMIC_SAMPLE,
    ),
    maxDecryptBytesPerCycle: parsePositiveInt(
      env.BACKUP_VERIFICATION_MAX_DECRYPT_BYTES,
      DEFAULT_MAX_DECRYPT_BYTES,
    ),
    erroredAlertStreak: parsePositiveInt(
      env.BACKUP_VERIFICATION_ERRORED_ALERT_STREAK,
      DEFAULT_ERRORED_ALERT_STREAK,
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
  /**
   * Set when the row was not verified because the cycle's decrypt byte budget
   * could not cover it (bounded skip, #15626). Mutually exclusive with
   * `failure`: a skip says nothing about the backup's health.
   */
  skipped?: BackupVerificationSkip;
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
  // The steward backend reports a missing key as a generic KmsError carrying
  // the HTTP status — same #15310 signature as the memory backend's
  // KeyNotFoundError. Message text is the fallback for errors serialized
  // without the structured status.
  const kmsShaped = error as { status?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const maybeStatus = kmsShaped.status ?? kmsShaped.$metadata?.httpStatusCode;
  if (
    error.name === "KmsError" &&
    (maybeStatus === 404 || /\b404\b|not found/i.test(error.message))
  ) {
    return { kind: "key-unavailable", message: error.message };
  }
  if (error.name === "AeadError" || /AEAD decrypt failed/i.test(error.message)) {
    return { kind: "decrypt-failed", message: error.message };
  }
  return null;
}

function classifyMissingObjectPayload(error: unknown): BackupVerificationFailure | null {
  if (!(error instanceof Error)) return null;
  const maybeStatus = (error as { $metadata?: { httpStatusCode?: unknown }; status?: unknown })
    .$metadata?.httpStatusCode;
  if (
    error.name === "NoSuchKey" ||
    error.name === "NotFound" ||
    maybeStatus === 404 ||
    /no such key|not found/i.test(error.message)
  ) {
    return { kind: "payload-missing", message: error.message };
  }
  return null;
}

/** Chain-reconstruction failures thrown by the repository/diff layer. */
function classifyChainError(error: unknown): BackupVerificationFailure | null {
  const crypto = classifyCryptoError(error);
  if (crypto) return crypto;
  const missingPayload = classifyMissingObjectPayload(error);
  if (missingPayload) return missingPayload;
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
 * Byte budget shared by every download+decrypt in one verification cycle.
 * Charged with the STORED payload size (ciphertext ≈ plaintext for AES-GCM),
 * measured before decrypting, so the bound holds even for payloads that would
 * fail to decrypt.
 */
export interface DecryptBudget {
  totalBytes: number;
  usedBytes: number;
}

export function createDecryptBudget(totalBytes: number): DecryptBudget {
  return { totalBytes, usedBytes: 0 };
}

type BudgetCharge = "ok" | BackupVerificationSkipReason;

function chargeBudget(budget: DecryptBudget, bytes: number): BudgetCharge {
  // Distinguish "this payload can NEVER fit" (permanent — stamp it so it
  // stops being sampled) from "this cycle's budget is spent" (transient —
  // defer to the next cycle's fresh budget).
  if (bytes > budget.totalBytes) return "payload-exceeds-cycle-budget";
  if (budget.usedBytes + bytes > budget.totalBytes) return "cycle-budget-exhausted";
  budget.usedBytes += bytes;
  return "ok";
}

export type BackupVerificationSkipReason =
  | "payload-exceeds-cycle-budget"
  | "cycle-budget-exhausted";

export interface BackupVerificationSkip {
  reason: BackupVerificationSkipReason;
  requiredBytes: number;
  budgetBytes: number;
}

/**
 * Resolve the stored (still-encrypted) payload for a backup row plus its
 * stored byte size (for budget accounting). Inline rows carry it in
 * `state_data`; offloaded rows fetch from object storage. Throws when the
 * daemon host has NO object storage configured — that is verifier
 * infrastructure breakage, not a bad backup, and must not stamp a failure.
 */
async function resolveStoredPayload(
  row: StoredAgentSandboxBackup,
): Promise<
  { payload: AgentBackupStoredStateData; bytes: number } | { failure: BackupVerificationFailure }
> {
  if (row.state_data_storage !== "r2") {
    return {
      payload: row.state_data,
      bytes: Buffer.byteLength(JSON.stringify(row.state_data), "utf8"),
    };
  }
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
  let raw: string | null;
  try {
    raw = await getObjectText(row.state_data_key);
  } catch (error) {
    const missingPayload = classifyMissingObjectPayload(error);
    if (missingPayload) {
      // Name the lost key: the stamped verification_error is an operator's
      // only lead when triaging which object vanished.
      return {
        failure: {
          kind: "payload-missing",
          message: `object storage has no payload for ${row.state_data_key}: ${missingPayload.message}`,
        },
      };
    }
    throw error;
  }
  if (raw === null) {
    return {
      failure: {
        kind: "payload-missing",
        message: `object storage returned no payload for ${row.state_data_key}`,
      },
    };
  }
  try {
    return {
      payload: JSON.parse(raw) as AgentBackupStoredStateData,
      bytes: Buffer.byteLength(raw, "utf8"),
    };
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
 * Reconstruct the full state for an incremental backup by walking ONLY its
 * parent chain, one member at a time. Deliberately not the repository's
 * `getReconstructedBackupState`: that hydrates (downloads + decrypts) every
 * retained backup of the sandbox in parallel, which is fine for a one-off
 * restore but multiplied by the verifier's batch it can OOM the provisioning
 * daemon (#15626). Non-chain backups are never fetched; each member's payload
 * is charged against the cycle budget before it is decrypted and is released
 * before the next member loads. `targetPlain` is the sampled row's
 * already-decrypted (and already-charged) payload, applied as the final delta.
 */
async function reconstructIncrementalStateSequential(
  row: StoredAgentSandboxBackup,
  targetPlain: AgentBackupPlainStateData,
  budget: DecryptBudget,
): Promise<
  | { state: AgentBackupStateData }
  | { failure: BackupVerificationFailure }
  | { skipped: BackupVerificationSkip }
> {
  const metadata = await agentSandboxesRepository.listBackupMetadata(
    row.sandbox_record_id,
    CHAIN_LOOKUP_LIMIT,
  );
  const nodes: BackupChainNode[] = metadata.map((b) => ({
    id: b.id,
    backupKind: b.backup_kind,
    parentBackupId: b.parent_backup_id,
    createdAtMs: b.created_at.getTime(),
  }));
  let chain: string[];
  try {
    chain = resolveBackupChain(nodes, row.id);
  } catch (error) {
    const classified = classifyChainError(error);
    if (classified) return { failure: classified };
    throw error;
  }

  let state: AgentBackupStateData | undefined;
  for (const memberId of chain) {
    let plain: AgentBackupPlainStateData;
    if (memberId === row.id) {
      plain = targetPlain;
    } else {
      const [member] = await dbRead
        .select()
        .from(agentSandboxBackups)
        .where(eq(agentSandboxBackups.id, memberId))
        .limit(1);
      if (!member) {
        return {
          failure: {
            kind: "chain-broken",
            message: `backup chain row ${memberId} vanished mid-reconstruct`,
          },
        };
      }
      const resolved = await resolveStoredPayload(member);
      if ("failure" in resolved) return { failure: resolved.failure };
      const charge = chargeBudget(budget, resolved.bytes);
      if (charge !== "ok") {
        return {
          skipped: {
            reason: charge,
            requiredBytes: resolved.bytes,
            budgetBytes: budget.totalBytes,
          },
        };
      }
      if (isEncryptedAgentBackupStateData(resolved.payload)) {
        try {
          plain = await decryptAgentBackupStateData(member.id, resolved.payload);
        } catch (error) {
          const classified = classifyCryptoError(error);
          if (classified) return { failure: classified };
          throw error;
        }
      } else {
        plain = resolved.payload;
      }
    }
    try {
      // resolveBackupChain guarantees the chain starts at the base full
      // backup; every later member is a delta.
      state =
        state === undefined
          ? requireBackupStateData(plain, memberId)
          : applyBackupDelta(state, requireBackupDelta(plain, memberId));
    } catch (error) {
      return {
        failure: {
          kind: "chain-broken",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
  if (!state) {
    return { failure: { kind: "chain-broken", message: "backup chain resolved empty" } };
  }
  return { state };
}

/**
 * Verify one stored backup row end to end: fetch payload → decrypt with the
 * real KMS → reconstruct the full state (sequential chain-only replay for
 * incrementals) → validate `content_hash` and manifest hashes. Read-only
 * against backup storage; never touches agent state. Throws only on
 * verifier-infrastructure errors (DB/storage unreachable) — every
 * backup-is-broken condition returns a classified failure, and a payload the
 * cycle's decrypt budget cannot cover returns a `skipped` result.
 */
export async function verifyBackupRestorability(
  row: StoredAgentSandboxBackup,
  opts: { budget?: DecryptBudget } = {},
): Promise<BackupVerificationResult> {
  const budget =
    opts.budget ?? createDecryptBudget(readBackupVerifierConfig().maxDecryptBytesPerCycle);
  const checks = { decrypted: false, contentHashChecked: false, manifestChecked: false };
  const fail = (failure: BackupVerificationFailure): BackupVerificationResult => ({
    ok: false,
    failure,
    checks,
  });

  const resolved = await resolveStoredPayload(row);
  if ("failure" in resolved) return fail(resolved.failure);
  const charge = chargeBudget(budget, resolved.bytes);
  if (charge !== "ok") {
    return {
      ok: false,
      skipped: { reason: charge, requiredBytes: resolved.bytes, budgetBytes: budget.totalBytes },
      checks,
    };
  }

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
  // their parent chain sequentially, fetching and decrypting ONLY chain
  // members under the cycle's byte budget.
  let state: AgentBackupStateData;
  if (row.backup_kind === "incremental") {
    const reconstructed = await reconstructIncrementalStateSequential(row, plain, budget);
    if ("failure" in reconstructed) return fail(reconstructed.failure);
    if ("skipped" in reconstructed) {
      return { ok: false, skipped: reconstructed.skipped, checks };
    }
    state = reconstructed.state;
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
  /**
   * Verifier-infrastructure errors — stamped `errored` (never `failed`) with
   * the attempt timestamp so they cannot starve the sampler; alerted at cycle
   * level, and per-row once the same row keeps erroring.
   */
  errored: number;
  /** Rows whose payload can never fit the cycle decrypt budget (stamped `errored`). */
  oversizeSkipped: number;
  /**
   * Rows deferred because this cycle's decrypt budget ran out mid-sample.
   * Not stamped: the nulls-first ordering re-samples them first next cycle.
   */
  budgetDeferred: number;
  escalated: boolean;
  failures: BackupVerificationFailureRecord[];
}

const FAILURE_ALERT_DEDUP_KEY = "agent-backup-verification-failure";
const ERROR_ALERT_DEDUP_KEY = "agent-backup-verification-error";
const SYSTEMIC_ALERT_DEDUP_KEY = "agent-backup-verification-systemic";
const PERSISTENT_ERROR_ALERT_DEDUP_KEY = "agent-backup-verification-persistent-error";

/**
 * `verification_error` prefix for infra-error stamps. The bracketed integer is
 * the row's consecutive-attempt error streak, persisted on the row itself so
 * the streak survives daemon restarts without another column; it resets the
 * moment an attempt reaches a real verified/failed outcome.
 */
const INFRA_ERROR_STREAK_PATTERN = /^infra-error\[(\d+)\]/;

function consecutiveInfraErrorStreak(row: StoredAgentSandboxBackup): number {
  if (row.verification_status !== "errored" || !row.verification_error) return 0;
  const match = INFRA_ERROR_STREAK_PATTERN.exec(row.verification_error);
  // An `errored` stamp without a parseable counter still proves one prior
  // errored attempt.
  return match ? Number.parseInt(match[1], 10) : 1;
}

function formatInfraError(streak: number, message: string): string {
  return `infra-error[${streak}]: ${message}`;
}

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
    oversizeSkipped: 0,
    budgetDeferred: 0,
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

  const budget = createDecryptBudget(config.maxDecryptBytesPerCycle);

  // Stamp an infra-error attempt: status `errored` (never `failed` — the
  // backup itself may be healthy), attempt timestamp so the nulls-first
  // sampler moves on, and a persisted consecutive-attempt streak that raises
  // a per-row alert once it crosses the configured threshold (the cycle-level
  // infra alert at the end of the sweep covers the immediate signal).
  const stampInfraError = async (row: StoredAgentSandboxBackup, message: string) => {
    const streak = consecutiveInfraErrorStreak(row) + 1;
    await dbWrite
      .update(agentSandboxBackups)
      .set({
        verification_status: "errored",
        verified_at: now,
        verification_error: formatInfraError(streak, message),
      })
      .where(eq(agentSandboxBackups.id, row.id));
    if (streak >= config.erroredAlertStreak) {
      await alert({
        title: `agent backup verification has errored ${streak} consecutive attempts`,
        message:
          "The restorability verifier keeps hitting infrastructure errors on the same backup " +
          "row (object storage / KMS transport / DB), so the backup can be neither confirmed " +
          "restorable nor stamped failed. Fix the verifier-side breakage; the row retries " +
          "every re-verify interval.",
        details: {
          backupId: row.id,
          sandboxRecordId: row.sandbox_record_id,
          streak,
          error: message,
        },
        dedupKey: PERSISTENT_ERROR_ALERT_DEDUP_KEY,
      });
    }
    return streak;
  };

  for (const row of candidates) {
    let result: BackupVerificationResult;
    try {
      result = await verifyBackupRestorability(row, { budget });
    } catch (error) {
      // error-policy:J7 diagnostics-must-not-kill-the-loop — verifier infra
      // breakage (DB/object-storage unreachable) is logged loudly and stamped
      // `errored` (with attempt timestamp + streak alerting) but must not
      // stamp a healthy backup as failed nor abort the rest of the batch.
      summary.sampled += 1;
      summary.errored += 1;
      const message = error instanceof Error ? error.message : String(error);
      const streak = await stampInfraError(row, message);
      logger.error("[AgentBackupVerifier] verification errored (infrastructure)", {
        backupId: row.id,
        sandboxRecordId: row.sandbox_record_id,
        erroredStreak: streak,
        error: message,
      });
      continue;
    }

    if (result.skipped) {
      if (result.skipped.reason === "cycle-budget-exhausted") {
        // Transient: the rest of the batch waits for the next cycle's fresh
        // budget; unstamped rows stay at the head of the nulls-first order.
        summary.budgetDeferred += 1;
        logger.warn(
          "[AgentBackupVerifier] cycle decrypt budget exhausted; deferring remaining sample",
          {
            backupId: row.id,
            sandboxRecordId: row.sandbox_record_id,
            requiredBytes: result.skipped.requiredBytes,
            budgetBytes: result.skipped.budgetBytes,
            usedBytes: budget.usedBytes,
          },
        );
        break;
      }
      // payload-exceeds-cycle-budget: this row can NEVER verify under the
      // configured budget — a bounded skip stamped `errored` so it cannot
      // wedge the sampler, with streak alerting to surface the misfit config.
      summary.sampled += 1;
      summary.oversizeSkipped += 1;
      const message =
        `stored payload of ${result.skipped.requiredBytes} bytes exceeds ` +
        `BACKUP_VERIFICATION_MAX_DECRYPT_BYTES=${result.skipped.budgetBytes}`;
      const streak = await stampInfraError(row, message);
      logger.error("[AgentBackupVerifier] backup payload exceeds the cycle decrypt budget", {
        backupId: row.id,
        sandboxRecordId: row.sandbox_record_id,
        requiredBytes: result.skipped.requiredBytes,
        budgetBytes: result.skipped.budgetBytes,
        erroredStreak: streak,
      });
      continue;
    }

    summary.sampled += 1;
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

    // The systemic page needs both a high failure RATE and a meaningful
    // sample: 1 bad row out of 1 sampled is 100% but says nothing fleet-wide.
    // Per-row failure alerting above is unaffected by the floor.
    const failurePct = (summary.failed / summary.sampled) * 100;
    if (
      summary.sampled >= config.minSystemicSample &&
      failurePct >= config.escalationThresholdPct
    ) {
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

  if (summary.errored > 0) {
    await alert({
      title: `${summary.errored}/${summary.sampled} sampled agent backups could not be verified`,
      message:
        "Backup verification hit infrastructure errors. Rows were stamped with " +
        "verified_at so they do not permanently wedge the sampler head; inspect " +
        "verification_error for the exact infra failure and fix the verifier host.",
      details: {
        sampled: summary.sampled,
        errored: summary.errored,
      },
      dedupKey: ERROR_ALERT_DEDUP_KEY,
    });
  }

  return summary;
}
