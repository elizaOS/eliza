export const CLEANUP_BULK_REVIEW_SCHEMA_VERSION = "lifeops.cleanup-plan.v1";
export const DEFAULT_CLEANUP_EXECUTION_CHUNK_SIZE = 50;
export const MAX_CLEANUP_EXECUTION_CHUNK_SIZE = 250;
export const DEFAULT_CLEANUP_PLAN_ITEM_LIMIT = 2_500;

export type CleanupProvider = "gmail" | "drive" | "file";

export type CleanupOperationKind =
  | "gmail.mark_read"
  | "gmail.archive"
  | "gmail.trash"
  | "gmail.delete_forever"
  | "drive.trash"
  | "drive.delete_forever"
  | "file.move_to_trash"
  | "file.delete_forever"
  | "file.archive";

export type CleanupOperationRisk =
  | "non_destructive"
  | "reversible"
  | "destructive";

export type CleanupExecutionMode = "dry_run" | "execute";
export type CleanupExecutionStatus =
  | "dry_run"
  | "succeeded"
  | "partially_failed"
  | "failed"
  | "rejected";

export type CleanupItemKey = string;
export type CleanupPlanHash = string;
export type CleanupSnapshotHash = string;

export type CleanupJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CleanupJsonValue[]
  | { readonly [key: string]: CleanupJsonValue | undefined };

export type CleanupJsonObject = {
  readonly [key: string]: CleanupJsonValue | undefined;
};

export type CleanupItemSnapshot = {
  readonly provider: CleanupProvider;
  readonly itemId: string;
  readonly accountId?: string;
  readonly displayName: string;
  readonly canonicalUrl?: string;
  readonly parentId?: string;
  readonly path?: string;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
  readonly checksum?: string;
  readonly etag?: string;
  readonly revisionId?: string;
  readonly updatedAt?: string;
  readonly createdAt?: string;
  readonly labels?: readonly string[];
  readonly metadata?: CleanupJsonObject;
};

export type CleanupOperation = {
  readonly kind: CleanupOperationKind;
  readonly risk: CleanupOperationRisk;
  readonly reason: string;
  readonly requiresUserApproval: boolean;
  readonly undoSupported: boolean;
  readonly parameters?: CleanupJsonObject;
};

export type CleanupPlanDraftItem = {
  readonly snapshot: CleanupItemSnapshot;
  readonly operation: CleanupOperation;
  readonly evidence: readonly string[];
};

export type CleanupPlanItem = CleanupPlanDraftItem & {
  readonly itemKey: CleanupItemKey;
  readonly snapshotHash: CleanupSnapshotHash;
};

export type CleanupClusterDraft = {
  readonly id: string;
  readonly title: string;
  readonly rationale: string;
  readonly items: readonly CleanupPlanDraftItem[];
};

export type CleanupCluster = {
  readonly id: string;
  readonly title: string;
  readonly rationale: string;
  readonly items: readonly CleanupPlanItem[];
};

export type CleanupPlanDraft = {
  readonly id: string;
  readonly ownerUserId: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly source: "gmail" | "drive" | "file" | "mixed";
  readonly title: string;
  readonly summary: string;
  readonly clusters: readonly CleanupClusterDraft[];
  readonly metadata?: CleanupJsonObject;
};

export type CleanupPlan = {
  readonly schemaVersion: typeof CLEANUP_BULK_REVIEW_SCHEMA_VERSION;
  readonly id: string;
  readonly ownerUserId: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly source: CleanupPlanDraft["source"];
  readonly title: string;
  readonly summary: string;
  readonly clusters: readonly CleanupCluster[];
  readonly metadata?: CleanupJsonObject;
  readonly planHash: CleanupPlanHash;
};

export type CleanupSelectedItemSnapshot = {
  readonly itemKey: CleanupItemKey;
  readonly snapshotHash: CleanupSnapshotHash;
};

export type CleanupSelectionInput = {
  readonly selectedByUserId?: string;
  readonly selectedAt?: string;
  readonly planHash?: CleanupPlanHash;
  readonly selectedItems: readonly CleanupSelectedItemSnapshot[];
};

export type CleanupDestructiveApprovalInput = {
  readonly approvedByUserId: string;
  readonly approvedAt: string;
  readonly planHash: CleanupPlanHash;
  readonly approvedItemSnapshotHashes: readonly CleanupSnapshotHash[];
};

export type CleanupPolicyApprovalInput = {
  readonly approvedByUserId: string;
  readonly approvedAt: string;
  readonly planHash: CleanupPlanHash;
  readonly approvedItemSnapshotHashes: readonly CleanupSnapshotHash[];
};

export type CleanupConfirmationInput = {
  readonly confirmedByUserId: string;
  readonly confirmedAt: string;
  readonly planHash: CleanupPlanHash;
  readonly selectedItems: readonly CleanupSelectedItemSnapshot[];
  readonly destructiveApproval?: CleanupDestructiveApprovalInput;
  readonly policyApproval?: CleanupPolicyApprovalInput;
};

export type CleanupPolicyGateInput = {
  readonly actorUserId: string;
  readonly mode: CleanupExecutionMode;
  readonly planHash: CleanupPlanHash;
  readonly item: CleanupPlanItem;
  readonly requestedAt: string;
};

export type CleanupPolicyDecision =
  | {
      readonly outcome: "allow";
    }
  | {
      readonly outcome: "deny";
      readonly code: string;
      readonly reason: string;
      readonly auditMetadata?: CleanupJsonObject;
    }
  | {
      readonly outcome: "require_user_approval";
      readonly code: string;
      readonly reason: string;
      readonly auditMetadata?: CleanupJsonObject;
    };

export type CleanupPolicyGate = (
  input: CleanupPolicyGateInput,
) => CleanupPolicyDecision | Promise<CleanupPolicyDecision>;

export type CleanupAdapterOperation = {
  readonly planId: string;
  readonly planHash: CleanupPlanHash;
  readonly actorUserId: string;
  readonly mode: CleanupExecutionMode;
  readonly item: CleanupPlanItem;
};

export type CleanupAdapterChunkRequest = {
  readonly executionId: string;
  readonly provider: CleanupProvider;
  readonly chunkIndex: number;
  readonly operations: readonly CleanupAdapterOperation[];
};

export type CleanupAdapterItemResult = {
  readonly itemKey: CleanupItemKey;
  readonly outcome: "succeeded" | "failed";
  readonly code?: string;
  readonly message?: string;
  readonly undoToken?: string;
  readonly undoExpiresAt?: string;
  readonly metadata?: CleanupJsonObject;
};

export type CleanupAdapterChunkResult = {
  readonly results: readonly CleanupAdapterItemResult[];
};

export type CleanupUndoAdapterOperation = {
  readonly undoId: string;
  readonly planHash: CleanupPlanHash;
  readonly actorUserId: string;
  readonly item: CleanupUndoItem;
};

export type CleanupUndoAdapterChunkRequest = {
  readonly undoId: string;
  readonly provider: CleanupProvider;
  readonly chunkIndex: number;
  readonly operations: readonly CleanupUndoAdapterOperation[];
};

export type CleanupUndoAdapterItemResult = {
  readonly itemKey: CleanupItemKey;
  readonly outcome: "succeeded" | "failed";
  readonly code?: string;
  readonly message?: string;
  readonly metadata?: CleanupJsonObject;
};

export type CleanupUndoAdapterChunkResult = {
  readonly results: readonly CleanupUndoAdapterItemResult[];
};

export type CleanupOperationAdapter = {
  readonly provider: CleanupProvider;
  readonly readCurrentSnapshots: (
    items: readonly CleanupPlanItem[],
  ) => readonly CleanupItemSnapshot[] | Promise<readonly CleanupItemSnapshot[]>;
  readonly dryRunChunk: (
    request: CleanupAdapterChunkRequest,
  ) => CleanupAdapterChunkResult | Promise<CleanupAdapterChunkResult>;
  readonly executeChunk: (
    request: CleanupAdapterChunkRequest,
  ) => CleanupAdapterChunkResult | Promise<CleanupAdapterChunkResult>;
  readonly undoChunk?: (
    request: CleanupUndoAdapterChunkRequest,
  ) => CleanupUndoAdapterChunkResult | Promise<CleanupUndoAdapterChunkResult>;
};

export type CleanupAdapterRegistry = Partial<
  Record<CleanupProvider, CleanupOperationAdapter>
>;

export type CleanupAuditEventType =
  | "cleanup.bulk_review.rejected"
  | "cleanup.bulk_review.policy_denied"
  | "cleanup.bulk_review.policy_approval_required"
  | "cleanup.bulk_review.item_dry_run"
  | "cleanup.bulk_review.item_executed"
  | "cleanup.bulk_review.item_failed"
  | "cleanup.bulk_review.undo_rejected"
  | "cleanup.bulk_review.undo_executed"
  | "cleanup.bulk_review.undo_failed";

export type CleanupAuditEvent = {
  readonly schemaVersion: typeof CLEANUP_BULK_REVIEW_SCHEMA_VERSION;
  readonly eventId: string;
  readonly eventType: CleanupAuditEventType;
  readonly emittedAt: string;
  readonly actorUserId: string;
  readonly planHash: CleanupPlanHash;
  readonly executionId?: string;
  readonly undoId?: string;
  readonly itemKey?: CleanupItemKey;
  readonly provider?: CleanupProvider;
  readonly operationKind?: CleanupOperationKind;
  readonly risk?: CleanupOperationRisk;
  readonly outcome: "planned" | "succeeded" | "failed" | "skipped" | "rejected";
  readonly code?: string;
  readonly message?: string;
  readonly metadata?: CleanupJsonObject;
};

export type CleanupSkippedItem = {
  readonly itemKey: CleanupItemKey;
  readonly provider: CleanupProvider;
  readonly operationKind: CleanupOperationKind;
  readonly snapshotHash: CleanupSnapshotHash;
  readonly reasonCode: string;
  readonly reason: string;
};

export type CleanupExecutionItemResult = {
  readonly itemKey: CleanupItemKey;
  readonly provider: CleanupProvider;
  readonly operationKind: CleanupOperationKind;
  readonly snapshotHash: CleanupSnapshotHash;
  readonly outcome: "planned" | "succeeded" | "failed";
  readonly code?: string;
  readonly message?: string;
  readonly undoToken?: string;
  readonly undoExpiresAt?: string;
};

export type CleanupExecutionChunk = {
  readonly chunkIndex: number;
  readonly provider: CleanupProvider;
  readonly itemKeys: readonly CleanupItemKey[];
  readonly status: "planned" | "succeeded" | "failed" | "partially_failed";
  readonly startedAt: string;
  readonly completedAt: string;
};

export type CleanupUndoItem = {
  readonly itemKey: CleanupItemKey;
  readonly provider: CleanupProvider;
  readonly operationKind: CleanupOperationKind;
  readonly snapshotHash: CleanupSnapshotHash;
  readonly undoToken?: string;
  readonly undoExpiresAt?: string;
  readonly eligibility: "eligible" | "unsupported";
  readonly reason?: string;
};

export type CleanupUndo = {
  readonly undoId: string;
  readonly executionId: string;
  readonly planHash: CleanupPlanHash;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly status: "eligible" | "partially_eligible" | "unsupported";
  readonly items: readonly CleanupUndoItem[];
};

export type CleanupExecution = {
  readonly executionId: string;
  readonly planId: string;
  readonly planHash: CleanupPlanHash;
  readonly mode: CleanupExecutionMode;
  readonly status: CleanupExecutionStatus;
  readonly actorUserId: string;
  readonly requestedItemCount: number;
  readonly eligibleItemCount: number;
  readonly skippedItems: readonly CleanupSkippedItem[];
  readonly results: readonly CleanupExecutionItemResult[];
  readonly chunks: readonly CleanupExecutionChunk[];
  readonly auditEvents: readonly CleanupAuditEvent[];
  readonly undo?: CleanupUndo;
  readonly createdAt: string;
  readonly completedAt: string;
  readonly rejectionCode?: string;
  readonly rejectionReason?: string;
};

export type CleanupExecutionRequest = {
  readonly plan: CleanupPlan;
  readonly mode: CleanupExecutionMode;
  readonly actorUserId: string;
  readonly adapters: CleanupAdapterRegistry;
  readonly selection?: CleanupSelectionInput;
  readonly confirmation?: CleanupConfirmationInput;
  readonly policyGate?: CleanupPolicyGate;
  readonly now: string;
  readonly chunkSize?: number;
  readonly maxPlanItems?: number;
  readonly executionId?: string;
};

export type CleanupUndoConfirmationInput = {
  readonly confirmedByUserId: string;
  readonly confirmedAt: string;
  readonly planHash: CleanupPlanHash;
  readonly undoId: string;
  readonly executionId: string;
};

export type CleanupUndoEligibility = {
  readonly eligible: boolean;
  readonly code?: string;
  readonly reason?: string;
};

export type CleanupUndoExecution = {
  readonly undoId: string;
  readonly executionId: string;
  readonly planHash: CleanupPlanHash;
  readonly actorUserId: string;
  readonly status: "succeeded" | "partially_failed" | "failed" | "rejected";
  readonly results: readonly CleanupUndoAdapterItemResult[];
  readonly auditEvents: readonly CleanupAuditEvent[];
  readonly createdAt: string;
  readonly completedAt: string;
  readonly rejectionCode?: string;
  readonly rejectionReason?: string;
};

export type CleanupUndoExecutionRequest = {
  readonly undo: CleanupUndo;
  readonly actorUserId: string;
  readonly adapters: CleanupAdapterRegistry;
  readonly confirmation: CleanupUndoConfirmationInput;
  readonly now: string;
  readonly chunkSize?: number;
};

type PlanIndex = {
  readonly itemByKey: ReadonlyMap<CleanupItemKey, CleanupPlanItem>;
  readonly itemCount: number;
};

type AuditEventInput = {
  readonly eventType: CleanupAuditEventType;
  readonly emittedAt: string;
  readonly actorUserId: string;
  readonly planHash: CleanupPlanHash;
  readonly executionId?: string;
  readonly undoId?: string;
  readonly item?: CleanupPlanItem;
  readonly undoItem?: CleanupUndoItem;
  readonly outcome: CleanupAuditEvent["outcome"];
  readonly code?: string;
  readonly message?: string;
  readonly metadata?: CleanupJsonObject;
};

function canonicalJson(value: CleanupJsonValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("[BulkReview] Hash payload contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }

  const entries: [string, CleanupJsonValue][] = [];
  for (const [key, entryValue] of Object.entries(value)) {
    if (entryValue !== undefined) {
      entries.push([key, entryValue]);
    }
  }
  entries.sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(
      ([key, entryValue]) =>
        `${JSON.stringify(key)}:${canonicalJson(entryValue)}`,
    )
    .join(",")}}`;
}

async function sha256Hex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("[BulkReview] SHA-256 crypto.subtle is unavailable");
  }
  const bytes = new TextEncoder().encode(input);
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sortedStrings(
  values: readonly string[] | undefined,
): CleanupJsonValue | undefined {
  return values ? [...values].sort() : undefined;
}

function snapshotHashPayload(snapshot: CleanupItemSnapshot): CleanupJsonObject {
  return {
    provider: snapshot.provider,
    itemId: snapshot.itemId,
    accountId: snapshot.accountId,
    displayName: snapshot.displayName,
    canonicalUrl: snapshot.canonicalUrl,
    parentId: snapshot.parentId,
    path: snapshot.path,
    mimeType: snapshot.mimeType,
    sizeBytes: snapshot.sizeBytes,
    checksum: snapshot.checksum,
    etag: snapshot.etag,
    revisionId: snapshot.revisionId,
    updatedAt: snapshot.updatedAt,
    createdAt: snapshot.createdAt,
    labels: sortedStrings(snapshot.labels),
    metadata: snapshot.metadata,
  };
}

function operationHashPayload(operation: CleanupOperation): CleanupJsonObject {
  return {
    kind: operation.kind,
    risk: operation.risk,
    reason: operation.reason,
    requiresUserApproval: operation.requiresUserApproval,
    undoSupported: operation.undoSupported,
    parameters: operation.parameters,
  };
}

function planHashPayload(
  plan: CleanupPlan | Omit<CleanupPlan, "planHash">,
): CleanupJsonObject {
  return {
    schemaVersion: CLEANUP_BULK_REVIEW_SCHEMA_VERSION,
    id: plan.id,
    ownerUserId: plan.ownerUserId,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    source: plan.source,
    title: plan.title,
    summary: plan.summary,
    metadata: plan.metadata,
    clusters: plan.clusters.map((cluster) => ({
      id: cluster.id,
      title: cluster.title,
      rationale: cluster.rationale,
      items: cluster.items.map((item) => ({
        itemKey: item.itemKey,
        snapshot: snapshotHashPayload(item.snapshot),
        operation: operationHashPayload(item.operation),
        evidence: [...item.evidence],
      })),
    })),
  };
}

export function getCleanupItemKey(
  snapshot: CleanupItemSnapshot,
): CleanupItemKey {
  const accountPart = encodeURIComponent(snapshot.accountId ?? "_");
  return `${snapshot.provider}:${accountPart}:${encodeURIComponent(snapshot.itemId)}`;
}

export async function hashCleanupItemSnapshot(
  snapshot: CleanupItemSnapshot,
): Promise<CleanupSnapshotHash> {
  return sha256Hex(canonicalJson(snapshotHashPayload(snapshot)));
}

export async function computeCleanupPlanHash(
  plan: CleanupPlan | Omit<CleanupPlan, "planHash">,
): Promise<CleanupPlanHash> {
  return sha256Hex(canonicalJson(planHashPayload(plan)));
}

export async function bindCleanupPlanHash(
  draft: CleanupPlanDraft,
): Promise<CleanupPlan> {
  const seenItemKeys = new Set<CleanupItemKey>();
  const clusters: CleanupCluster[] = [];

  for (const cluster of draft.clusters) {
    const items: CleanupPlanItem[] = [];
    for (const item of cluster.items) {
      const itemKey = getCleanupItemKey(item.snapshot);
      if (seenItemKeys.has(itemKey)) {
        throw new Error(`[BulkReview] Duplicate cleanup item key: ${itemKey}`);
      }
      seenItemKeys.add(itemKey);
      items.push({
        ...item,
        itemKey,
        snapshotHash: await hashCleanupItemSnapshot(item.snapshot),
      });
    }
    clusters.push({
      id: cluster.id,
      title: cluster.title,
      rationale: cluster.rationale,
      items,
    });
  }

  const planWithoutHash: Omit<CleanupPlan, "planHash"> = {
    schemaVersion: CLEANUP_BULK_REVIEW_SCHEMA_VERSION,
    id: draft.id,
    ownerUserId: draft.ownerUserId,
    createdAt: draft.createdAt,
    expiresAt: draft.expiresAt,
    source: draft.source,
    title: draft.title,
    summary: draft.summary,
    clusters,
    metadata: draft.metadata,
  };

  return {
    ...planWithoutHash,
    planHash: await computeCleanupPlanHash(planWithoutHash),
  };
}

function makePlanIndex(plan: CleanupPlan): PlanIndex {
  const itemByKey = new Map<CleanupItemKey, CleanupPlanItem>();
  for (const cluster of plan.clusters) {
    for (const item of cluster.items) {
      if (itemByKey.has(item.itemKey)) {
        throw new Error(
          `[BulkReview] Duplicate cleanup item key: ${item.itemKey}`,
        );
      }
      itemByKey.set(item.itemKey, item);
    }
  }
  return { itemByKey, itemCount: itemByKey.size };
}

function createExecutionId(planHash: CleanupPlanHash, now: string): string {
  const timestamp = Date.parse(now);
  const timestampPart = Number.isFinite(timestamp)
    ? timestamp.toString(36)
    : "invalid-time";
  return `cleanup-exec-${timestampPart}-${planHash.slice(0, 16)}`;
}

function createUndoId(executionId: string): string {
  return `${executionId}:undo`;
}

function normalizeChunkSize(size: number | undefined): number {
  if (size === undefined) {
    return DEFAULT_CLEANUP_EXECUTION_CHUNK_SIZE;
  }
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(
      "[BulkReview] Cleanup chunk size must be a positive integer",
    );
  }
  if (size > MAX_CLEANUP_EXECUTION_CHUNK_SIZE) {
    throw new Error(
      `[BulkReview] Cleanup chunk size cannot exceed ${MAX_CLEANUP_EXECUTION_CHUNK_SIZE}`,
    );
  }
  return size;
}

function isExpired(expiresAt: string | undefined, now: string): boolean {
  if (!expiresAt) {
    return false;
  }
  const expiresMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(expiresMs) || !Number.isFinite(nowMs)) {
    return true;
  }
  return expiresMs <= nowMs;
}

function pushAuditEvent(
  auditEvents: CleanupAuditEvent[],
  input: AuditEventInput,
): void {
  const item = input.item;
  const undoItem = input.undoItem;
  auditEvents.push({
    schemaVersion: CLEANUP_BULK_REVIEW_SCHEMA_VERSION,
    eventId: `${input.executionId ?? input.undoId ?? "cleanup"}:${auditEvents.length + 1}`,
    eventType: input.eventType,
    emittedAt: input.emittedAt,
    actorUserId: input.actorUserId,
    planHash: input.planHash,
    executionId: input.executionId,
    undoId: input.undoId,
    itemKey: item?.itemKey ?? undoItem?.itemKey,
    provider: item?.snapshot.provider ?? undoItem?.provider,
    operationKind: item?.operation.kind ?? undoItem?.operationKind,
    risk: item?.operation.risk,
    outcome: input.outcome,
    code: input.code,
    message: input.message,
    metadata: input.metadata,
  });
}

function rejectedExecution(args: {
  readonly plan: CleanupPlan;
  readonly actorUserId: string;
  readonly mode: CleanupExecutionMode;
  readonly now: string;
  readonly executionId: string;
  readonly code: string;
  readonly reason: string;
  readonly auditEvents?: readonly CleanupAuditEvent[];
}): CleanupExecution {
  const auditEvents = [...(args.auditEvents ?? [])];
  pushAuditEvent(auditEvents, {
    eventType: "cleanup.bulk_review.rejected",
    emittedAt: args.now,
    actorUserId: args.actorUserId,
    planHash: args.plan.planHash,
    executionId: args.executionId,
    outcome: "rejected",
    code: args.code,
    message: args.reason,
  });
  return {
    executionId: args.executionId,
    planId: args.plan.id,
    planHash: args.plan.planHash,
    mode: args.mode,
    status: "rejected",
    actorUserId: args.actorUserId,
    requestedItemCount: 0,
    eligibleItemCount: 0,
    skippedItems: [],
    results: [],
    chunks: [],
    auditEvents,
    createdAt: args.now,
    completedAt: args.now,
    rejectionCode: args.code,
    rejectionReason: args.reason,
  };
}

function selectedItemsForRequest(
  request: CleanupExecutionRequest,
): readonly CleanupSelectedItemSnapshot[] | null {
  if (request.mode === "execute") {
    return request.confirmation?.selectedItems ?? null;
  }
  return request.selection?.selectedItems ?? null;
}

function getRequestedPlanHash(
  request: CleanupExecutionRequest,
): CleanupPlanHash | undefined {
  if (request.mode === "execute") {
    return request.confirmation?.planHash;
  }
  return request.selection?.planHash;
}

function assertSameUserForConfirmation(
  request: CleanupExecutionRequest,
): string | null {
  if (request.mode !== "execute") {
    return null;
  }
  const confirmation = request.confirmation;
  if (!confirmation) {
    return "A user confirmation is required before executing cleanup operations";
  }
  if (confirmation.confirmedByUserId !== request.actorUserId) {
    return "Cleanup confirmation belongs to a different user";
  }
  return null;
}

function resolveSelectedItems(args: {
  readonly itemByKey: ReadonlyMap<CleanupItemKey, CleanupPlanItem>;
  readonly selectedItems: readonly CleanupSelectedItemSnapshot[];
}): {
  readonly items: readonly CleanupPlanItem[];
  readonly error?: string;
  readonly code?: string;
} {
  if (args.selectedItems.length === 0) {
    return {
      items: [],
      code: "EMPTY_SELECTION",
      error: "Select at least one item",
    };
  }

  const seen = new Set<CleanupItemKey>();
  const items: CleanupPlanItem[] = [];
  for (const selected of args.selectedItems) {
    if (seen.has(selected.itemKey)) {
      return {
        items: [],
        code: "DUPLICATE_SELECTION",
        error: `Duplicate selected cleanup item: ${selected.itemKey}`,
      };
    }
    seen.add(selected.itemKey);

    const item = args.itemByKey.get(selected.itemKey);
    if (!item) {
      return {
        items: [],
        code: "UNKNOWN_SELECTED_ITEM",
        error: `Selected cleanup item is not in the bound plan: ${selected.itemKey}`,
      };
    }
    if (item.snapshotHash !== selected.snapshotHash) {
      return {
        items: [],
        code: "SELECTED_SNAPSHOT_MISMATCH",
        error: `Selected cleanup item snapshot does not match the bound plan: ${selected.itemKey}`,
      };
    }
    items.push(item);
  }
  return { items };
}

function approvalCoversItem(args: {
  readonly approval:
    | CleanupDestructiveApprovalInput
    | CleanupPolicyApprovalInput
    | undefined;
  readonly actorUserId: string;
  readonly planHash: CleanupPlanHash;
  readonly item: CleanupPlanItem;
}): boolean {
  if (!args.approval) {
    return false;
  }
  if (args.approval.approvedByUserId !== args.actorUserId) {
    return false;
  }
  if (args.approval.planHash !== args.planHash) {
    return false;
  }
  return args.approval.approvedItemSnapshotHashes.includes(
    args.item.snapshotHash,
  );
}

async function validatePlanBinding(plan: CleanupPlan): Promise<string | null> {
  if (plan.schemaVersion !== CLEANUP_BULK_REVIEW_SCHEMA_VERSION) {
    return "Cleanup plan schema version is not supported";
  }
  for (const cluster of plan.clusters) {
    for (const item of cluster.items) {
      const expectedKey = getCleanupItemKey(item.snapshot);
      if (item.itemKey !== expectedKey) {
        return `Cleanup item key is not bound to its snapshot: ${item.itemKey}`;
      }
      const expectedSnapshotHash = await hashCleanupItemSnapshot(item.snapshot);
      if (item.snapshotHash !== expectedSnapshotHash) {
        return `Cleanup item snapshot hash is invalid: ${item.itemKey}`;
      }
    }
  }
  const expectedPlanHash = await computeCleanupPlanHash(plan);
  if (plan.planHash !== expectedPlanHash) {
    return "Cleanup plan hash is invalid";
  }
  return null;
}

async function applyPolicyGate(args: {
  readonly items: readonly CleanupPlanItem[];
  readonly request: CleanupExecutionRequest;
  readonly executionId: string;
  readonly auditEvents: CleanupAuditEvent[];
}): Promise<{
  readonly eligibleItems: readonly CleanupPlanItem[];
  readonly skippedItems: readonly CleanupSkippedItem[];
}> {
  const eligibleItems: CleanupPlanItem[] = [];
  const skippedItems: CleanupSkippedItem[] = [];

  for (const item of args.items) {
    const decision = args.request.policyGate
      ? await args.request.policyGate({
          actorUserId: args.request.actorUserId,
          mode: args.request.mode,
          planHash: args.request.plan.planHash,
          item,
          requestedAt: args.request.now,
        })
      : { outcome: "allow" as const };

    if (decision.outcome === "allow") {
      eligibleItems.push(item);
      continue;
    }

    if (decision.outcome === "require_user_approval") {
      const approved = approvalCoversItem({
        approval: args.request.confirmation?.policyApproval,
        actorUserId: args.request.actorUserId,
        planHash: args.request.plan.planHash,
        item,
      });
      if (approved) {
        eligibleItems.push(item);
        continue;
      }
      skippedItems.push({
        itemKey: item.itemKey,
        provider: item.snapshot.provider,
        operationKind: item.operation.kind,
        snapshotHash: item.snapshotHash,
        reasonCode: decision.code,
        reason: decision.reason,
      });
      pushAuditEvent(args.auditEvents, {
        eventType: "cleanup.bulk_review.policy_approval_required",
        emittedAt: args.request.now,
        actorUserId: args.request.actorUserId,
        planHash: args.request.plan.planHash,
        executionId: args.executionId,
        item,
        outcome: "skipped",
        code: decision.code,
        message: decision.reason,
        metadata: decision.auditMetadata,
      });
      continue;
    }

    skippedItems.push({
      itemKey: item.itemKey,
      provider: item.snapshot.provider,
      operationKind: item.operation.kind,
      snapshotHash: item.snapshotHash,
      reasonCode: decision.code,
      reason: decision.reason,
    });
    pushAuditEvent(args.auditEvents, {
      eventType: "cleanup.bulk_review.policy_denied",
      emittedAt: args.request.now,
      actorUserId: args.request.actorUserId,
      planHash: args.request.plan.planHash,
      executionId: args.executionId,
      item,
      outcome: "skipped",
      code: decision.code,
      message: decision.reason,
      metadata: decision.auditMetadata,
    });
  }

  return { eligibleItems, skippedItems };
}

async function verifyCurrentSnapshots(args: {
  readonly items: readonly CleanupPlanItem[];
  readonly adapters: CleanupAdapterRegistry;
}): Promise<{ readonly code?: string; readonly reason?: string }> {
  const byProvider = groupItemsByProvider(args.items);
  for (const [provider, items] of byProvider) {
    const adapter = args.adapters[provider];
    if (!adapter) {
      return {
        code: "ADAPTER_MISSING",
        reason: `No cleanup adapter is registered for ${provider}`,
      };
    }

    let snapshots: readonly CleanupItemSnapshot[];
    try {
      snapshots = await adapter.readCurrentSnapshots(items);
    } catch (error) {
      return {
        code: "SNAPSHOT_READ_FAILED",
        reason:
          error instanceof Error
            ? error.message
            : "Cleanup adapter failed to read current snapshots",
      };
    }

    const currentByKey = new Map<CleanupItemKey, CleanupItemSnapshot>();
    for (const snapshot of snapshots) {
      currentByKey.set(getCleanupItemKey(snapshot), snapshot);
    }

    for (const item of items) {
      const current = currentByKey.get(item.itemKey);
      if (!current) {
        return {
          code: "ITEM_SNAPSHOT_MISSING",
          reason: `Cleanup item no longer exists or cannot be read: ${item.itemKey}`,
        };
      }
      const currentHash = await hashCleanupItemSnapshot(current);
      if (currentHash !== item.snapshotHash) {
        return {
          code: "ITEM_SNAPSHOT_DRIFT",
          reason: `Cleanup item changed after review: ${item.itemKey}`,
        };
      }
    }
  }
  return {};
}

function groupItemsByProvider(
  items: readonly CleanupPlanItem[],
): ReadonlyMap<CleanupProvider, readonly CleanupPlanItem[]> {
  const byProvider = new Map<CleanupProvider, CleanupPlanItem[]>();
  for (const item of items) {
    const existing = byProvider.get(item.snapshot.provider);
    if (existing) {
      existing.push(item);
    } else {
      byProvider.set(item.snapshot.provider, [item]);
    }
  }
  return byProvider;
}

function groupUndoItemsByProvider(
  items: readonly CleanupUndoItem[],
): ReadonlyMap<CleanupProvider, readonly CleanupUndoItem[]> {
  const byProvider = new Map<CleanupProvider, CleanupUndoItem[]>();
  for (const item of items) {
    const existing = byProvider.get(item.provider);
    if (existing) {
      existing.push(item);
    } else {
      byProvider.set(item.provider, [item]);
    }
  }
  return byProvider;
}

function chunkItems<T>(
  items: readonly T[],
  chunkSize: number,
): readonly (readonly T[])[] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function toAdapterOperations(args: {
  readonly plan: CleanupPlan;
  readonly actorUserId: string;
  readonly mode: CleanupExecutionMode;
  readonly items: readonly CleanupPlanItem[];
}): readonly CleanupAdapterOperation[] {
  return args.items.map((item) => ({
    planId: args.plan.id,
    planHash: args.plan.planHash,
    actorUserId: args.actorUserId,
    mode: args.mode,
    item,
  }));
}

function adapterResultFor(
  operation: CleanupAdapterOperation,
  resultByItemKey: ReadonlyMap<CleanupItemKey, CleanupAdapterItemResult>,
): CleanupAdapterItemResult {
  return (
    resultByItemKey.get(operation.item.itemKey) ?? {
      itemKey: operation.item.itemKey,
      outcome: "failed",
      code: "ADAPTER_RESULT_MISSING",
      message: "Cleanup adapter did not return a result for this item",
    }
  );
}

function chunkStatus(
  mode: CleanupExecutionMode,
  results: readonly CleanupExecutionItemResult[],
): CleanupExecutionChunk["status"] {
  if (
    mode === "dry_run" &&
    results.every((result) => result.outcome === "planned")
  ) {
    return "planned";
  }
  const succeeded = results.some(
    (result) => result.outcome === "succeeded" || result.outcome === "planned",
  );
  const failed = results.some((result) => result.outcome === "failed");
  if (succeeded && failed) {
    return "partially_failed";
  }
  if (failed) {
    return "failed";
  }
  return "succeeded";
}

function executionStatus(
  mode: CleanupExecutionMode,
  results: readonly CleanupExecutionItemResult[],
): CleanupExecutionStatus {
  const failed = results.some((result) => result.outcome === "failed");
  const succeeded = results.some(
    (result) => result.outcome === "succeeded" || result.outcome === "planned",
  );
  if (mode === "dry_run" && !failed) {
    return "dry_run";
  }
  if (succeeded && failed) {
    return "partially_failed";
  }
  if (failed) {
    return "failed";
  }
  return "succeeded";
}

async function runAdapterChunks(args: {
  readonly request: CleanupExecutionRequest;
  readonly executionId: string;
  readonly items: readonly CleanupPlanItem[];
  readonly chunkSize: number;
  readonly auditEvents: CleanupAuditEvent[];
}): Promise<{
  readonly results: readonly CleanupExecutionItemResult[];
  readonly chunks: readonly CleanupExecutionChunk[];
}> {
  const results: CleanupExecutionItemResult[] = [];
  const chunks: CleanupExecutionChunk[] = [];
  let chunkIndex = 0;

  for (const [provider, providerItems] of groupItemsByProvider(args.items)) {
    const adapter = args.request.adapters[provider];
    if (!adapter) {
      for (const item of providerItems) {
        results.push({
          itemKey: item.itemKey,
          provider,
          operationKind: item.operation.kind,
          snapshotHash: item.snapshotHash,
          outcome: "failed",
          code: "ADAPTER_MISSING",
          message: `No cleanup adapter is registered for ${provider}`,
        });
      }
      continue;
    }

    for (const chunk of chunkItems(providerItems, args.chunkSize)) {
      const startedAt = args.request.now;
      const operations = toAdapterOperations({
        plan: args.request.plan,
        actorUserId: args.request.actorUserId,
        mode: args.request.mode,
        items: chunk,
      });

      let adapterResults: readonly CleanupAdapterItemResult[];
      try {
        const chunkResult =
          args.request.mode === "dry_run"
            ? await adapter.dryRunChunk({
                executionId: args.executionId,
                provider,
                chunkIndex,
                operations,
              })
            : await adapter.executeChunk({
                executionId: args.executionId,
                provider,
                chunkIndex,
                operations,
              });
        adapterResults = chunkResult.results;
      } catch (error) {
        adapterResults = operations.map((operation) => ({
          itemKey: operation.item.itemKey,
          outcome: "failed",
          code: "ADAPTER_CHUNK_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Cleanup adapter chunk failed",
        }));
      }

      const resultByItemKey = new Map<
        CleanupItemKey,
        CleanupAdapterItemResult
      >();
      for (const result of adapterResults) {
        resultByItemKey.set(result.itemKey, result);
      }

      const chunkResults: CleanupExecutionItemResult[] = [];
      for (const operation of operations) {
        const adapterResult = adapterResultFor(operation, resultByItemKey);
        const outcome =
          adapterResult.outcome === "succeeded"
            ? args.request.mode === "dry_run"
              ? "planned"
              : "succeeded"
            : "failed";
        const executionResult: CleanupExecutionItemResult = {
          itemKey: operation.item.itemKey,
          provider,
          operationKind: operation.item.operation.kind,
          snapshotHash: operation.item.snapshotHash,
          outcome,
          code: adapterResult.code,
          message: adapterResult.message,
          undoToken: adapterResult.undoToken,
          undoExpiresAt: adapterResult.undoExpiresAt,
        };
        chunkResults.push(executionResult);
        results.push(executionResult);

        pushAuditEvent(args.auditEvents, {
          eventType:
            outcome === "failed"
              ? "cleanup.bulk_review.item_failed"
              : args.request.mode === "dry_run"
                ? "cleanup.bulk_review.item_dry_run"
                : "cleanup.bulk_review.item_executed",
          emittedAt: args.request.now,
          actorUserId: args.request.actorUserId,
          planHash: args.request.plan.planHash,
          executionId: args.executionId,
          item: operation.item,
          outcome,
          code: adapterResult.code,
          message: adapterResult.message,
          metadata: adapterResult.metadata,
        });
      }

      chunks.push({
        chunkIndex,
        provider,
        itemKeys: operations.map((operation) => operation.item.itemKey),
        status: chunkStatus(args.request.mode, chunkResults),
        startedAt,
        completedAt: args.request.now,
      });
      chunkIndex += 1;
    }
  }

  return { results, chunks };
}

function buildCleanupUndo(args: {
  readonly executionId: string;
  readonly planHash: CleanupPlanHash;
  readonly createdAt: string;
  readonly itemsByKey: ReadonlyMap<CleanupItemKey, CleanupPlanItem>;
  readonly results: readonly CleanupExecutionItemResult[];
}): CleanupUndo | undefined {
  const undoItems: CleanupUndoItem[] = [];
  for (const result of args.results) {
    if (result.outcome !== "succeeded") {
      continue;
    }
    const item = args.itemsByKey.get(result.itemKey);
    if (!item) {
      continue;
    }
    if (
      item.operation.undoSupported &&
      result.undoToken &&
      result.undoExpiresAt
    ) {
      undoItems.push({
        itemKey: result.itemKey,
        provider: result.provider,
        operationKind: result.operationKind,
        snapshotHash: result.snapshotHash,
        undoToken: result.undoToken,
        undoExpiresAt: result.undoExpiresAt,
        eligibility: "eligible",
      });
      continue;
    }
    undoItems.push({
      itemKey: result.itemKey,
      provider: result.provider,
      operationKind: result.operationKind,
      snapshotHash: result.snapshotHash,
      eligibility: "unsupported",
      reason: item.operation.undoSupported
        ? "Cleanup adapter did not return undo material"
        : "Cleanup operation does not support undo",
    });
  }

  if (undoItems.length === 0) {
    return undefined;
  }

  const eligibleItems = undoItems.filter(
    (item) => item.eligibility === "eligible",
  );
  const expiresAt = eligibleItems
    .map((item) => item.undoExpiresAt)
    .filter((value): value is string => Boolean(value))
    .sort()[0];
  const status =
    eligibleItems.length === 0
      ? "unsupported"
      : eligibleItems.length === undoItems.length
        ? "eligible"
        : "partially_eligible";

  return {
    undoId: createUndoId(args.executionId),
    executionId: args.executionId,
    planHash: args.planHash,
    createdAt: args.createdAt,
    expiresAt,
    status,
    items: undoItems,
  };
}

export async function executeCleanupPlan(
  request: CleanupExecutionRequest,
): Promise<CleanupExecution> {
  const executionId =
    request.executionId ??
    createExecutionId(request.plan.planHash, request.now);
  const auditEvents: CleanupAuditEvent[] = [];

  let chunkSize: number;
  try {
    chunkSize = normalizeChunkSize(request.chunkSize);
  } catch (error) {
    return rejectedExecution({
      plan: request.plan,
      actorUserId: request.actorUserId,
      mode: request.mode,
      now: request.now,
      executionId,
      code: "INVALID_CHUNK_SIZE",
      reason:
        error instanceof Error
          ? error.message
          : "Cleanup chunk size is invalid",
    });
  }

  const planBindingError = await validatePlanBinding(request.plan);
  if (planBindingError) {
    return rejectedExecution({
      plan: request.plan,
      actorUserId: request.actorUserId,
      mode: request.mode,
      now: request.now,
      executionId,
      code: "PLAN_HASH_INVALID",
      reason: planBindingError,
    });
  }

  const index = makePlanIndex(request.plan);
  const maxPlanItems = request.maxPlanItems ?? DEFAULT_CLEANUP_PLAN_ITEM_LIMIT;
  if (index.itemCount > maxPlanItems) {
    return rejectedExecution({
      plan: request.plan,
      actorUserId: request.actorUserId,
      mode: request.mode,
      now: request.now,
      executionId,
      code: "PLAN_TOO_LARGE",
      reason: `Cleanup plan contains ${index.itemCount} items, limit is ${maxPlanItems}`,
    });
  }

  if (isExpired(request.plan.expiresAt, request.now)) {
    return rejectedExecution({
      plan: request.plan,
      actorUserId: request.actorUserId,
      mode: request.mode,
      now: request.now,
      executionId,
      code: "PLAN_EXPIRED",
      reason: "Cleanup plan has expired and must be regenerated",
    });
  }

  const userError = assertSameUserForConfirmation(request);
  if (userError) {
    return rejectedExecution({
      plan: request.plan,
      actorUserId: request.actorUserId,
      mode: request.mode,
      now: request.now,
      executionId,
      code: "CONFIRMATION_REQUIRED",
      reason: userError,
    });
  }

  const requestedPlanHash = getRequestedPlanHash(request);
  if (requestedPlanHash && requestedPlanHash !== request.plan.planHash) {
    return rejectedExecution({
      plan: request.plan,
      actorUserId: request.actorUserId,
      mode: request.mode,
      now: request.now,
      executionId,
      code: "CONFIRMATION_HASH_MISMATCH",
      reason: "Cleanup confirmation hash does not match the bound plan",
    });
  }

  if (request.mode === "execute" && !requestedPlanHash) {
    return rejectedExecution({
      plan: request.plan,
      actorUserId: request.actorUserId,
      mode: request.mode,
      now: request.now,
      executionId,
      code: "CONFIRMATION_HASH_REQUIRED",
      reason: "Cleanup execution requires a user-confirmed plan hash",
    });
  }

  const selectedItems = selectedItemsForRequest(request);
  if (!selectedItems) {
    return rejectedExecution({
      plan: request.plan,
      actorUserId: request.actorUserId,
      mode: request.mode,
      now: request.now,
      executionId,
      code: "SELECTION_REQUIRED",
      reason: "Cleanup review requires an explicit item selection",
    });
  }

  const selection = resolveSelectedItems({
    itemByKey: index.itemByKey,
    selectedItems,
  });
  if (selection.error) {
    return rejectedExecution({
      plan: request.plan,
      actorUserId: request.actorUserId,
      mode: request.mode,
      now: request.now,
      executionId,
      code: selection.code ?? "SELECTION_INVALID",
      reason: selection.error,
    });
  }

  const policyResult = await applyPolicyGate({
    items: selection.items,
    request,
    executionId,
    auditEvents,
  });

  if (policyResult.eligibleItems.length === 0) {
    return {
      executionId,
      planId: request.plan.id,
      planHash: request.plan.planHash,
      mode: request.mode,
      status: "rejected",
      actorUserId: request.actorUserId,
      requestedItemCount: selection.items.length,
      eligibleItemCount: 0,
      skippedItems: policyResult.skippedItems,
      results: [],
      chunks: [],
      auditEvents,
      createdAt: request.now,
      completedAt: request.now,
      rejectionCode: "NO_ELIGIBLE_ITEMS",
      rejectionReason: "No selected cleanup items passed policy checks",
    };
  }

  if (request.mode === "execute") {
    const unapprovedDestructiveItem = policyResult.eligibleItems.find(
      (item) =>
        item.operation.requiresUserApproval &&
        !approvalCoversItem({
          approval: request.confirmation?.destructiveApproval,
          actorUserId: request.actorUserId,
          planHash: request.plan.planHash,
          item,
        }),
    );
    if (unapprovedDestructiveItem) {
      return rejectedExecution({
        plan: request.plan,
        actorUserId: request.actorUserId,
        mode: request.mode,
        now: request.now,
        executionId,
        code: "DESTRUCTIVE_APPROVAL_REQUIRED",
        reason: `Destructive cleanup operation requires user approval: ${unapprovedDestructiveItem.itemKey}`,
        auditEvents,
      });
    }

    const snapshotValidation = await verifyCurrentSnapshots({
      items: policyResult.eligibleItems,
      adapters: request.adapters,
    });
    if (snapshotValidation.code) {
      return rejectedExecution({
        plan: request.plan,
        actorUserId: request.actorUserId,
        mode: request.mode,
        now: request.now,
        executionId,
        code: snapshotValidation.code,
        reason:
          snapshotValidation.reason ??
          "Cleanup item snapshot verification failed",
        auditEvents,
      });
    }
  }

  const adapterRun = await runAdapterChunks({
    request,
    executionId,
    items: policyResult.eligibleItems,
    chunkSize,
    auditEvents,
  });

  const undo =
    request.mode === "execute"
      ? buildCleanupUndo({
          executionId,
          planHash: request.plan.planHash,
          createdAt: request.now,
          itemsByKey: index.itemByKey,
          results: adapterRun.results,
        })
      : undefined;

  return {
    executionId,
    planId: request.plan.id,
    planHash: request.plan.planHash,
    mode: request.mode,
    status: executionStatus(request.mode, adapterRun.results),
    actorUserId: request.actorUserId,
    requestedItemCount: selection.items.length,
    eligibleItemCount: policyResult.eligibleItems.length,
    skippedItems: policyResult.skippedItems,
    results: adapterRun.results,
    chunks: adapterRun.chunks,
    auditEvents,
    undo,
    createdAt: request.now,
    completedAt: request.now,
  };
}

export function getCleanupUndoEligibility(
  undo: CleanupUndo,
  now: string,
): CleanupUndoEligibility {
  if (undo.status === "unsupported") {
    return {
      eligible: false,
      code: "UNDO_UNSUPPORTED",
      reason: "Cleanup execution did not produce undoable operations",
    };
  }
  if (isExpired(undo.expiresAt, now)) {
    return {
      eligible: false,
      code: "UNDO_EXPIRED",
      reason: "Cleanup undo window has expired",
    };
  }
  const hasEligibleItems = undo.items.some(
    (item) => item.eligibility === "eligible",
  );
  if (!hasEligibleItems) {
    return {
      eligible: false,
      code: "UNDO_UNSUPPORTED",
      reason: "Cleanup execution did not produce undoable operations",
    };
  }
  return { eligible: true };
}

function rejectedUndoExecution(args: {
  readonly undo: CleanupUndo;
  readonly actorUserId: string;
  readonly now: string;
  readonly code: string;
  readonly reason: string;
}): CleanupUndoExecution {
  const auditEvents: CleanupAuditEvent[] = [];
  pushAuditEvent(auditEvents, {
    eventType: "cleanup.bulk_review.undo_rejected",
    emittedAt: args.now,
    actorUserId: args.actorUserId,
    planHash: args.undo.planHash,
    executionId: args.undo.executionId,
    undoId: args.undo.undoId,
    outcome: "rejected",
    code: args.code,
    message: args.reason,
  });
  return {
    undoId: args.undo.undoId,
    executionId: args.undo.executionId,
    planHash: args.undo.planHash,
    actorUserId: args.actorUserId,
    status: "rejected",
    results: [],
    auditEvents,
    createdAt: args.now,
    completedAt: args.now,
    rejectionCode: args.code,
    rejectionReason: args.reason,
  };
}

function undoExecutionStatus(
  results: readonly CleanupUndoAdapterItemResult[],
): CleanupUndoExecution["status"] {
  const failed = results.some((result) => result.outcome === "failed");
  const succeeded = results.some((result) => result.outcome === "succeeded");
  if (succeeded && failed) {
    return "partially_failed";
  }
  if (failed) {
    return "failed";
  }
  return "succeeded";
}

export async function undoCleanupExecution(
  request: CleanupUndoExecutionRequest,
): Promise<CleanupUndoExecution> {
  let chunkSize: number;
  try {
    chunkSize = normalizeChunkSize(request.chunkSize);
  } catch (error) {
    return rejectedUndoExecution({
      undo: request.undo,
      actorUserId: request.actorUserId,
      now: request.now,
      code: "INVALID_CHUNK_SIZE",
      reason:
        error instanceof Error
          ? error.message
          : "Cleanup undo chunk size is invalid",
    });
  }

  if (request.confirmation.confirmedByUserId !== request.actorUserId) {
    return rejectedUndoExecution({
      undo: request.undo,
      actorUserId: request.actorUserId,
      now: request.now,
      code: "UNDO_CONFIRMATION_USER_MISMATCH",
      reason: "Cleanup undo confirmation belongs to a different user",
    });
  }
  if (
    request.confirmation.planHash !== request.undo.planHash ||
    request.confirmation.undoId !== request.undo.undoId ||
    request.confirmation.executionId !== request.undo.executionId
  ) {
    return rejectedUndoExecution({
      undo: request.undo,
      actorUserId: request.actorUserId,
      now: request.now,
      code: "UNDO_CONFIRMATION_MISMATCH",
      reason: "Cleanup undo confirmation does not match the undo record",
    });
  }

  const eligibility = getCleanupUndoEligibility(request.undo, request.now);
  if (!eligibility.eligible) {
    return rejectedUndoExecution({
      undo: request.undo,
      actorUserId: request.actorUserId,
      now: request.now,
      code: eligibility.code ?? "UNDO_UNAVAILABLE",
      reason: eligibility.reason ?? "Cleanup undo is unavailable",
    });
  }

  const auditEvents: CleanupAuditEvent[] = [];
  const results: CleanupUndoAdapterItemResult[] = [];
  let chunkIndex = 0;
  const eligibleItems = request.undo.items.filter(
    (item) => item.eligibility === "eligible",
  );

  for (const [provider, providerItems] of groupUndoItemsByProvider(
    eligibleItems,
  )) {
    const adapter = request.adapters[provider];
    if (!adapter?.undoChunk) {
      for (const item of providerItems) {
        const failed: CleanupUndoAdapterItemResult = {
          itemKey: item.itemKey,
          outcome: "failed",
          code: "UNDO_UNSUPPORTED_BY_ADAPTER",
          message: `Cleanup adapter for ${provider} does not support undo`,
        };
        results.push(failed);
        pushAuditEvent(auditEvents, {
          eventType: "cleanup.bulk_review.undo_failed",
          emittedAt: request.now,
          actorUserId: request.actorUserId,
          planHash: request.undo.planHash,
          executionId: request.undo.executionId,
          undoId: request.undo.undoId,
          undoItem: item,
          outcome: "failed",
          code: failed.code,
          message: failed.message,
        });
      }
      continue;
    }

    for (const chunk of chunkItems(providerItems, chunkSize)) {
      let adapterResults: readonly CleanupUndoAdapterItemResult[];
      try {
        const chunkResult = await adapter.undoChunk({
          undoId: request.undo.undoId,
          provider,
          chunkIndex,
          operations: chunk.map((item) => ({
            undoId: request.undo.undoId,
            planHash: request.undo.planHash,
            actorUserId: request.actorUserId,
            item,
          })),
        });
        adapterResults = chunkResult.results;
      } catch (error) {
        adapterResults = chunk.map((item) => ({
          itemKey: item.itemKey,
          outcome: "failed",
          code: "UNDO_CHUNK_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Cleanup adapter undo chunk failed",
        }));
      }

      const resultByItemKey = new Map<
        CleanupItemKey,
        CleanupUndoAdapterItemResult
      >();
      for (const result of adapterResults) {
        resultByItemKey.set(result.itemKey, result);
      }

      for (const item of chunk) {
        const result = resultByItemKey.get(item.itemKey) ?? {
          itemKey: item.itemKey,
          outcome: "failed" as const,
          code: "UNDO_RESULT_MISSING",
          message:
            "Cleanup adapter did not return an undo result for this item",
        };
        results.push(result);
        pushAuditEvent(auditEvents, {
          eventType:
            result.outcome === "succeeded"
              ? "cleanup.bulk_review.undo_executed"
              : "cleanup.bulk_review.undo_failed",
          emittedAt: request.now,
          actorUserId: request.actorUserId,
          planHash: request.undo.planHash,
          executionId: request.undo.executionId,
          undoId: request.undo.undoId,
          undoItem: item,
          outcome: result.outcome,
          code: result.code,
          message: result.message,
          metadata: result.metadata,
        });
      }
      chunkIndex += 1;
    }
  }

  return {
    undoId: request.undo.undoId,
    executionId: request.undo.executionId,
    planHash: request.undo.planHash,
    actorUserId: request.actorUserId,
    status: undoExecutionStatus(results),
    results,
    auditEvents,
    createdAt: request.now,
    completedAt: request.now,
  };
}
