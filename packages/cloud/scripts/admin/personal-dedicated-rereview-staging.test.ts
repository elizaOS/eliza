/** Exercises the privacy and execution gates of the staging re-review operator with deterministic dependencies. */

import { describe, expect, test } from "bun:test";
import {
  PersonalDedicatedRereviewOperatorError,
  type RereviewOperatorConfig,
  type RereviewOperatorDependencies,
  readRereviewOperatorConfig,
  runRereviewOperator,
} from "./personal-dedicated-rereview-staging";

const resolved = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  userId: "20000000-0000-4000-8000-000000000002",
  sourceAgentId: "personal-shared-private-source",
  retainedAgentId: "30000000-0000-4000-8000-000000000003",
};
const preview = {
  receiptFingerprint: "a".repeat(64),
  inventoryFingerprint: "b".repeat(64),
  stateDisposition: "fresh_boot_no_verified_backup" as const,
  candidateCount: 2,
  replacesTarget: false,
};
const snapshot = {
  agentCount: 2,
  agentDigest: "c".repeat(64),
  jobCount: 0,
  jobDigest: "d".repeat(64),
};

function config(mode: "preview" | "execute"): RereviewOperatorConfig {
  return {
    mode,
    apiKey: "eliza_private_smoke_key",
    expectedCloudCommit: "e".repeat(40),
  };
}

function dependencies(overrides: Partial<RereviewOperatorDependencies> = {}) {
  let executeCalls = 0;
  const value: RereviewOperatorDependencies = {
    verifyDeployment: async () => {},
    resolveSelection: async () => resolved,
    preview: async () => preview,
    execute: async () => {
      executeCalls += 1;
    },
    snapshot: async () => snapshot,
    ...overrides,
  };
  return { value, executeCalls: () => executeCalls };
}

describe("personal Dedicated staging re-review operator", () => {
  test("returns identifier-free preview evidence and does not execute", async () => {
    const deps = dependencies();
    const result = await runRereviewOperator(config("preview"), deps.value);
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      mode: "preview",
      identityResolved: true,
      candidateCount: 2,
      computeMutation: false,
      executed: false,
    });
    expect(result.approvalDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(deps.executeCalls()).toBe(0);
    for (const privateValue of [
      ...Object.values(resolved),
      preview.receiptFingerprint,
      preview.inventoryFingerprint,
      config("preview").apiKey,
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  test("requires the prior exact preview digest and reviewed confirmation", async () => {
    const deps = dependencies();
    const prior = await runRereviewOperator(config("preview"), deps.value);
    const executeConfig = {
      ...config("execute"),
      approvalDigest: prior.approvalDigest,
      confirmation: "REREVIEW_STALE_SELECTION_WITHOUT_COMPUTE_MUTATION",
      reviewedReason:
        "retain_current_receipt_target_after_duplicate_inventory_review",
    };

    const result = await runRereviewOperator(executeConfig, deps.value);
    expect(result.executed).toBe(true);
    expect(deps.executeCalls()).toBe(1);

    await expect(
      runRereviewOperator(
        { ...executeConfig, approvalDigest: "f".repeat(64) },
        deps.value,
      ),
    ).rejects.toMatchObject({ code: "stale_or_wrong_approval_digest" });
    await expect(
      runRereviewOperator(
        { ...executeConfig, confirmation: "yes" },
        deps.value,
      ),
    ).rejects.toMatchObject({ code: "exact_confirmation_required" });
  });

  test("binds approval to current inventory and refuses compute or job drift", async () => {
    const first = dependencies();
    const prior = await runRereviewOperator(config("preview"), first.value);
    const driftedPreview = dependencies({
      preview: async () => ({ ...preview, candidateCount: 3 }),
    });
    await expect(
      runRereviewOperator(
        {
          ...config("execute"),
          approvalDigest: prior.approvalDigest,
          confirmation: "REREVIEW_STALE_SELECTION_WITHOUT_COMPUTE_MUTATION",
          reviewedReason:
            "retain_current_receipt_target_after_duplicate_inventory_review",
        },
        driftedPreview.value,
      ),
    ).rejects.toMatchObject({ code: "stale_or_wrong_approval_digest" });

    let snapshots = 0;
    const mutation = dependencies({
      snapshot: async () => {
        snapshots += 1;
        return snapshots === 1 ? snapshot : { ...snapshot, jobCount: 1 };
      },
    });
    await expect(
      runRereviewOperator(config("preview"), mutation.value),
    ).rejects.toMatchObject({
      code: "compute_or_job_state_changed",
    });
  });

  test("rejects deployment mismatch before resolving account identity", async () => {
    let resolvedAccount = false;
    const deps = dependencies({
      verifyDeployment: async () => {
        throw new PersonalDedicatedRereviewOperatorError(
          "staging_deploy_commit_mismatch",
        );
      },
      resolveSelection: async () => {
        resolvedAccount = true;
        return resolved;
      },
    });
    await expect(
      runRereviewOperator(config("preview"), deps.value),
    ).rejects.toMatchObject({
      code: "staging_deploy_commit_mismatch",
    });
    expect(resolvedAccount).toBe(false);
  });

  test("requires explicit staging opt-in and validates execute authority inputs", () => {
    expect(() => readRereviewOperatorConfig({})).toThrow(
      "explicit_staging_opt_in_required",
    );
    const parsed = readRereviewOperatorConfig({
      ELIZA_PERSONAL_DEDICATED_REREVIEW_STAGING: "1",
      ELIZA_PERSONAL_DEDICATED_REREVIEW_MODE: "execute",
      ELIZA_PERSONAL_DEDICATED_REREVIEW_EXPECTED_CLOUD_COMMIT: "e".repeat(40),
      ELIZAOS_CLOUD_API_KEY: "private",
      ELIZA_PERSONAL_DEDICATED_REREVIEW_APPROVAL_DIGEST: "a".repeat(64),
      ELIZA_PERSONAL_DEDICATED_REREVIEW_CONFIRMATION:
        "REREVIEW_STALE_SELECTION_WITHOUT_COMPUTE_MUTATION",
      ELIZA_PERSONAL_DEDICATED_REREVIEW_REVIEWED_REASON:
        "retain_current_receipt_target_after_duplicate_inventory_review",
    });
    expect(parsed.mode).toBe("execute");
  });
});
