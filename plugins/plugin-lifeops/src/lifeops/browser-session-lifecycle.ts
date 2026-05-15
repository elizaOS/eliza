import type { LifeOpsBrowserSession } from "@elizaos/shared";

export type BrowserTaskArtifact = {
  kind: string;
  label: string | null;
  detail: string | null;
  uploaded: boolean;
  data: Record<string, unknown>;
  createdAt: string;
};

export type BrowserTaskIntervention = {
  kind: string;
  reason: string | null;
  status: "requested" | "resolved";
  channel: string | null;
  requestedAt: string;
  resolvedAt: string | null;
  detail: string | null;
};

export type BrowserTaskProvenance = {
  provider: string | null;
  label: string | null;
  url: string | null;
  externalId: string | null;
  detail: string | null;
  createdAt: string;
};

export type BrowserTaskSummary = {
  workflowKind: string | null;
  approvalRequired: boolean;
  approvalSatisfied: boolean;
  completed: boolean;
  needsHuman: boolean;
  blockedReason: string | null;
  artifacts: BrowserTaskArtifact[];
  artifactCount: number;
  uploadedAssets: BrowserTaskArtifact[];
  uploadedAssetCount: number;
  interventions: BrowserTaskIntervention[];
  interventionCount: number;
  provenance: BrowserTaskProvenance[];
  provenanceCount: number;
  resumedAt: string | null;
  lastUpdatedAt: string | null;
};

type BrowserTaskPatch = Partial<BrowserTaskSummary> & {
  artifacts?: unknown;
  uploadedAssets?: unknown;
  interventions?: unknown;
  provenance?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function browserTaskPatchFromContainer(value: unknown): BrowserTaskPatch {
  if (!isRecord(value)) {
    return {};
  }
  const nested = value.browserTask;
  return isRecord(nested) ? { ...nested } : {};
}

function browserTaskFromSession(
  session: Pick<LifeOpsBrowserSession, "result">,
) {
  return browserTaskPatchFromContainer(session.result);
}

function artifactKey(artifact: BrowserTaskArtifact): string {
  return [
    artifact.kind,
    artifact.label ?? "",
    artifact.detail ?? "",
    artifact.uploaded ? "1" : "0",
  ].join("|");
}

function interventionKey(intervention: BrowserTaskIntervention): string {
  return [
    intervention.kind,
    intervention.reason ?? "",
    intervention.channel ?? "",
  ].join("|");
}

function provenanceKey(provenance: BrowserTaskProvenance): string {
  return [
    provenance.provider ?? "",
    provenance.label ?? "",
    provenance.url ?? "",
    provenance.externalId ?? "",
  ].join("|");
}

function normalizeArtifact(
  value: unknown,
  now: string,
): BrowserTaskArtifact | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = stringOrNull(value.kind);
  if (!kind) {
    return null;
  }
  return {
    kind,
    label: stringOrNull(value.label),
    detail: stringOrNull(value.detail),
    uploaded: value.uploaded === true,
    data: recordOrEmpty(value.data),
    createdAt: stringOrNull(value.createdAt) ?? now,
  };
}

function normalizeIntervention(
  value: unknown,
  now: string,
): BrowserTaskIntervention | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = stringOrNull(value.kind);
  if (!kind) {
    return null;
  }
  const requestedAt = stringOrNull(value.requestedAt) ?? now;
  const status = value.status === "resolved" ? "resolved" : "requested";
  return {
    kind,
    reason: stringOrNull(value.reason),
    status,
    channel: stringOrNull(value.channel),
    requestedAt,
    resolvedAt:
      status === "resolved"
        ? (stringOrNull(value.resolvedAt) ?? now)
        : stringOrNull(value.resolvedAt),
    detail: stringOrNull(value.detail),
  };
}

function normalizeProvenance(
  value: unknown,
  now: string,
): BrowserTaskProvenance | null {
  if (!isRecord(value)) {
    return null;
  }
  const provider = stringOrNull(value.provider);
  const label = stringOrNull(value.label);
  const url = stringOrNull(value.url);
  const externalId = stringOrNull(value.externalId);
  if (!provider && !label && !url && !externalId) {
    return null;
  }
  return {
    provider,
    label,
    url,
    externalId,
    detail: stringOrNull(value.detail),
    createdAt: stringOrNull(value.createdAt) ?? now,
  };
}

function dedupeByKey<T>(values: T[], keyFor: (value: T) => string): T[] {
  const map = new Map<string, T>();
  for (const value of values) {
    map.set(keyFor(value), value);
  }
  return [...map.values()];
}

function normalizeArtifacts(
  value: unknown,
  now: string,
): BrowserTaskArtifact[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeArtifact(entry, now))
    .filter((entry): entry is BrowserTaskArtifact => entry !== null);
}

function normalizeInterventions(
  value: unknown,
  now: string,
): BrowserTaskIntervention[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeIntervention(entry, now))
    .filter((entry): entry is BrowserTaskIntervention => entry !== null);
}

function normalizeProvenanceList(
  value: unknown,
  now: string,
): BrowserTaskProvenance[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeProvenance(entry, now))
    .filter((entry): entry is BrowserTaskProvenance => entry !== null);
}

function emptySummary(
  session: Pick<LifeOpsBrowserSession, "actions" | "status" | "metadata">,
): BrowserTaskSummary {
  const workflowKind = isRecord(session.metadata)
    ? stringOrNull(session.metadata.workflowKind)
    : null;
  const approvalRequired = session.actions.some(
    (action) => action.accountAffecting || action.requiresConfirmation,
  );
  return {
    workflowKind,
    approvalRequired,
    approvalSatisfied: session.status !== "awaiting_confirmation",
    completed: session.status === "done",
    needsHuman: false,
    blockedReason: null,
    artifacts: [],
    artifactCount: 0,
    uploadedAssets: [],
    uploadedAssetCount: 0,
    interventions: [],
    interventionCount: 0,
    provenance: [],
    provenanceCount: 0,
    resumedAt: null,
    lastUpdatedAt: null,
  };
}

function normalizedSummary(
  session: Pick<
    LifeOpsBrowserSession,
    "actions" | "status" | "metadata" | "result"
  >,
): BrowserTaskSummary {
  const base = emptySummary(session);
  const patch = browserTaskFromSession(session);
  const artifacts = dedupeByKey(
    normalizeArtifacts(
      patch.artifacts,
      patch.lastUpdatedAt ?? new Date().toISOString(),
    ),
    artifactKey,
  );
  const uploadedAssets = dedupeByKey(
    normalizeArtifacts(
      patch.uploadedAssets,
      patch.lastUpdatedAt ?? new Date().toISOString(),
    ),
    artifactKey,
  );
  const interventions = dedupeByKey(
    normalizeInterventions(
      patch.interventions,
      patch.lastUpdatedAt ?? new Date().toISOString(),
    ),
    interventionKey,
  );
  const provenance = dedupeByKey(
    normalizeProvenanceList(
      patch.provenance,
      patch.lastUpdatedAt ?? new Date().toISOString(),
    ),
    provenanceKey,
  );
  const explicitNeedsHuman = booleanOrUndefined(patch.needsHuman);
  const pendingIntervention = interventions.some(
    (intervention) => intervention.status === "requested",
  );
  const blockedReason =
    stringOrNull(patch.blockedReason) ??
    interventions.find((intervention) => intervention.status === "requested")
      ?.reason ??
    null;
  const approvalRequired =
    booleanOrUndefined(patch.approvalRequired) ?? base.approvalRequired;
  const approvalSatisfied =
    booleanOrUndefined(patch.approvalSatisfied) ?? base.approvalSatisfied;
  const completed = booleanOrUndefined(patch.completed) ?? base.completed;
  const resumedAt = stringOrNull(patch.resumedAt);
  return {
    workflowKind: stringOrNull(patch.workflowKind) ?? base.workflowKind,
    approvalRequired,
    approvalSatisfied,
    completed,
    needsHuman: explicitNeedsHuman ?? pendingIntervention,
    blockedReason,
    artifacts,
    artifactCount: artifacts.length,
    uploadedAssets,
    uploadedAssetCount: uploadedAssets.length,
    interventions,
    interventionCount: interventions.length,
    provenance,
    provenanceCount: provenance.length,
    resumedAt,
    lastUpdatedAt: stringOrNull(patch.lastUpdatedAt),
  };
}

export function summarizeBrowserTaskLifecycle(
  session: Pick<
    LifeOpsBrowserSession,
    "actions" | "status" | "metadata" | "result"
  >,
): BrowserTaskSummary {
  return normalizedSummary(session);
}

function mergePatch(
  current: BrowserTaskSummary,
  patch: BrowserTaskPatch,
  now: string,
): BrowserTaskSummary {
  const incomingArtifacts = normalizeArtifacts(patch.artifacts, now);
  const incomingUploadedAssets = normalizeArtifacts(patch.uploadedAssets, now);
  const incomingInterventions = normalizeInterventions(
    patch.interventions,
    now,
  );
  const incomingProvenance = normalizeProvenanceList(patch.provenance, now);
  const artifacts = dedupeByKey(
    [...current.artifacts, ...incomingArtifacts, ...incomingUploadedAssets],
    artifactKey,
  );
  const uploadedAssets = dedupeByKey(
    [
      ...current.uploadedAssets,
      ...incomingUploadedAssets,
      ...incomingArtifacts.filter((artifact) => artifact.uploaded),
    ],
    artifactKey,
  );
  const interventions = dedupeByKey(
    [...current.interventions, ...incomingInterventions],
    interventionKey,
  );
  const provenance = dedupeByKey(
    [...current.provenance, ...incomingProvenance],
    provenanceKey,
  );
  const explicitNeedsHuman = booleanOrUndefined(patch.needsHuman);
  const pendingIntervention = interventions.some(
    (intervention) => intervention.status === "requested",
  );
  const nextNeedsHuman = explicitNeedsHuman ?? pendingIntervention;
  const resumedAt =
    stringOrNull(patch.resumedAt) ??
    (!nextNeedsHuman && current.needsHuman ? now : current.resumedAt);
  const blockedReason =
    stringOrNull(patch.blockedReason) ??
    interventions.find((intervention) => intervention.status === "requested")
      ?.reason ??
    null;
  return {
    workflowKind: stringOrNull(patch.workflowKind) ?? current.workflowKind,
    approvalRequired:
      booleanOrUndefined(patch.approvalRequired) ?? current.approvalRequired,
    approvalSatisfied:
      booleanOrUndefined(patch.approvalSatisfied) ?? current.approvalSatisfied,
    completed: booleanOrUndefined(patch.completed) ?? current.completed,
    needsHuman: nextNeedsHuman,
    blockedReason,
    artifacts,
    artifactCount: artifacts.length,
    uploadedAssets,
    uploadedAssetCount: uploadedAssets.length,
    interventions,
    interventionCount: interventions.length,
    provenance,
    provenanceCount: provenance.length,
    resumedAt,
    lastUpdatedAt: now,
  };
}

export function mergeBrowserTaskLifecycle(args: {
  session: Pick<
    LifeOpsBrowserSession,
    "actions" | "status" | "metadata" | "result"
  >;
  resultPatch?: Record<string, unknown>;
  metadataPatch?: Record<string, unknown>;
  now: string;
  approvalSatisfied?: boolean;
  completed?: boolean;
}): { result: Record<string, unknown>; metadata: Record<string, unknown> } {
  const current = normalizedSummary(args.session);
  const nextFromResult = mergePatch(
    current,
    browserTaskPatchFromContainer(args.resultPatch),
    args.now,
  );
  const nextFromMetadata = mergePatch(
    nextFromResult,
    browserTaskPatchFromContainer(args.metadataPatch),
    args.now,
  );
  const next: BrowserTaskSummary = {
    ...nextFromMetadata,
    approvalSatisfied:
      args.approvalSatisfied ?? nextFromMetadata.approvalSatisfied,
    completed: args.completed ?? nextFromMetadata.completed,
    lastUpdatedAt: args.now,
  };
  return {
    result: {
      ...(isRecord(args.session.result) ? args.session.result : {}),
      ...(isRecord(args.resultPatch) ? args.resultPatch : {}),
      browserTask: next,
    },
    metadata: {
      ...(isRecord(args.session.metadata) ? args.session.metadata : {}),
      ...(isRecord(args.metadataPatch) ? args.metadataPatch : {}),
      browserTask: {
        workflowKind: next.workflowKind,
        blockedReason: next.blockedReason,
        resumedAt: next.resumedAt,
        lastUpdatedAt: next.lastUpdatedAt,
      },
    },
  };
}
