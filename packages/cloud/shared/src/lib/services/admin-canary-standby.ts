/**
 * Defines actor-bound decisions for a retained admin-canary rollback standby.
 *
 * Acceptance is split from image cutover because the old runtime remains the
 * rollback authority until both the new runtime and its v2 restore point have
 * been independently verified. The backup implementation plugs into the
 * narrow reader contract below without coupling lifecycle code to backup
 * storage internals.
 */

import type { DbTransaction } from "../../db/client";
import { ValidationError } from "../api/cloud-worker-errors";
import { assertAdminCanaryRequestId, assertSha256Digest, assertUuid } from "./admin-canary-image";

export type AdminCanaryStandbyDecision = "accept" | "reject";

export interface AdminCanaryStandbyDecisionInput {
  requestId: string;
  sourceJobId: string;
  decision: AdminCanaryStandbyDecision;
  verifiedBackupId?: string;
  restoreValidationId?: string;
  restoreValidationAggregateSha256?: string;
  restoreValidatedCandidateProviderSandboxId?: string;
}

export interface AdminCanaryStandbyDecisionJobData {
  requestId: string;
  sourceJobId: string;
  decision: AdminCanaryStandbyDecision;
  verifiedBackupId?: string;
  restoreValidationId?: string;
  restoreValidationAggregateSha256?: string;
  restoreValidatedCandidateProviderSandboxId?: string;
  standbyGeneration: string;
  rolloutId: string;
  actorUserId: string;
  userId: string;
  decisionAt: string;
  agentId: string;
  organizationId: string;
  targetOwnerUserId: string;
  sourceImage: string;
  sourceDigest: string;
  targetImage: string;
  targetDigest: string;
}

export interface AdminCanaryStandbyDecisionJobResult {
  success: true;
  decision: AdminCanaryStandbyDecision;
  outcome: "accepted" | "rolled_back";
  requestId: string;
  sourceJobId: string;
  decisionJobId: string;
  standbyGeneration: string;
  rolloutId: string;
  actorUserId: string;
  agentId: string;
  organizationId: string;
  targetImage: string;
  targetDigest: string;
  verifiedBackupId?: string;
  restoreValidationId?: string;
  restoreValidationAggregateSha256?: string;
  restoreValidatedCandidateProviderSandboxId?: string;
  startedAt: string;
  finishedAt: string;
}

export interface VerifiedRestorePointReader {
  assertVerifiedV2CandidateRestoreInTx(
    tx: DbTransaction,
    params: {
      backupId: string;
      restoreValidationId: string;
      restoreValidationAggregateSha256: string;
      restoreValidatedCandidateProviderSandboxId: string;
      organizationId: string;
      sandboxRecordId: string;
      agentId: string;
      targetOwnerUserId: string;
      targetImage: string;
      targetDigest: string;
      neverRouted: true;
      snapshotType: "pre-upgrade";
      schemaVersion: 2;
      verificationStatus: "verified";
      descriptorCommitState: "complete";
      restoreReceiptState: "committed";
    },
  ): Promise<void>;
}

export class UnconfiguredVerifiedRestorePointReader implements VerifiedRestorePointReader {
  async assertVerifiedV2CandidateRestoreInTx(): Promise<void> {
    throw new Error("Verified v2 candidate-restore reader is not configured");
  }
}

function assertSha256Hex(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw ValidationError(`${field} must be 64 lowercase hexadecimal characters`);
  }
}

export function assertAdminCanaryStandbyDecisionInput(
  input: AdminCanaryStandbyDecisionInput,
): void {
  assertAdminCanaryRequestId(input.requestId);
  assertUuid(input.sourceJobId, "sourceJobId");
  if (input.decision !== "accept" && input.decision !== "reject") {
    throw ValidationError("decision must be accept or reject");
  }
  if (input.decision === "accept") {
    if (!input.verifiedBackupId) {
      throw ValidationError("accept decisions require verifiedBackupId");
    }
    if (!input.restoreValidationId) {
      throw ValidationError("accept decisions require restoreValidationId");
    }
    if (!input.restoreValidationAggregateSha256) {
      throw ValidationError("accept decisions require restoreValidationAggregateSha256");
    }
    if (!input.restoreValidatedCandidateProviderSandboxId?.trim()) {
      throw ValidationError("accept decisions require restoreValidatedCandidateProviderSandboxId");
    }
    assertUuid(input.verifiedBackupId, "verifiedBackupId");
    assertUuid(input.restoreValidationId, "restoreValidationId");
    if (input.restoreValidationId !== input.verifiedBackupId) {
      throw ValidationError("restoreValidationId must equal verifiedBackupId");
    }
    assertSha256Hex(input.restoreValidationAggregateSha256, "restoreValidationAggregateSha256");
  } else if (
    input.verifiedBackupId !== undefined ||
    input.restoreValidationId !== undefined ||
    input.restoreValidationAggregateSha256 !== undefined ||
    input.restoreValidatedCandidateProviderSandboxId !== undefined
  ) {
    throw ValidationError("reject decisions cannot include restore validation authority");
  }
}

export function isAdminCanaryStandbyDecisionJobData(
  value: unknown,
): value is AdminCanaryStandbyDecisionJobData {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Record<string, unknown>;
  if (data.decision !== "accept" && data.decision !== "reject") return false;
  const requiredStrings = [
    "requestId",
    "sourceJobId",
    "standbyGeneration",
    "rolloutId",
    "actorUserId",
    "userId",
    "decisionAt",
    "agentId",
    "organizationId",
    "targetOwnerUserId",
    "sourceImage",
    "sourceDigest",
    "targetImage",
    "targetDigest",
  ] as const;
  return (
    requiredStrings.every((field) => typeof data[field] === "string") &&
    (data.verifiedBackupId === undefined || typeof data.verifiedBackupId === "string") &&
    (data.restoreValidationId === undefined || typeof data.restoreValidationId === "string") &&
    (data.restoreValidationAggregateSha256 === undefined ||
      typeof data.restoreValidationAggregateSha256 === "string") &&
    (data.restoreValidatedCandidateProviderSandboxId === undefined ||
      typeof data.restoreValidatedCandidateProviderSandboxId === "string")
  );
}

export function assertAdminCanaryStandbyDecisionJobData(
  data: AdminCanaryStandbyDecisionJobData,
): void {
  assertAdminCanaryStandbyDecisionInput({
    requestId: data.requestId,
    sourceJobId: data.sourceJobId,
    decision: data.decision,
    ...(data.verifiedBackupId ? { verifiedBackupId: data.verifiedBackupId } : {}),
    ...(data.restoreValidationId ? { restoreValidationId: data.restoreValidationId } : {}),
    ...(data.restoreValidationAggregateSha256
      ? { restoreValidationAggregateSha256: data.restoreValidationAggregateSha256 }
      : {}),
    ...(data.restoreValidatedCandidateProviderSandboxId
      ? {
          restoreValidatedCandidateProviderSandboxId:
            data.restoreValidatedCandidateProviderSandboxId,
        }
      : {}),
  });
  assertUuid(data.standbyGeneration, "standbyGeneration");
  assertUuid(data.rolloutId, "rolloutId");
  assertUuid(data.actorUserId, "actorUserId");
  assertUuid(data.userId, "userId");
  assertUuid(data.agentId, "agentId");
  assertUuid(data.organizationId, "organizationId");
  assertUuid(data.targetOwnerUserId, "targetOwnerUserId");
  assertSha256Digest(data.sourceDigest, "sourceDigest");
  assertSha256Digest(data.targetDigest, "targetDigest");
  if (data.userId !== data.actorUserId) {
    throw ValidationError("userId must equal actorUserId");
  }
  if (!Number.isFinite(Date.parse(data.decisionAt))) {
    throw ValidationError("decisionAt must be an ISO timestamp");
  }
}
