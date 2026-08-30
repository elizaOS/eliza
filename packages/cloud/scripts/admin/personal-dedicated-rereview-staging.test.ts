/** Exercises the privacy and execution gates of the staging re-review operator with deterministic dependencies. */

import { describe, expect, test } from "bun:test";
import {
  PersonalDedicatedRereviewOperatorError,
  type RereviewOperatorConfig,
  type RereviewOperatorDependencies,
  readRereviewOperatorConfig,
  resolveBootstrapCandidate,
  resolveReceiptRow,
  runRereviewOperator,
} from "./personal-dedicated-rereview-staging";

const resolved = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  userId: "20000000-0000-4000-8000-000000000002",
  sourceAgentId: "personal-shared-private-source",
  retainedAgentId: "30000000-0000-4000-8000-000000000003",
  operation: "rereview" as const,
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
  let executedInput:
    | Parameters<RereviewOperatorDependencies["execute"]>[0]
    | undefined;
  const value: RereviewOperatorDependencies = {
    verifyDeployment: async () => {},
    resolveSelection: async () => resolved,
    preview: async () => preview,
    execute: async (input) => {
      executeCalls += 1;
      executedInput = input;
    },
    snapshot: async () => snapshot,
    ...overrides,
  };
  return {
    value,
    executeCalls: () => executeCalls,
    executedInput: () => executedInput,
  };
}

describe("personal Dedicated staging re-review operator", () => {
  test("classifies zero, one, and invariant-breaking receipt counts", () => {
    expect(resolveReceiptRow([])).toBeNull();
    expect(resolveReceiptRow([{ retainedAgentId: "retained" }])).toEqual({
      retainedAgentId: "retained",
    });
    expect(() =>
      resolveReceiptRow([
        { retainedAgentId: "first" },
        { retainedAgentId: "second" },
      ]),
    ).toThrow("selection_receipt_invariant_violated");
  });

  test("bootstraps only one canonical restore authority in ambiguous inventory", () => {
    const candidates = [
      { id: "fresh", authority: "fresh-boot" },
      { id: "restorable", authority: "from-legacy-backup" },
    ];
    expect(
      resolveBootstrapCandidate(candidates, (candidate) => candidate.authority),
    ).toEqual(candidates[1]);
    expect(() =>
      resolveBootstrapCandidate(
        candidates.map((candidate) => ({
          ...candidate,
          authority: "fresh-boot",
        })),
        (candidate) => candidate.authority,
      ),
    ).toThrow("selection_bootstrap_decision_required");
    expect(() =>
      resolveBootstrapCandidate(
        candidates.map((candidate) => ({
          ...candidate,
          authority: "catalog-restore-required",
        })),
        (candidate) => candidate.authority,
      ),
    ).toThrow("selection_bootstrap_decision_required");
    expect(() =>
      resolveBootstrapCandidate(
        [candidates[1]],
        (candidate) => candidate.authority,
      ),
    ).toThrow("selection_bootstrap_decision_required");
  });

  test("returns identifier-free preview evidence and does not execute", async () => {
    const deps = dependencies();
    const result = await runRereviewOperator(config("preview"), deps.value);
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      mode: "preview",
      identityResolved: true,
      candidateCount: 2,
      requiredReviewedReason:
        "retain_current_receipt_target_after_duplicate_inventory_review",
      requiredConfirmation: "REREVIEW_STALE_SELECTION_WITHOUT_COMPUTE_MUTATION",
      computeMutation: false,
      executed: false,
    });
    expect(result.approvalDigest).toBe(
      "86e1e6cfcbf44c955692befd07da569116c9dc04b69703f067aca3c65a36eedd",
    );
    expect(deps.executeCalls()).toBe(0);
    for (const privateValue of [
      resolved.organizationId,
      resolved.userId,
      resolved.sourceAgentId,
      resolved.retainedAgentId,
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
    expect(deps.executedInput()).toMatchObject({
      operation: "rereview",
      expectedReceiptFingerprint: preview.receiptFingerprint,
    });

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

  test("uses a distinct digest-bound confirmation for missing-receipt bootstrap", async () => {
    const bootstrapResolved = { ...resolved, operation: "bootstrap" as const };
    const bootstrapPreview = { ...preview, receiptFingerprint: null };
    const deps = dependencies({
      resolveSelection: async () => bootstrapResolved,
      preview: async () => bootstrapPreview,
    });
    const prior = await runRereviewOperator(config("preview"), deps.value);
    expect(prior).toMatchObject({
      operation: "bootstrap",
      requiredReviewedReason:
        "select_unique_verified_backup_after_duplicate_inventory_review",
      requiredConfirmation:
        "SELECT_UNIQUE_VERIFIED_BACKUP_WITHOUT_COMPUTE_MUTATION",
    });

    const result = await runRereviewOperator(
      {
        ...config("execute"),
        approvalDigest: prior.approvalDigest,
        confirmation: "SELECT_UNIQUE_VERIFIED_BACKUP_WITHOUT_COMPUTE_MUTATION",
        reviewedReason:
          "select_unique_verified_backup_after_duplicate_inventory_review",
      },
      deps.value,
    );
    expect(result.executed).toBe(true);
    expect(deps.executeCalls()).toBe(1);
    expect(deps.executedInput()).toMatchObject({
      operation: "bootstrap",
      expectedReceiptFingerprint: null,
      expectedInventoryFingerprint: preview.inventoryFingerprint,
      expectedStateDisposition: preview.stateDisposition,
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
