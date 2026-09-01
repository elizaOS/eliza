/** Exercises the privacy and execution gates of the staging re-review operator with deterministic dependencies. */

import { describe, expect, test } from "bun:test";
import {
  PersonalDedicatedRereviewOperatorError,
  previewDecisionEvidence,
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
  operation: "rereview" as const,
  receiptFingerprint: "a".repeat(64),
  receiptUpdatedAt: "2026-08-30T12:00:00.000Z",
  previousRetainedAgentId: resolved.retainedAgentId,
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
    ).toThrow("selection_bootstrap_no_restore_authority");
    expect(() =>
      resolveBootstrapCandidate(
        candidates.map((candidate) => ({
          ...candidate,
          authority: "catalog-restore-required",
        })),
        (candidate) => candidate.authority,
      ),
    ).toThrow("selection_bootstrap_multiple_restore_authorities");
    expect(() =>
      resolveBootstrapCandidate(
        [candidates[1]],
        (candidate) => candidate.authority,
      ),
    ).toThrow("selection_bootstrap_single_candidate");
    expect(() => resolveBootstrapCandidate([], () => "fresh-boot")).toThrow(
      "selection_bootstrap_zero_candidates",
    );
    expect(() =>
      resolveBootstrapCandidate(
        Array.from({ length: 101 }, (_, index) => ({
          id: String(index),
          authority: index === 0 ? "from-legacy-backup" : "fresh-boot",
        })),
        (candidate) => candidate.authority,
      ),
    ).toThrow("selection_bootstrap_inventory_over_limit");
  });

  test("reports expected preview decisions neutrally without weakening execute", () => {
    const codes = [
      "selection_bootstrap_zero_candidates",
      "selection_bootstrap_single_candidate",
      "selection_bootstrap_inventory_over_limit",
      "selection_bootstrap_no_restore_authority",
      "selection_bootstrap_multiple_restore_authorities",
    ] as const;
    for (const code of codes) {
      expect(previewDecisionEvidence("preview", code)).toEqual({
        schemaVersion: 1,
        mode: "preview",
        decisionRequired: true,
        decisionCode: code,
        computeMutation: false,
        executed: false,
      });
      expect(previewDecisionEvidence("execute", code)).toBeNull();
    }
    expect(
      previewDecisionEvidence("preview", "staging_deploy_commit_mismatch"),
    ).toBeNull();
    expect(previewDecisionEvidence(undefined, codes[0])).toBeNull();
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
    expect(result.approvalDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.approvalDigest).toBe(
      "682dad005890516a420f15f8ebbf693d997ca588192cd073003dab78c112ccc6",
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
      expectedReceiptUpdatedAt: preview.receiptUpdatedAt,
      expectedPreviousRetainedAgentId: preview.previousRetainedAgentId,
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
    await expect(
      runRereviewOperator(
        { ...executeConfig, reviewedReason: "retain_something_else" },
        deps.value,
      ),
    ).rejects.toMatchObject({ code: "reviewed_reason_required" });
  });

  test("uses a distinct digest-bound confirmation for missing-receipt bootstrap", async () => {
    const bootstrapResolved = { ...resolved, operation: "bootstrap" as const };
    const bootstrapPreview = {
      ...preview,
      operation: "bootstrap" as const,
      receiptFingerprint: null,
      receiptUpdatedAt: null,
      previousRetainedAgentId: null,
    };
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
    expect(prior.approvalDigest).toBe(
      "fe92cc0a9931097bdbc5a9ea486dc2b779dd63c91978ae077cd958208796fe17",
    );

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
      expectedReceiptUpdatedAt: null,
      expectedPreviousRetainedAgentId: null,
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

  test("binds every resolved selector and replacement decision into approval", async () => {
    const baseline = await runRereviewOperator(
      config("preview"),
      dependencies().value,
    );
    const changedDependencies = [
      dependencies({
        resolveSelection: async () => ({
          ...resolved,
          organizationId: "10000000-0000-4000-8000-000000000009",
        }),
      }),
      dependencies({
        resolveSelection: async () => ({
          ...resolved,
          userId: "20000000-0000-4000-8000-000000000009",
        }),
      }),
      dependencies({
        resolveSelection: async () => ({
          ...resolved,
          sourceAgentId: "personal-shared-other-source",
        }),
      }),
      dependencies({
        resolveSelection: async () => ({
          ...resolved,
          retainedAgentId: "30000000-0000-4000-8000-000000000009",
        }),
      }),
      dependencies({
        preview: async () => ({ ...preview, replacesTarget: true }),
      }),
    ];

    for (const changed of changedDependencies) {
      const result = await runRereviewOperator(
        config("preview"),
        changed.value,
      );
      expect(result.approvalDigest).not.toBe(baseline.approvalDigest);
    }
  });

  test("rejects a preview for a different operation before snapshot or execute", async () => {
    let snapshots = 0;
    await expect(
      runRereviewOperator(
        config("preview"),
        dependencies({
          preview: async () => ({
            ...preview,
            operation: "bootstrap",
            receiptFingerprint: null,
            receiptUpdatedAt: null,
            previousRetainedAgentId: null,
          }),
          snapshot: async () => {
            snapshots += 1;
            return snapshot;
          },
        }).value,
      ),
    ).rejects.toMatchObject({ code: "selection_operation_changed" });
    expect(snapshots).toBe(0);
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
