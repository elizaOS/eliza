/**
 * Proves rollback-standby decisions carry actor intent while restore authority
 * is resolved from durable server state inside the lifecycle transaction.
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

function decisionJobData(
  overrides: Partial<AdminCanaryStandbyDecisionJobData> = {},
): AdminCanaryStandbyDecisionJobData {
  return {
    requestId: "00000000-0000-4000-8000-000000017183",
    sourceJobId: "00000000-0000-4000-8000-000000117183",
    decision: "accept",
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
  test("accept and reject carry intent without caller-supplied restore authority", () => {
    expect(() =>
      assertAdminCanaryStandbyDecisionInput({
        requestId: decisionJobData().requestId,
        sourceJobId: decisionJobData().sourceJobId,
        decision: "accept",
      }),
    ).not.toThrow();

    expect(() =>
      assertAdminCanaryStandbyDecisionInput({
        requestId: decisionJobData().requestId,
        sourceJobId: decisionJobData().sourceJobId,
        decision: "reject",
      }),
    ).not.toThrow();

    const durableData = decisionJobData();
    expect(durableData).not.toHaveProperty("verifiedBackupId");
    expect(durableData).not.toHaveProperty("restoreValidationId");
    expect(durableData).not.toHaveProperty("restoreValidationAggregateSha256");
    expect(durableData).not.toHaveProperty("restoreValidatedCandidateProviderSandboxId");
    expect(durableData).not.toHaveProperty("restoreValidatedCandidateReplacementAttemptId");
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
      new UnconfiguredVerifiedRestorePointReader().readVerifiedV2CandidateRestoreInTx(
        undefined as never,
        {
          sourceJobId: decisionJobData().sourceJobId,
          standbyGeneration: decisionJobData().standbyGeneration,
          rolloutId: decisionJobData().rolloutId,
          organizationId: decisionJobData().organizationId,
          sandboxRecordId: decisionJobData().agentId,
          agentId: decisionJobData().agentId,
          targetOwnerUserId: decisionJobData().targetOwnerUserId,
          targetImage: decisionJobData().targetImage,
          targetDigest: decisionJobData().targetDigest,
        },
      ),
    ).rejects.toThrow("Verified v2 candidate-restore reader is not configured");
  });
});
