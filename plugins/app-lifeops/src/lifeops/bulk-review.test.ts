import { describe, expect, it, vi } from "vitest";

import {
  bindCleanupPlanHash,
  type CleanupAdapterChunkRequest,
  type CleanupConfirmationInput,
  type CleanupItemSnapshot,
  type CleanupOperation,
  type CleanupOperationAdapter,
  type CleanupPlan,
  type CleanupPlanDraftItem,
  type CleanupPlanItem,
  type CleanupProvider,
  type CleanupSelectedItemSnapshot,
  type CleanupUndoAdapterChunkRequest,
  executeCleanupPlan,
  getCleanupItemKey,
  getCleanupUndoEligibility,
  undoCleanupExecution,
} from "./bulk-review.js";

const NOW = "2026-05-03T18:00:00.000Z";
const OWNER_ID = "owner-user";

function snapshot(
  provider: CleanupProvider,
  itemId: string,
  overrides: Partial<CleanupItemSnapshot> = {},
): CleanupItemSnapshot {
  return {
    provider,
    itemId,
    accountId: `${provider}-account`,
    displayName: `${provider} ${itemId}`,
    etag: `etag-${itemId}`,
    revisionId: `rev-${itemId}`,
    updatedAt: "2026-05-03T12:00:00.000Z",
    metadata: { source: "unit-test" },
    ...overrides,
  };
}

const markReadOperation: CleanupOperation = {
  kind: "gmail.mark_read",
  risk: "non_destructive",
  reason: "Already handled by the user",
  requiresUserApproval: false,
  undoSupported: false,
};

const archiveOperation: CleanupOperation = {
  kind: "gmail.archive",
  risk: "reversible",
  reason: "Low-value inbox clutter",
  requiresUserApproval: false,
  undoSupported: true,
};

const trashOperation: CleanupOperation = {
  kind: "gmail.trash",
  risk: "destructive",
  reason: "Confirmed spam",
  requiresUserApproval: true,
  undoSupported: true,
};

const driveTrashOperation: CleanupOperation = {
  kind: "drive.trash",
  risk: "destructive",
  reason: "Duplicate Drive file",
  requiresUserApproval: true,
  undoSupported: true,
};

function draftItem(
  itemSnapshot: CleanupItemSnapshot,
  operation: CleanupOperation = markReadOperation,
): CleanupPlanDraftItem {
  return {
    snapshot: itemSnapshot,
    operation,
    evidence: [`matched ${itemSnapshot.displayName}`],
  };
}

async function cleanupPlan(
  items: readonly CleanupPlanDraftItem[],
): Promise<CleanupPlan> {
  return bindCleanupPlanHash({
    id: "cleanup-plan-1",
    ownerUserId: OWNER_ID,
    createdAt: "2026-05-03T17:50:00.000Z",
    expiresAt: "2026-05-03T19:00:00.000Z",
    source: "mixed",
    title: "Bulk cleanup",
    summary: "Review clutter before cleanup",
    clusters: [
      {
        id: "cluster-1",
        title: "Low-value items",
        rationale: "Items match the cleanup criteria",
        items,
      },
    ],
  });
}

function allPlanItems(plan: CleanupPlan): CleanupPlanItem[] {
  return plan.clusters.flatMap((cluster) => [...cluster.items]);
}

function selectedItemsFor(
  items: readonly CleanupPlanItem[],
): CleanupSelectedItemSnapshot[] {
  return items.map((item) => ({
    itemKey: item.itemKey,
    snapshotHash: item.snapshotHash,
  }));
}

function confirmationFor(
  plan: CleanupPlan,
  items: readonly CleanupPlanItem[] = allPlanItems(plan),
  destructive = false,
): CleanupConfirmationInput {
  const selectedItems = selectedItemsFor(items);
  return {
    confirmedByUserId: OWNER_ID,
    confirmedAt: NOW,
    planHash: plan.planHash,
    selectedItems,
    destructiveApproval: destructive
      ? {
          approvedByUserId: OWNER_ID,
          approvedAt: NOW,
          planHash: plan.planHash,
          approvedItemSnapshotHashes: items.map((item) => item.snapshotHash),
        }
      : undefined,
  };
}

function createAdapter(
  provider: CleanupProvider,
  options: {
    readonly currentSnapshots?: (
      items: readonly CleanupPlanItem[],
    ) => readonly CleanupItemSnapshot[];
    readonly executeChunk?: (
      request: CleanupAdapterChunkRequest,
    ) => ReturnType<CleanupOperationAdapter["executeChunk"]>;
    readonly dryRunChunk?: (
      request: CleanupAdapterChunkRequest,
    ) => ReturnType<CleanupOperationAdapter["dryRunChunk"]>;
    readonly undoChunk?: (
      request: CleanupUndoAdapterChunkRequest,
    ) => ReturnType<NonNullable<CleanupOperationAdapter["undoChunk"]>>;
  } = {},
) {
  const readCurrentSnapshots = vi.fn(
    async (items: readonly CleanupPlanItem[]) =>
      options.currentSnapshots
        ? options.currentSnapshots(items)
        : items.map((item) => item.snapshot),
  );
  const dryRunChunk = vi.fn(async (request: CleanupAdapterChunkRequest) =>
    options.dryRunChunk
      ? options.dryRunChunk(request)
      : {
          results: request.operations.map((operation) => ({
            itemKey: operation.item.itemKey,
            outcome: "succeeded" as const,
          })),
        },
  );
  const executeChunk = vi.fn(async (request: CleanupAdapterChunkRequest) =>
    options.executeChunk
      ? options.executeChunk(request)
      : {
          results: request.operations.map((operation) => ({
            itemKey: operation.item.itemKey,
            outcome: "succeeded" as const,
            undoToken: `undo-${operation.item.itemKey}`,
            undoExpiresAt: "2026-05-03T19:00:00.000Z",
          })),
        },
  );
  const undoChunk = vi.fn(async (request: CleanupUndoAdapterChunkRequest) =>
    options.undoChunk
      ? options.undoChunk(request)
      : {
          results: request.operations.map((operation) => ({
            itemKey: operation.item.itemKey,
            outcome: "succeeded" as const,
          })),
        },
  );

  return {
    provider,
    readCurrentSnapshots,
    dryRunChunk,
    executeChunk,
    undoChunk,
  } satisfies CleanupOperationAdapter;
}

describe("LifeOps bulk review cleanup substrate", () => {
  it("rejects execution when the user-confirmed plan hash does not match", async () => {
    const plan = await cleanupPlan([draftItem(snapshot("gmail", "gm-1"))]);
    const adapter = createAdapter("gmail");

    const result = await executeCleanupPlan({
      plan,
      mode: "execute",
      actorUserId: OWNER_ID,
      confirmation: {
        ...confirmationFor(plan),
        planHash: "sha256:not-the-plan",
      },
      adapters: { gmail: adapter },
      now: NOW,
    });

    expect(result.status).toBe("rejected");
    expect(result.rejectionCode).toBe("CONFIRMATION_HASH_MISMATCH");
    expect(adapter.executeChunk).not.toHaveBeenCalled();
  });

  it("rejects execution when the reviewed item snapshot has drifted", async () => {
    const plan = await cleanupPlan([draftItem(snapshot("gmail", "gm-1"))]);
    const item = allPlanItems(plan)[0];
    const adapter = createAdapter("gmail", {
      currentSnapshots: () => [
        {
          ...item.snapshot,
          etag: "etag-after-user-review",
        },
      ],
    });

    const result = await executeCleanupPlan({
      plan,
      mode: "execute",
      actorUserId: OWNER_ID,
      confirmation: confirmationFor(plan),
      adapters: { gmail: adapter },
      now: NOW,
    });

    expect(result.status).toBe("rejected");
    expect(result.rejectionCode).toBe("ITEM_SNAPSHOT_DRIFT");
    expect(adapter.executeChunk).not.toHaveBeenCalled();
  });

  it("rejects destructive operations without item-bound destructive approval", async () => {
    const plan = await cleanupPlan([
      draftItem(snapshot("gmail", "spam-1"), trashOperation),
    ]);
    const adapter = createAdapter("gmail");

    const result = await executeCleanupPlan({
      plan,
      mode: "execute",
      actorUserId: OWNER_ID,
      confirmation: confirmationFor(plan),
      adapters: { gmail: adapter },
      now: NOW,
    });

    expect(result.status).toBe("rejected");
    expect(result.rejectionCode).toBe("DESTRUCTIVE_APPROVAL_REQUIRED");
    expect(adapter.executeChunk).not.toHaveBeenCalled();
  });

  it("keeps executing chunks and reports partial adapter failures", async () => {
    const plan = await cleanupPlan([
      draftItem(snapshot("gmail", "gm-1")),
      draftItem(snapshot("gmail", "gm-2")),
    ]);
    const items = allPlanItems(plan);
    const adapter = createAdapter("gmail", {
      executeChunk: () => ({
        results: [
          {
            itemKey: items[0].itemKey,
            outcome: "succeeded",
          },
          {
            itemKey: items[1].itemKey,
            outcome: "failed",
            code: "RATE_LIMITED",
            message: "Gmail quota exhausted",
          },
        ],
      }),
    });

    const result = await executeCleanupPlan({
      plan,
      mode: "execute",
      actorUserId: OWNER_ID,
      confirmation: confirmationFor(plan),
      adapters: { gmail: adapter },
      now: NOW,
    });

    expect(result.status).toBe("partially_failed");
    expect(result.results.map((entry) => entry.outcome)).toEqual([
      "succeeded",
      "failed",
    ]);
    expect(
      result.auditEvents.some((event) => event.code === "RATE_LIMITED"),
    ).toBe(true);
  });

  it("runs dry-run chunks without executing adapter mutations", async () => {
    const plan = await cleanupPlan([draftItem(snapshot("gmail", "gm-1"))]);
    const adapter = createAdapter("gmail");

    const result = await executeCleanupPlan({
      plan,
      mode: "dry_run",
      actorUserId: OWNER_ID,
      selection: {
        selectedByUserId: OWNER_ID,
        selectedAt: NOW,
        planHash: plan.planHash,
        selectedItems: selectedItemsFor(allPlanItems(plan)),
      },
      adapters: { gmail: adapter },
      now: NOW,
    });

    expect(result.status).toBe("dry_run");
    expect(result.results).toEqual([
      expect.objectContaining({ outcome: "planned" }),
    ]);
    expect(adapter.dryRunChunk).toHaveBeenCalledTimes(1);
    expect(adapter.executeChunk).not.toHaveBeenCalled();
    expect(result.auditEvents).toContainEqual(
      expect.objectContaining({
        eventType: "cleanup.bulk_review.item_dry_run",
        outcome: "planned",
      }),
    );
  });

  it("treats duplicate external item IDs on different providers as distinct review items", async () => {
    const plan = await cleanupPlan([
      draftItem(snapshot("gmail", "same-id"), trashOperation),
      draftItem(snapshot("drive", "same-id"), driveTrashOperation),
    ]);
    const items = allPlanItems(plan);
    const gmailAdapter = createAdapter("gmail");
    const driveAdapter = createAdapter("drive");

    const result = await executeCleanupPlan({
      plan,
      mode: "execute",
      actorUserId: OWNER_ID,
      confirmation: confirmationFor(plan, items, true),
      adapters: { gmail: gmailAdapter, drive: driveAdapter },
      now: NOW,
    });

    expect(new Set(items.map((item) => item.itemKey)).size).toBe(2);
    expect(items.map((item) => item.snapshot.itemId)).toEqual([
      "same-id",
      "same-id",
    ]);
    expect(result.status).toBe("succeeded");
    expect(gmailAdapter.executeChunk).toHaveBeenCalledTimes(1);
    expect(driveAdapter.executeChunk).toHaveBeenCalledTimes(1);
  });

  it("rejects undo after the undo window expires", async () => {
    const plan = await cleanupPlan([
      draftItem(snapshot("gmail", "gm-1"), archiveOperation),
    ]);
    const adapter = createAdapter("gmail", {
      executeChunk: (request) => ({
        results: request.operations.map((operation) => ({
          itemKey: operation.item.itemKey,
          outcome: "succeeded",
          undoToken: `undo-${operation.item.itemKey}`,
          undoExpiresAt: "2026-05-03T18:05:00.000Z",
        })),
      }),
    });

    const execution = await executeCleanupPlan({
      plan,
      mode: "execute",
      actorUserId: OWNER_ID,
      confirmation: confirmationFor(plan),
      adapters: { gmail: adapter },
      now: NOW,
    });

    expect(execution.undo?.status).toBe("eligible");
    const undo = execution.undo;
    expect(undo).toBeDefined();
    if (!undo) {
      throw new Error("Expected cleanup undo to be created");
    }

    const undoResult = await undoCleanupExecution({
      undo,
      actorUserId: OWNER_ID,
      adapters: { gmail: adapter },
      confirmation: {
        confirmedByUserId: OWNER_ID,
        confirmedAt: "2026-05-03T18:10:00.000Z",
        planHash: undo.planHash,
        undoId: undo.undoId,
        executionId: undo.executionId,
      },
      now: "2026-05-03T18:10:00.000Z",
    });

    expect(undoResult.status).toBe("rejected");
    expect(undoResult.rejectionCode).toBe("UNDO_EXPIRED");
    expect(adapter.undoChunk).not.toHaveBeenCalled();
  });

  it("marks undo unsupported when successful operations do not produce undo material", async () => {
    const plan = await cleanupPlan([
      draftItem(snapshot("gmail", "gm-1"), markReadOperation),
    ]);
    const adapter = createAdapter("gmail", {
      executeChunk: (request) => ({
        results: request.operations.map((operation) => ({
          itemKey: operation.item.itemKey,
          outcome: "succeeded",
        })),
      }),
    });

    const execution = await executeCleanupPlan({
      plan,
      mode: "execute",
      actorUserId: OWNER_ID,
      confirmation: confirmationFor(plan),
      adapters: { gmail: adapter },
      now: NOW,
    });

    const undo = execution.undo;
    expect(undo?.status).toBe("unsupported");
    expect(undo ? getCleanupUndoEligibility(undo, NOW).code : undefined).toBe(
      "UNDO_UNSUPPORTED",
    );
  });

  it("rejects empty selections before reading adapters", async () => {
    const plan = await cleanupPlan([draftItem(snapshot("gmail", "gm-1"))]);
    const adapter = createAdapter("gmail");

    const result = await executeCleanupPlan({
      plan,
      mode: "execute",
      actorUserId: OWNER_ID,
      confirmation: {
        ...confirmationFor(plan),
        selectedItems: [],
      },
      adapters: { gmail: adapter },
      now: NOW,
    });

    expect(result.status).toBe("rejected");
    expect(result.rejectionCode).toBe("EMPTY_SELECTION");
    expect(adapter.readCurrentSnapshots).not.toHaveBeenCalled();
  });

  it("rejects oversized plans and chunks eligible execution work", async () => {
    const plan = await cleanupPlan([
      draftItem(snapshot("gmail", "gm-1")),
      draftItem(snapshot("gmail", "gm-2")),
      draftItem(snapshot("gmail", "gm-3")),
      draftItem(snapshot("gmail", "gm-4")),
    ]);
    const adapter = createAdapter("gmail");

    const tooLarge = await executeCleanupPlan({
      plan,
      mode: "execute",
      actorUserId: OWNER_ID,
      confirmation: confirmationFor(plan),
      adapters: { gmail: adapter },
      now: NOW,
      maxPlanItems: 3,
    });

    expect(tooLarge.status).toBe("rejected");
    expect(tooLarge.rejectionCode).toBe("PLAN_TOO_LARGE");
    expect(adapter.executeChunk).not.toHaveBeenCalled();

    const chunked = await executeCleanupPlan({
      plan,
      mode: "execute",
      actorUserId: OWNER_ID,
      confirmation: confirmationFor(plan),
      adapters: { gmail: adapter },
      now: NOW,
      maxPlanItems: 10,
      chunkSize: 2,
    });

    expect(chunked.status).toBe("succeeded");
    expect(chunked.chunks.map((chunk) => chunk.itemKeys.length)).toEqual([
      2, 2,
    ]);
    expect(adapter.executeChunk).toHaveBeenCalledTimes(2);
  });

  it("excludes policy-denied items and audits the exclusion", async () => {
    const plan = await cleanupPlan([
      draftItem(snapshot("gmail", "keep-out")),
      draftItem(snapshot("gmail", "allowed")),
    ]);
    const adapter = createAdapter("gmail");

    const result = await executeCleanupPlan({
      plan,
      mode: "execute",
      actorUserId: OWNER_ID,
      confirmation: confirmationFor(plan),
      adapters: { gmail: adapter },
      policyGate: ({ item }) =>
        item.snapshot.itemId === "keep-out"
          ? {
              outcome: "deny",
              code: "POLICY_PROTECTED_ITEM",
              reason: "Protected by retention policy",
            }
          : { outcome: "allow" },
      now: NOW,
    });

    expect(result.status).toBe("succeeded");
    expect(result.skippedItems).toEqual([
      expect.objectContaining({
        reasonCode: "POLICY_PROTECTED_ITEM",
      }),
    ]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].itemKey).toContain(encodeURIComponent("allowed"));
    expect(
      result.auditEvents.some(
        (event) => event.eventType === "cleanup.bulk_review.policy_denied",
      ),
    ).toBe(true);
    const request = adapter.executeChunk.mock.calls[0][0];
    expect(
      request.operations.map((operation) => operation.item.snapshot.itemId),
    ).toEqual(["allowed"]);
  });

  it("executes non-destructive mark-read without destructive approval and still emits audit", async () => {
    const plan = await cleanupPlan([
      draftItem(snapshot("gmail", "gm-1"), markReadOperation),
    ]);
    const adapter = createAdapter("gmail");

    const result = await executeCleanupPlan({
      plan,
      mode: "execute",
      actorUserId: OWNER_ID,
      confirmation: confirmationFor(plan),
      adapters: { gmail: adapter },
      now: NOW,
    });

    expect(result.status).toBe("succeeded");
    expect(adapter.executeChunk).toHaveBeenCalledTimes(1);
    expect(result.auditEvents).toContainEqual(
      expect.objectContaining({
        eventType: "cleanup.bulk_review.item_executed",
        operationKind: "gmail.mark_read",
        risk: "non_destructive",
        outcome: "succeeded",
      }),
    );
  });

  it("builds provider-qualified item keys for duplicate ids", () => {
    expect(getCleanupItemKey(snapshot("gmail", "shared"))).not.toBe(
      getCleanupItemKey(snapshot("drive", "shared")),
    );
  });
});
