/**
 * Restore-integrity gate for hosted-agent wake (#15603 B6).
 *
 * Waking a sleeping agent provisions a fresh container and rehydrates it from
 * a stored backup — the sandbox's compute identity was already discarded at
 * sleep, so that backup IS the agent's durable state. `provision()`'s built-in
 * latest-backup restore degrades unrecoverable snapshots (undecryptable, gone)
 * to a FRESH BOOT, which is the right call for a running agent losing volatile
 * session state but silently empties a woken agent. This gate runs BEFORE the
 * wake touches any compute: it validates the exact backup the restore will
 * apply, and on failure the wake job fails with a typed, user-legible error
 * while the sandbox stays `sleeping` — nothing is deleted, nothing boots empty.
 *
 * Verification REUSES the continuous-restorability primitives from
 * `agent-backup-verifier.ts` (`verifyBackupRestorability`: real KMS decrypt,
 * sequential chain replay for incrementals, `content_hash` + manifest hash
 * validation) and stamps outcomes on the row with the same field semantics as
 * the verifier cycle. A row already stamped `verified` within an env-tunable
 * freshness window skips re-verification; a row stamped `failed` hard-fails
 * immediately without touching KMS. On failure the gate scans the retention
 * set for an OLDER backup that does validate and names it in the error, so the
 * user can explicitly retry the wake with `restoreBackupId` — or accept data
 * loss with `forceFreshBoot`. Both escape hatches are explicit opt-ins on the
 * wake route; neither is ever a default. Failures alert through the same
 * provisioning ops channel the verifier uses.
 *
 * Runs daemon-side (inside `executeWake`), where the real KMS and DB write
 * access live. Verifier-infrastructure errors (KMS transport, object storage,
 * DB) THROW — the wake job retries instead of misreading infra breakage as a
 * bad backup or, worse, booting fresh.
 */

import { ElizaError } from "@elizaos/core";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import type { StoredAgentSandboxBackup } from "../../db/schemas/agent-sandboxes";
import { logger } from "../utils/logger";
import {
  type BackupVerificationFailureKind,
  createDecryptBudget,
  type DecryptBudget,
  readBackupVerifierConfig,
  verifyBackupRestorability,
} from "./agent-backup-verifier";
import {
  type DaemonHealthAlert,
  sendProvisioningWorkerAlert,
} from "./provisioning-worker-health-monitor";

// =============================================================================
// Config
// =============================================================================

export interface WakeRestoreGateConfig {
  /**
   * `WAKE_RESTORE_INTEGRITY_ENABLED` — ops kill switch; accepts only `1`/
   * `true` or `0`/`false`. When off, wake reverts to the ungated legacy behavior
   * (latest-backup restore with provision's degrade-to-fresh-boot).
   */
  enabled: boolean;
  /**
   * `WAKE_RESTORE_VERIFIED_FRESHNESS_HOURS` — a backup stamped `verified` more
   * recently than this wakes without re-verification. Default matches the
   * continuous verifier's 24h re-verify cadence, so a fleet covered by the B5
   * cycle normally wakes on the stamp alone.
   */
  verifiedFreshnessMs: number;
  /**
   * `WAKE_RESTORE_ALTERNATIVE_SCAN_LIMIT` — how many retained backups the
   * failure path may inspect while hunting for an older valid restore point.
   * Bounds the decrypt work a single failed wake can trigger; the retention
   * set is ~10 restore points plus chain ancestors.
   */
  alternativeScanLimit: number;
}

const DEFAULT_VERIFIED_FRESHNESS_HOURS = 24;
const DEFAULT_ALTERNATIVE_SCAN_LIMIT = 25;

function invalidWakeConfig(name: string, value: string, expected: string): never {
  throw new ElizaError(`Invalid ${name}: expected ${expected}, received ${JSON.stringify(value)}`, {
    code: "WAKE_RESTORE_CONFIG_INVALID",
    severity: "fatal",
    context: { name, value, expected },
  });
}

function parsePositiveInt(name: string, value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return invalidWakeConfig(name, value, "a positive integer");
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return invalidWakeConfig(name, value, "a positive integer");
  }
  return parsed;
}

function parseBooleanDefaultTrue(name: string, value: string | undefined): boolean {
  if (value === undefined) return true;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  return invalidWakeConfig(name, value, "true, false, 1, or 0");
}

export function readWakeRestoreGateConfig(
  env: NodeJS.ProcessEnv = process.env,
): WakeRestoreGateConfig {
  return {
    enabled: parseBooleanDefaultTrue(
      "WAKE_RESTORE_INTEGRITY_ENABLED",
      env.WAKE_RESTORE_INTEGRITY_ENABLED,
    ),
    verifiedFreshnessMs:
      parsePositiveInt(
        "WAKE_RESTORE_VERIFIED_FRESHNESS_HOURS",
        env.WAKE_RESTORE_VERIFIED_FRESHNESS_HOURS,
        DEFAULT_VERIFIED_FRESHNESS_HOURS,
      ) * 3_600_000,
    alternativeScanLimit: parsePositiveInt(
      "WAKE_RESTORE_ALTERNATIVE_SCAN_LIMIT",
      env.WAKE_RESTORE_ALTERNATIVE_SCAN_LIMIT,
      DEFAULT_ALTERNATIVE_SCAN_LIMIT,
    ),
  };
}

// =============================================================================
// Result types
// =============================================================================

/**
 * `previously-failed`: the row carries a `failed` verification stamp, so the
 * gate refuses without re-decrypting. `backup-not-found`: an explicitly
 * requested `restoreBackupId` does not exist for this sandbox (cross-sandbox
 * ids are indistinguishable from missing ones — no existence oracle).
 */
export type WakeRestoreFailureKind =
  | BackupVerificationFailureKind
  | "previously-failed"
  | "backup-not-found";

export interface WakeRestoreIntegrityFailure {
  backupId: string;
  /** ISO timestamp; null when the backup row itself was not found. */
  backupCreatedAt: string | null;
  snapshotType: string | null;
  kind: WakeRestoreFailureKind;
  message: string;
  /** Older retained backup that DID validate — the explicit `restoreBackupId` escape hatch. */
  alternativeBackupId?: string;
  alternativeBackupCreatedAt?: string;
}

export type WakeRestoreGateResult =
  | {
      ok: true;
      /** The validated backup the wake will restore; null when there is nothing to restore. */
      backupId: string | null;
      verification: "verified" | "fresh-stamp" | "no-backup" | "disabled";
    }
  | { ok: false; failure: WakeRestoreIntegrityFailure };

/**
 * Typed job-failure error for a wake refused by the integrity gate. The
 * message is the full user-legible explanation (backup, failure kind, and the
 * explicit escape hatches); the structured failure rides along for the job
 * result record.
 */
export class WakeRestoreIntegrityError extends Error {
  override readonly name = "WakeRestoreIntegrityError";
  constructor(readonly failure: WakeRestoreIntegrityFailure) {
    super(formatWakeRestoreIntegrityError(failure));
  }
}

export function formatWakeRestoreIntegrityError(failure: WakeRestoreIntegrityFailure): string {
  if (failure.kind === "backup-not-found") {
    return (
      `Wake blocked: requested backup ${failure.backupId} was not found for this agent. ` +
      "The agent was left sleeping and no state was deleted."
    );
  }
  const created = failure.backupCreatedAt ? `, created ${failure.backupCreatedAt}` : "";
  const base =
    `Wake blocked: backup ${failure.backupId} (${failure.snapshotType ?? "unknown"}${created}) ` +
    `failed restore-integrity validation [${failure.kind}]: ${failure.message}. ` +
    "The agent was left sleeping and no state was deleted.";
  const alternative = failure.alternativeBackupId
    ? ` An older backup ${failure.alternativeBackupId}` +
      (failure.alternativeBackupCreatedAt
        ? ` (created ${failure.alternativeBackupCreatedAt})`
        : "") +
      " passed validation — retry the wake with restoreBackupId to restore from it."
    : " No older retained backup passed validation.";
  return `${base}${alternative} To boot the agent empty and accept the data loss, retry the wake with forceFreshBoot.`;
}

// =============================================================================
// Gate
// =============================================================================

export interface WakeRestoreGateDeps {
  config?: WakeRestoreGateConfig;
  now?: () => Date;
  alert?: (alert: DaemonHealthAlert) => void | Promise<void>;
}

const WAKE_INTEGRITY_ALERT_DEDUP_KEY = "agent-wake-restore-integrity";

function isFreshVerifiedStamp(
  row: { verification_status: string | null; verified_at: Date | null },
  now: Date,
  freshnessMs: number,
): boolean {
  if (row.verification_status !== "verified" || !(row.verified_at instanceof Date)) return false;
  const ageMs = now.getTime() - row.verified_at.getTime();
  return ageMs >= 0 && ageMs <= freshnessMs;
}

/**
 * Verify one stored row for the wake path, stamping the outcome. Throws on
 * verifier-infrastructure errors AND on payloads the verification budget
 * cannot cover — both are "cannot decide", never "assume broken" or "assume
 * fine", and the thrown error fails the wake job retryably with the sandbox
 * untouched.
 */
async function verifyAndStamp(
  row: StoredAgentSandboxBackup,
  budget: DecryptBudget,
  now: Date,
): Promise<{ ok: boolean; kind?: BackupVerificationFailureKind; message?: string }> {
  const result = await verifyBackupRestorability(row, { budget });
  if (result.skipped) {
    throw new Error(
      `wake restore-integrity gate cannot verify backup ${row.id}: stored payload of ` +
        `${result.skipped.requiredBytes} bytes exceeds the verification budget of ` +
        `${result.skipped.budgetBytes} bytes (BACKUP_VERIFICATION_MAX_DECRYPT_BYTES)`,
    );
  }
  await agentSandboxesRepository.stampBackupVerification(row.id, {
    status: result.ok ? "verified" : "failed",
    verifiedAt: now,
    error: result.ok ? null : `${result.failure?.kind}: ${result.failure?.message}`,
  });
  if (result.ok) return { ok: true };
  const failure = result.failure ?? { kind: "invalid-payload" as const, message: "unknown" };
  return { ok: false, kind: failure.kind, message: failure.message };
}

/**
 * Hunt the retention set for an OLDER backup that validates, so the failure
 * message can offer a concrete `restoreBackupId`. Advisory only: the wake has
 * already failed; a candidate that cannot be checked is skipped, never
 * guessed at.
 */
async function findValidOlderBackup(
  sandboxRecordId: string,
  failedTarget: StoredAgentSandboxBackup,
  budget: DecryptBudget,
  config: WakeRestoreGateConfig,
  now: Date,
): Promise<{ id: string; createdAt: Date } | undefined> {
  const candidates = await agentSandboxesRepository.listBackupMetadata(
    sandboxRecordId,
    config.alternativeScanLimit,
  );
  for (const meta of candidates) {
    if (meta.id === failedTarget.id) continue;
    if (meta.created_at.getTime() >= failedTarget.created_at.getTime()) continue;
    if (meta.verification_status === "failed") continue;
    if (isFreshVerifiedStamp(meta, now, config.verifiedFreshnessMs)) {
      return { id: meta.id, createdAt: meta.created_at };
    }
    const stored = await agentSandboxesRepository.getStoredBackupById(meta.id);
    if (!stored) continue;
    let outcome: Awaited<ReturnType<typeof verifyAndStamp>>;
    try {
      outcome = await verifyAndStamp(stored, budget, now);
    } catch (error) {
      // error-policy:J7 diagnostics-must-not-kill-the-loop — the scan only
      // enriches an already-failed wake's error message; an infra error or
      // budget exhaustion on a CANDIDATE is logged and the candidate skipped.
      // The wake failure itself (and its alert) still surfaces unconditionally.
      logger.warn("[WakeRestoreIntegrity] Could not verify alternative backup candidate", {
        sandboxRecordId,
        candidateBackupId: meta.id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (outcome.ok) return { id: meta.id, createdAt: meta.created_at };
  }
  return undefined;
}

/**
 * Validate the backup a wake is about to restore. Called by `executeWake`
 * BEFORE any provisioning side effect; `requestedBackupId` is the explicit
 * user-selected restore point (wake route `restoreBackupId`), otherwise the
 * latest backup — exactly what `provision()`'s auto-restore would reach for.
 *
 * `now` and `alert` are injectable for tests; production uses the wall clock
 * and the shared provisioning ops alert channel.
 */
export async function runWakeRestoreIntegrityGate(
  params: {
    sandboxRecordId: string;
    agentName?: string | null;
    requestedBackupId?: string;
  },
  deps: WakeRestoreGateDeps = {},
): Promise<WakeRestoreGateResult> {
  const config = deps.config ?? readWakeRestoreGateConfig();
  const alert = deps.alert ?? sendProvisioningWorkerAlert;
  const now = (deps.now ?? (() => new Date()))();

  if (!config.enabled) {
    logger.warn("[WakeRestoreIntegrity] Gate disabled by WAKE_RESTORE_INTEGRITY_ENABLED", {
      sandboxRecordId: params.sandboxRecordId,
    });
    return { ok: true, backupId: params.requestedBackupId ?? null, verification: "disabled" };
  }

  let target: StoredAgentSandboxBackup | undefined;
  if (params.requestedBackupId) {
    target = await agentSandboxesRepository.getStoredBackupById(params.requestedBackupId);
    // A backup belonging to another sandbox is reported exactly like a missing
    // one so backup ids cannot be used as a cross-agent existence oracle.
    if (!target || target.sandbox_record_id !== params.sandboxRecordId) {
      return {
        ok: false,
        failure: {
          backupId: params.requestedBackupId,
          backupCreatedAt: null,
          snapshotType: null,
          kind: "backup-not-found",
          message: "requested backup does not exist for this agent",
        },
      };
    }
  } else {
    target = await agentSandboxesRepository.getLatestStoredBackup(params.sandboxRecordId);
    if (!target) {
      // Nothing durable exists to protect — a wake here boots fresh because
      // fresh is all there ever was, not because state was discarded.
      return { ok: true, backupId: null, verification: "no-backup" };
    }
  }

  const fail = async (
    kind: WakeRestoreFailureKind,
    message: string,
    budget: DecryptBudget,
  ): Promise<WakeRestoreGateResult> => {
    const failure: WakeRestoreIntegrityFailure = {
      backupId: target!.id,
      backupCreatedAt: target!.created_at.toISOString(),
      snapshotType: target!.snapshot_type,
      kind,
      message,
    };
    const alternative = await findValidOlderBackup(
      params.sandboxRecordId,
      target!,
      budget,
      config,
      now,
    );
    if (alternative) {
      failure.alternativeBackupId = alternative.id;
      failure.alternativeBackupCreatedAt = alternative.createdAt.toISOString();
    }
    logger.error("[WakeRestoreIntegrity] Wake blocked: backup failed integrity validation", {
      sandboxRecordId: params.sandboxRecordId,
      agentName: params.agentName ?? undefined,
      backupId: failure.backupId,
      failureKind: failure.kind,
      error: failure.message,
      alternativeBackupId: failure.alternativeBackupId,
    });
    await alert({
      title: `agent wake blocked: backup ${failure.backupId} failed restore-integrity validation`,
      message:
        "A sleeping agent's wake was refused because the backup it would restore is not " +
        "restorable. The sandbox was left sleeping (no state deleted, no fresh boot). The " +
        "user can wake from an older validated backup via restoreBackupId or accept data " +
        "loss via forceFreshBoot; investigate the failed backup before the retention window " +
        "prunes older restore points.",
      details: {
        sandboxRecordId: params.sandboxRecordId,
        agentName: params.agentName ?? undefined,
        backupId: failure.backupId,
        snapshotType: failure.snapshotType,
        failureKind: failure.kind,
        error: failure.message,
        alternativeBackupId: failure.alternativeBackupId ?? null,
      },
      dedupKey: WAKE_INTEGRITY_ALERT_DEDUP_KEY,
    });
    return { ok: false, failure };
  };

  const budget = createDecryptBudget(readBackupVerifierConfig().maxDecryptBytesPerCycle);

  // A `failed` stamp (from the continuous verifier or a previous wake attempt)
  // hard-fails without re-decrypting: the stamp already cost a full KMS +
  // chain-replay verification, and retrying it cannot heal stored bytes.
  if (target.verification_status === "failed") {
    return fail(
      "previously-failed",
      target.verification_error ?? "backup previously failed restorability verification",
      budget,
    );
  }

  if (isFreshVerifiedStamp(target, now, config.verifiedFreshnessMs)) {
    logger.info(
      "[WakeRestoreIntegrity] Backup verified within freshness window; skipping re-verification",
      {
        sandboxRecordId: params.sandboxRecordId,
        backupId: target.id,
        verifiedAt: target.verified_at?.toISOString(),
      },
    );
    return { ok: true, backupId: target.id, verification: "fresh-stamp" };
  }

  const outcome = await verifyAndStamp(target, budget, now);
  if (outcome.ok) {
    logger.info("[WakeRestoreIntegrity] Backup verified for wake restore", {
      sandboxRecordId: params.sandboxRecordId,
      backupId: target.id,
    });
    return { ok: true, backupId: target.id, verification: "verified" };
  }
  return fail(outcome.kind ?? "invalid-payload", outcome.message ?? "unknown", budget);
}
