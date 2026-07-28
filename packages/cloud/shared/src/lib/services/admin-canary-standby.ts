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
}

export interface AdminCanaryStandbyDecisionJobData {
  requestId: string;
  sourceJobId: string;
  decision: AdminCanaryStandbyDecision;
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
  startedAt: string;
  finishedAt: string;
}

export interface VerifiedRestorePointAuthority {
  verifiedBackupId: string;
  restoreValidationId: string;
  restoreValidationAggregateSha256: string;
  restoreValidatedCandidateProviderSandboxId: string;
  restoreValidatedCandidateReplacementAttemptId: string;
  receiptCommittedAt: Date;
  candidateContainerAbsentAt: Date;
  candidateVpnAbsentAt: Date;
  candidateVolumeAbsentAt: Date;
  candidateRetiredAt: Date;
}

export interface VerifiedRestorePointReader {
  readVerifiedV2CandidateRestoreInTx(
    tx: DbTransaction,
    params: {
      sourceJobId: string;
      standbyGeneration: string;
      rolloutId: string;
      organizationId: string;
      sandboxRecordId: string;
      agentId: string;
      targetOwnerUserId: string;
      targetImage: string;
      targetDigest: string;
    },
  ): Promise<VerifiedRestorePointAuthority>;
}

export class UnconfiguredVerifiedRestorePointReader implements VerifiedRestorePointReader {
  async readVerifiedV2CandidateRestoreInTx(): Promise<VerifiedRestorePointAuthority> {
    throw new Error("Verified v2 candidate-restore reader is not configured");
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
  return requiredStrings.every((field) => typeof data[field] === "string");
}

export function assertAdminCanaryStandbyDecisionJobData(
  data: AdminCanaryStandbyDecisionJobData,
): void {
  assertAdminCanaryStandbyDecisionInput({
    requestId: data.requestId,
    sourceJobId: data.sourceJobId,
    decision: data.decision,
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
