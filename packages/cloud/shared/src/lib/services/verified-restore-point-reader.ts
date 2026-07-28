/**
 * Reads the durable proof that an exact replacement attempt restored a
 * verified v2 backup and was retired before it ever became routable. Standby
 * acceptance calls this reader inside its lifecycle transaction so no caller
 * assertion can substitute for the server-owned receipt and backup records.
 */

import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import {
  agentSandboxBackups,
  agentSnapshotRestoreValidations,
} from "../../db/schemas/agent-sandboxes";
import type {
  VerifiedRestorePointAuthority,
  VerifiedRestorePointReader,
} from "./admin-canary-standby";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROVIDER_SANDBOX_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

type VerifiedRestorePointParams = Parameters<
  VerifiedRestorePointReader["readVerifiedV2CandidateRestoreInTx"]
>[1];

function invalidRestorePoint(
  params: VerifiedRestorePointParams,
  mismatch: string,
  cause?: unknown,
): ElizaError {
  return new ElizaError("Verified candidate restore point is invalid", {
    code: "ADMIN_CANARY_VERIFIED_RESTORE_POINT_INVALID",
    cause,
    context: {
      mismatch,
      sourceJobId: params.sourceJobId,
      standbyGeneration: params.standbyGeneration,
      rolloutId: params.rolloutId,
      organizationId: params.organizationId,
      sandboxRecordId: params.sandboxRecordId,
      agentId: params.agentId,
    },
    severity: "fatal",
  });
}

function assertMatch(
  condition: boolean,
  params: VerifiedRestorePointParams,
  mismatch: string,
): asserts condition {
  if (!condition) {
    throw invalidRestorePoint(params, mismatch);
  }
}

function isDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * Verifies one committed restore receipt and its exact source backup without
 * leaving the caller's lifecycle transaction.
 */
export class PostgresVerifiedRestorePointReader implements VerifiedRestorePointReader {
  async readVerifiedV2CandidateRestoreInTx(
    tx: DbTransaction,
    params: VerifiedRestorePointParams,
  ): Promise<VerifiedRestorePointAuthority> {
    let rows: Array<{
      validation: typeof agentSnapshotRestoreValidations.$inferSelect;
      backup: typeof agentSandboxBackups.$inferSelect;
    }>;
    try {
      rows = await tx
        .select({
          validation: agentSnapshotRestoreValidations,
          backup: agentSandboxBackups,
        })
        .from(agentSnapshotRestoreValidations)
        .innerJoin(
          agentSandboxBackups,
          and(
            eq(agentSandboxBackups.id, agentSnapshotRestoreValidations.backup_id),
            eq(
              agentSandboxBackups.sandbox_record_id,
              agentSnapshotRestoreValidations.sandbox_record_id,
            ),
          ),
        )
        .where(
          and(
            eq(agentSnapshotRestoreValidations.source_job_id, params.sourceJobId),
            eq(agentSnapshotRestoreValidations.standby_generation, params.standbyGeneration),
            eq(agentSnapshotRestoreValidations.organization_id, params.organizationId),
            eq(agentSnapshotRestoreValidations.sandbox_record_id, params.sandboxRecordId),
          ),
        )
        .limit(2);
    } catch (cause) {
      // error-policy:J2 Preserve the database cause while adding the restore authority identifiers.
      throw invalidRestorePoint(params, "database_query_failed", cause);
    }

    assertMatch(rows.length === 1, params, "restore_validation_cardinality");
    const { validation, backup } = rows[0];

    assertMatch(validation.source_job_id === params.sourceJobId, params, "source_job_id");
    assertMatch(validation.standby_generation === params.standbyGeneration, params, "generation");
    assertMatch(validation.rollout_id === params.rolloutId, params, "rollout_id");
    assertMatch(validation.organization_id === params.organizationId, params, "organization_id");
    assertMatch(
      validation.sandbox_record_id === params.sandboxRecordId,
      params,
      "sandbox_record_id",
    );
    assertMatch(validation.agent_id === params.agentId, params, "agent_id");
    assertMatch(
      validation.target_owner_user_id === params.targetOwnerUserId,
      params,
      "target_owner_user_id",
    );
    assertMatch(validation.target_image === params.targetImage, params, "target_image");
    assertMatch(validation.target_digest === params.targetDigest, params, "target_digest");
    assertMatch(validation.validation_state === "never_routed_retired", params, "validation_state");
    assertMatch(
      validation.candidate_route_mode === "restore_validation_private_control",
      params,
      "candidate_route_mode",
    );
    assertMatch(
      typeof validation.aggregate_sha256 === "string" &&
        SHA256_PATTERN.test(validation.aggregate_sha256),
      params,
      "aggregate_format",
    );
    assertMatch(SHA256_PATTERN.test(validation.capture_nonce), params, "capture_nonce_format");
    assertMatch(
      Number.isSafeInteger(validation.source_environment_revision) &&
        validation.source_environment_revision >= 0,
      params,
      "source_environment_revision",
    );
    assertMatch(
      IMAGE_DIGEST_PATTERN.test(validation.source_image_digest),
      params,
      "source_image_digest",
    );
    assertMatch(UUID_PATTERN.test(validation.source_sandbox_id), params, "source_sandbox_id");
    assertMatch(
      IMAGE_DIGEST_PATTERN.test(validation.target_digest),
      params,
      "target_digest_format",
    );
    assertMatch(
      typeof validation.target_provider_sandbox_id === "string" &&
        PROVIDER_SANDBOX_ID_PATTERN.test(validation.target_provider_sandbox_id),
      params,
      "target_provider_sandbox_id_format",
    );
    assertMatch(
      typeof validation.target_replacement_attempt_id === "string" &&
        UUID_PATTERN.test(validation.target_replacement_attempt_id),
      params,
      "target_replacement_attempt_id_format",
    );
    assertMatch(
      typeof validation.target_provider_node_id === "string" &&
        validation.target_provider_node_id.length > 0,
      params,
      "target_provider_node_id",
    );
    assertMatch(
      typeof validation.target_provider_container_name === "string" &&
        validation.target_provider_container_name.length > 0,
      params,
      "target_provider_container_name",
    );
    assertMatch(
      typeof validation.target_provider_volume_path === "string" &&
        validation.target_provider_volume_path.length > 0,
      params,
      "target_provider_volume_path",
    );
    assertMatch(
      typeof validation.target_provider_vpn_node_id === "string" &&
        validation.target_provider_vpn_node_id.length > 0,
      params,
      "target_provider_vpn_node_id",
    );

    assertMatch(validation.receipt_state === "committed", params, "receipt_state");
    assertMatch(validation.receipt_schema_version === 2, params, "receipt_schema_version");
    assertMatch(validation.receipt_transfer === "chunked-v1", params, "receipt_transfer");
    assertMatch(
      typeof validation.receipt_file_count === "number" &&
        Number.isSafeInteger(validation.receipt_file_count) &&
        validation.receipt_file_count >= 0,
      params,
      "receipt_file_count",
    );
    assertMatch(
      typeof validation.receipt_total_bytes === "number" &&
        Number.isSafeInteger(validation.receipt_total_bytes) &&
        validation.receipt_total_bytes >= 0,
      params,
      "receipt_total_bytes",
    );
    assertMatch(validation.receipt_requires_restart === true, params, "receipt_requires_restart");
    assertMatch(validation.receipt_success === true, params, "receipt_success");
    assertMatch(isDate(validation.receipt_committed_at), params, "receipt_committed_at");
    assertMatch(validation.route_exposed_at === null, params, "route_exposed_at");
    assertMatch(
      isDate(validation.candidate_container_absent_at),
      params,
      "candidate_container_absent_at",
    );
    assertMatch(isDate(validation.candidate_vpn_absent_at), params, "candidate_vpn_absent_at");
    assertMatch(
      isDate(validation.candidate_volume_absent_at),
      params,
      "candidate_volume_absent_at",
    );
    assertMatch(isDate(validation.candidate_retired_at), params, "candidate_retired_at");
    assertMatch(
      validation.candidate_retired_at.getTime() >= validation.receipt_committed_at.getTime(),
      params,
      "candidate_retired_before_receipt",
    );

    assertMatch(backup.id === validation.backup_id, params, "joined_backup_id");
    assertMatch(
      backup.sandbox_record_id === params.sandboxRecordId,
      params,
      "joined_backup_sandbox",
    );
    assertMatch(backup.snapshot_type === "pre-upgrade", params, "snapshot_type");
    assertMatch(backup.snapshot_schema_version === 2, params, "snapshot_schema_version");
    assertMatch(backup.verification_status === "verified", params, "verification_status");
    assertMatch(isDate(backup.verified_at), params, "verified_at");
    assertMatch(backup.verification_error === null, params, "verification_error");
    assertMatch(backup.storage_commit_state === "complete", params, "storage_commit_state");
    assertMatch(backup.content_hash === validation.aggregate_sha256, params, "backup_content_hash");

    return {
      verifiedBackupId: validation.backup_id,
      restoreValidationId: validation.restore_validation_id,
      restoreValidationAggregateSha256: validation.aggregate_sha256,
      restoreValidatedCandidateProviderSandboxId: validation.target_provider_sandbox_id,
      restoreValidatedCandidateReplacementAttemptId: validation.target_replacement_attempt_id,
      receiptCommittedAt: validation.receipt_committed_at,
      candidateContainerAbsentAt: validation.candidate_container_absent_at,
      candidateVpnAbsentAt: validation.candidate_vpn_absent_at,
      candidateVolumeAbsentAt: validation.candidate_volume_absent_at,
      candidateRetiredAt: validation.candidate_retired_at,
    };
  }
}
