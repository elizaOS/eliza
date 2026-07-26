/**
 * Proves the actor-bound rollback-standby decision contract rejects ambiguous
 * backup authority, identity drift, and malformed durable job payloads.
 */

import { describe, expect, test } from "bun:test";
import {
  type AdminCanaryStandbyDecisionJobData,
  assertAdminCanaryStandbyDecisionInput,
  assertAdminCanaryStandbyDecisionJobData,
  isAdminCanaryStandbyDecisionJobData,
  UnconfiguredVerifiedRestorePointReader,
} from "./admin-canary-standby";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const BACKUP_ID = "00000000-0000-4000-8000-000000217183";
const RESTORE_AGGREGATE_SHA256 = "c".repeat(64);
const RESTORE_CANDIDATE_ID = "restore-candidate-217183";

function decisionJobData(
  overrides: Partial<AdminCanaryStandbyDecisionJobData> = {},
): AdminCanaryStandbyDecisionJobData {
  return {
    requestId: "00000000-0000-4000-8000-000000017183",
    sourceJobId: "00000000-0000-4000-8000-000000117183",
    decision: "accept",
    verifiedBackupId: BACKUP_ID,
    restoreValidationId: BACKUP_ID,
    restoreValidationAggregateSha256: RESTORE_AGGREGATE_SHA256,
    restoreValidatedCandidateProviderSandboxId: RESTORE_CANDIDATE_ID,
    standbyGeneration: "00000000-0000-4000-8000-000000117183",
    rolloutId: "00000000-0000-4000-8000-000000317183",
    actorUserId: "00000000-0000-4000-8000-000000417183",
    userId: "00000000-0000-4000-8000-000000417183",
    decisionAt: "2026-07-26T15:00:00.000Z",
    agentId: "00000000-0000-4000-8000-000000517183",
    organizationId: "00000000-0000-4000-8000-000000617183",
    targetOwnerUserId: "00000000-0000-4000-8000-000000717183",
    sourceImage: "ghcr.io/elizaos/eliza:sha-old",
    sourceDigest: DIGEST_A,
    targetImage: `ghcr.io/elizaos/eliza-demo@${DIGEST_B}`,
    targetDigest: DIGEST_B,
    ...overrides,
  };
}

describe("admin canary rollback standby decision contract", () => {
  test("accept requires exact candidate restore proof while reject forbids restore authority", () => {
    expect(() =>
      assertAdminCanaryStandbyDecisionInput({
        requestId: decisionJobData().requestId,
        sourceJobId: decisionJobData().sourceJobId,
        decision: "accept",
      }),
    ).toThrow("accept decisions require verifiedBackupId");

    expect(() =>
      assertAdminCanaryStandbyDecisionInput({
        requestId: decisionJobData().requestId,
        sourceJobId: decisionJobData().sourceJobId,
        decision: "accept",
        verifiedBackupId: BACKUP_ID,
      }),
    ).toThrow("accept decisions require restoreValidationId");

    expect(() =>
      assertAdminCanaryStandbyDecisionInput({
        requestId: decisionJobData().requestId,
        sourceJobId: decisionJobData().sourceJobId,
        decision: "accept",
        verifiedBackupId: BACKUP_ID,
        restoreValidationId: BACKUP_ID,
      }),
    ).toThrow("accept decisions require restoreValidationAggregateSha256");

    expect(() =>
      assertAdminCanaryStandbyDecisionInput({
        requestId: decisionJobData().requestId,
        sourceJobId: decisionJobData().sourceJobId,
        decision: "accept",
        verifiedBackupId: BACKUP_ID,
        restoreValidationId: BACKUP_ID,
        restoreValidationAggregateSha256: RESTORE_AGGREGATE_SHA256,
      }),
    ).toThrow("accept decisions require restoreValidatedCandidateProviderSandboxId");

    expect(() =>
      assertAdminCanaryStandbyDecisionInput({
        requestId: decisionJobData().requestId,
        sourceJobId: decisionJobData().sourceJobId,
        decision: "reject",
        verifiedBackupId: decisionJobData().verifiedBackupId,
      }),
    ).toThrow("reject decisions cannot include restore validation authority");

    expect(() =>
      assertAdminCanaryStandbyDecisionJobData(
        decisionJobData({
          decision: "reject",
          verifiedBackupId: undefined,
          restoreValidationId: undefined,
          restoreValidationAggregateSha256: undefined,
          restoreValidatedCandidateProviderSandboxId: undefined,
        }),
      ),
    ).not.toThrow();

    expect(() =>
      assertAdminCanaryStandbyDecisionInput({
        requestId: decisionJobData().requestId,
        sourceJobId: decisionJobData().sourceJobId,
        decision: "accept",
        verifiedBackupId: BACKUP_ID,
        restoreValidationId: "00000000-0000-4000-8000-000000317183",
        restoreValidationAggregateSha256: RESTORE_AGGREGATE_SHA256,
        restoreValidatedCandidateProviderSandboxId: RESTORE_CANDIDATE_ID,
      }),
    ).toThrow("restoreValidationId must equal verifiedBackupId");
  });

  test("durable data binds actor identity, exact digests, and decision time", () => {
    expect(() =>
      assertAdminCanaryStandbyDecisionJobData(
        decisionJobData({ userId: "00000000-0000-4000-8000-000000817183" }),
      ),
    ).toThrow("userId must equal actorUserId");
    expect(() =>
      assertAdminCanaryStandbyDecisionJobData(decisionJobData({ targetDigest: "latest" })),
    ).toThrow("targetDigest must be sha256");
    expect(() =>
      assertAdminCanaryStandbyDecisionJobData(decisionJobData({ decisionAt: "not-a-date" })),
    ).toThrow("decisionAt must be an ISO timestamp");
  });

  test("the structural guard rejects partial transport records", () => {
    expect(isAdminCanaryStandbyDecisionJobData(decisionJobData())).toBe(true);
    expect(
      isAdminCanaryStandbyDecisionJobData({
        ...decisionJobData(),
        organizationId: undefined,
      }),
    ).toBe(false);
  });

  test("an uncomposed restore-point reader fails closed", async () => {
    await expect(
      new UnconfiguredVerifiedRestorePointReader().assertVerifiedV2CandidateRestoreInTx(
        undefined as never,
        {
          backupId: BACKUP_ID,
          restoreValidationId: BACKUP_ID,
          restoreValidationAggregateSha256: RESTORE_AGGREGATE_SHA256,
          restoreValidatedCandidateProviderSandboxId: RESTORE_CANDIDATE_ID,
          organizationId: decisionJobData().organizationId,
          sandboxRecordId: decisionJobData().agentId,
          agentId: decisionJobData().agentId,
          targetOwnerUserId: decisionJobData().targetOwnerUserId,
          targetImage: decisionJobData().targetImage,
          targetDigest: decisionJobData().targetDigest,
          neverRouted: true,
          snapshotType: "pre-upgrade",
          schemaVersion: 2,
          verificationStatus: "verified",
          descriptorCommitState: "complete",
          restoreReceiptState: "committed",
        },
      ),
    ).rejects.toThrow("Verified v2 candidate-restore reader is not configured");
  });
});
