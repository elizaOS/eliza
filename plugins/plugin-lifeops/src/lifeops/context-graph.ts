export const LIFEOPS_CONTEXT_GRAPH_SOURCE_FAMILIES = [
  "gmail",
  "calendar",
  "drive",
  "browser",
  "contacts",
  "memory",
] as const;

export type LifeOpsContextGraphSourceFamily =
  (typeof LIFEOPS_CONTEXT_GRAPH_SOURCE_FAMILIES)[number];

export const LIFEOPS_CONTEXT_GRAPH_NODE_KINDS = [
  "person",
  "organization",
  "event",
  "message",
  "document",
  "webpage",
  "memory",
  "topic",
  "place",
  "task",
] as const;

export type LifeOpsContextGraphNodeKind =
  (typeof LIFEOPS_CONTEXT_GRAPH_NODE_KINDS)[number];

export const LIFEOPS_CONTEXT_GRAPH_EDGE_KINDS = [
  "same_as",
  "mentions",
  "sent_by",
  "received_from",
  "attends",
  "organizes",
  "references",
  "scheduled_for",
  "located_at",
  "works_with",
  "owns",
  "relates_to",
] as const;

export type LifeOpsContextGraphEdgeKind =
  (typeof LIFEOPS_CONTEXT_GRAPH_EDGE_KINDS)[number];

export const LIFEOPS_CONTEXT_GRAPH_IDENTITY_REF_TYPES = [
  "email",
  "phone",
  "contact_id",
  "calendar_attendee",
  "platform_user",
  "memory_entity",
] as const;

export type LifeOpsContextGraphIdentityRefType =
  (typeof LIFEOPS_CONTEXT_GRAPH_IDENTITY_REF_TYPES)[number];

export const LIFEOPS_CONTEXT_GRAPH_SENSITIVITY_SCOPES = [
  "public",
  "personal",
  "private",
  "sensitive",
  "secret",
] as const;

export type LifeOpsContextGraphSensitivity =
  (typeof LIFEOPS_CONTEXT_GRAPH_SENSITIVITY_SCOPES)[number];

export const LIFEOPS_CONTEXT_GRAPH_PERMISSION_SCOPES = [
  "planner",
  "inbox",
  "calendar",
  "drive",
  "browser",
  "contacts",
  "memory",
  "identity",
  "health",
  "finance",
] as const;

export type LifeOpsContextGraphPermissionScope =
  (typeof LIFEOPS_CONTEXT_GRAPH_PERMISSION_SCOPES)[number];

export type LifeOpsContextGraphJson =
  | string
  | number
  | boolean
  | null
  | readonly LifeOpsContextGraphJson[]
  | { readonly [key: string]: LifeOpsContextGraphJson };

export type LifeOpsContextGraphMetadata = Readonly<
  Record<string, LifeOpsContextGraphJson>
>;

export type LifeOpsContextGraphErrorCode =
  | "INVALID_SOURCE_FAMILY"
  | "INVALID_NODE_KIND"
  | "INVALID_EDGE_KIND"
  | "INVALID_IDENTITY_REF"
  | "INVALID_SENSITIVITY"
  | "INVALID_PERMISSION_SCOPE"
  | "INVALID_PROVENANCE"
  | "INVALID_CONFIDENCE"
  | "INVALID_OBSERVATION"
  | "INVALID_QUERY"
  | "NODE_NOT_FOUND";

export class LifeOpsContextGraphError extends Error {
  constructor(
    public readonly code: LifeOpsContextGraphErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LifeOpsContextGraphError";
  }
}

export type LifeOpsContextGraphWithheldReason =
  | "missing_permission_scope"
  | "sensitivity_scope_restricted"
  | "source_family_not_allowed"
  | "expired_evidence"
  | "policy_denied";

export type LifeOpsContextGraphDegradedReason =
  | "stale_evidence"
  | "low_confidence"
  | "partial_evidence_withheld"
  | "policy_degraded";

export interface LifeOpsContextGraphIdentityRefInput {
  readonly type: LifeOpsContextGraphIdentityRefType;
  readonly value: string;
  readonly sourceFamily?: LifeOpsContextGraphSourceFamily;
  readonly verified?: boolean;
}

export interface LifeOpsContextGraphIdentityRef
  extends LifeOpsContextGraphIdentityRefInput {
  readonly normalizedValue: string;
}

export interface LifeOpsContextGraphExternalRef {
  readonly sourceFamily: LifeOpsContextGraphSourceFamily;
  readonly sourceId: string;
  readonly url?: string;
}

export interface LifeOpsContextGraphProvenanceInput {
  readonly sourceFamily: LifeOpsContextGraphSourceFamily;
  readonly sourceId: string;
  readonly connectorId: string;
  readonly observedAt: string;
  readonly accountId?: string;
  readonly url?: string;
  readonly rawContentHash?: string;
  readonly adapterVersion?: string;
}

export interface LifeOpsContextGraphProvenance
  extends LifeOpsContextGraphProvenanceInput {}

export interface LifeOpsContextGraphEvidenceInput {
  readonly summary: string;
  readonly confidence: number;
  readonly sensitivity: LifeOpsContextGraphSensitivity;
  readonly permissionScopes: readonly LifeOpsContextGraphPermissionScope[];
  readonly provenance: LifeOpsContextGraphProvenanceInput;
  readonly quote?: string;
  readonly staleAfter?: string | null;
  readonly expiresAt?: string | null;
  readonly metadata?: LifeOpsContextGraphMetadata;
}

export interface LifeOpsContextGraphEvidence {
  readonly id: string;
  readonly summary: string;
  readonly confidence: number;
  readonly sensitivity: LifeOpsContextGraphSensitivity;
  readonly permissionScopes: readonly LifeOpsContextGraphPermissionScope[];
  readonly provenance: readonly LifeOpsContextGraphProvenance[];
  readonly quote?: string;
  readonly staleAfter: string | null;
  readonly expiresAt: string | null;
  readonly metadata: LifeOpsContextGraphMetadata;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
}

export interface LifeOpsContextGraphNodeInput {
  readonly kind: LifeOpsContextGraphNodeKind;
  readonly label: string;
  readonly evidence: readonly LifeOpsContextGraphEvidenceInput[];
  readonly stableKey?: string;
  readonly summary?: string;
  readonly identityRefs?: readonly LifeOpsContextGraphIdentityRefInput[];
  readonly externalRefs?: readonly LifeOpsContextGraphExternalRef[];
  readonly properties?: LifeOpsContextGraphMetadata;
}

export interface LifeOpsContextGraphNode {
  readonly id: string;
  readonly kind: LifeOpsContextGraphNodeKind;
  readonly label: string;
  readonly confidence: number;
  readonly sensitivity: LifeOpsContextGraphSensitivity;
  readonly evidence: readonly LifeOpsContextGraphEvidence[];
  readonly stableKey: string | null;
  readonly summary: string | null;
  readonly identityRefs: readonly LifeOpsContextGraphIdentityRef[];
  readonly externalRefs: readonly LifeOpsContextGraphExternalRef[];
  readonly properties: LifeOpsContextGraphMetadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type LifeOpsContextGraphNodeReferenceInput =
  | { readonly nodeId: string }
  | {
      readonly kind: LifeOpsContextGraphNodeKind;
      readonly stableKey: string;
    }
  | {
      readonly kind: "person";
      readonly identityRefs: readonly LifeOpsContextGraphIdentityRefInput[];
    };

export interface LifeOpsContextGraphEdgeInput {
  readonly kind: LifeOpsContextGraphEdgeKind;
  readonly source: LifeOpsContextGraphNodeReferenceInput;
  readonly target: LifeOpsContextGraphNodeReferenceInput;
  readonly evidence: readonly LifeOpsContextGraphEvidenceInput[];
  readonly stableKey?: string;
  readonly properties?: LifeOpsContextGraphMetadata;
}

export interface LifeOpsContextGraphEdge {
  readonly id: string;
  readonly kind: LifeOpsContextGraphEdgeKind;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly confidence: number;
  readonly sensitivity: LifeOpsContextGraphSensitivity;
  readonly evidence: readonly LifeOpsContextGraphEvidence[];
  readonly stableKey: string | null;
  readonly properties: LifeOpsContextGraphMetadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LifeOpsContextGraphObservation {
  readonly id: string;
  readonly capturedAt: string;
  readonly nodes: readonly LifeOpsContextGraphNodeInput[];
  readonly edges?: readonly LifeOpsContextGraphEdgeInput[];
}

export interface LifeOpsContextGraphIngestResult {
  readonly observationId: string;
  readonly nodesCreated: number;
  readonly nodesUpdated: number;
  readonly edgesCreated: number;
  readonly edgesUpdated: number;
  readonly evidenceCreated: number;
  readonly evidenceMerged: number;
}

export interface LifeOpsContextGraphActor {
  readonly kind: "planner" | "user" | "system";
  readonly id?: string;
  readonly permissionScopes?: readonly LifeOpsContextGraphPermissionScope[];
}

export interface LifeOpsContextGraphPolicyRequest {
  readonly operation: "planner_slice";
  readonly actor: LifeOpsContextGraphActor;
  readonly targetType: "node" | "edge";
  readonly targetId: string;
  readonly evidence: LifeOpsContextGraphEvidence;
  readonly requiredPermissionScopes: readonly LifeOpsContextGraphPermissionScope[];
  readonly maxSensitivity: LifeOpsContextGraphSensitivity;
  readonly now: string;
}

export type LifeOpsContextGraphPolicyDecision =
  | {
      readonly allow: true;
      readonly redaction?: "summary_only" | "none";
      readonly degradedReasons?: readonly LifeOpsContextGraphDegradedReason[];
    }
  | {
      readonly allow: false;
      readonly reason?: LifeOpsContextGraphWithheldReason;
    };

export type LifeOpsContextGraphPolicyGate = (
  request: LifeOpsContextGraphPolicyRequest,
) =>
  | LifeOpsContextGraphPolicyDecision
  | Promise<LifeOpsContextGraphPolicyDecision>;

export interface LifeOpsContextGraphQuery {
  readonly focus?: LifeOpsContextGraphNodeReferenceInput;
  readonly depth?: number;
  readonly limit?: number;
  readonly nodeKinds?: readonly LifeOpsContextGraphNodeKind[];
  readonly edgeKinds?: readonly LifeOpsContextGraphEdgeKind[];
  readonly sourceFamilies?: readonly LifeOpsContextGraphSourceFamily[];
  readonly requiredPermissionScopes?: readonly LifeOpsContextGraphPermissionScope[];
  readonly maxSensitivity?: LifeOpsContextGraphSensitivity;
  readonly includeEdges?: boolean;
  readonly includeEvidence?: boolean;
  readonly includeEvidenceQuotes?: boolean;
  readonly actor?: LifeOpsContextGraphActor;
  readonly now?: string | Date;
}

export interface LifeOpsPlannerSliceProvenance {
  readonly sourceFamily: LifeOpsContextGraphSourceFamily;
  readonly sourceId: string;
  readonly connectorId: string;
  readonly observedAt: string;
}

export interface LifeOpsPlannerSliceEvidence {
  readonly evidenceId: string;
  readonly summary: string;
  readonly confidence: number;
  readonly sensitivity: LifeOpsContextGraphSensitivity;
  readonly provenance: readonly LifeOpsPlannerSliceProvenance[];
  readonly degradedReasons: readonly LifeOpsContextGraphDegradedReason[];
  readonly redacted: boolean;
  readonly quote?: string;
}

export interface LifeOpsPlannerSliceNode {
  readonly id: string;
  readonly kind: LifeOpsContextGraphNodeKind;
  readonly label: string;
  readonly summary: string | null;
  readonly confidence: number;
  readonly sensitivity: LifeOpsContextGraphSensitivity;
  readonly evidence: readonly LifeOpsPlannerSliceEvidence[];
  readonly evidenceCount: number;
  readonly withheldEvidenceCount: number;
  readonly degradedReasons: readonly LifeOpsContextGraphDegradedReason[];
}

export interface LifeOpsPlannerSliceEdge {
  readonly id: string;
  readonly kind: LifeOpsContextGraphEdgeKind;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly confidence: number;
  readonly sensitivity: LifeOpsContextGraphSensitivity;
  readonly evidence: readonly LifeOpsPlannerSliceEvidence[];
  readonly evidenceCount: number;
  readonly withheldEvidenceCount: number;
  readonly degradedReasons: readonly LifeOpsContextGraphDegradedReason[];
}

export interface LifeOpsContextGraphWithheldItem {
  readonly targetType: "node" | "edge";
  readonly targetId: string;
  readonly evidenceId: string;
  readonly reason: LifeOpsContextGraphWithheldReason;
  readonly sourceFamilies: readonly LifeOpsContextGraphSourceFamily[];
}

export interface LifeOpsContextGraphDegradedItem {
  readonly targetType: "node" | "edge";
  readonly targetId: string;
  readonly evidenceId: string;
  readonly reasons: readonly LifeOpsContextGraphDegradedReason[];
}

export interface LifeOpsPlannerSlice {
  readonly nodes: readonly LifeOpsPlannerSliceNode[];
  readonly edges: readonly LifeOpsPlannerSliceEdge[];
  readonly withheld: readonly LifeOpsContextGraphWithheldItem[];
  readonly degraded: readonly LifeOpsContextGraphDegradedItem[];
  readonly requestedLimit: number;
  readonly appliedLimit: number;
  readonly generatedAt: string;
}

export interface LifeOpsContextGraphOptions {
  readonly policyGate?: LifeOpsContextGraphPolicyGate;
  readonly maxQueryLimit?: number;
  readonly staleConfidenceMultiplier?: number;
}

interface NormalizedEvidenceList {
  readonly evidence: readonly LifeOpsContextGraphEvidence[];
  readonly created: number;
  readonly merged: number;
}

interface EvidenceProjection {
  readonly evidence: readonly LifeOpsPlannerSliceEvidence[];
  readonly withheld: readonly LifeOpsContextGraphWithheldItem[];
  readonly degraded: readonly LifeOpsContextGraphDegradedItem[];
}

interface QueryContext {
  readonly actor: LifeOpsContextGraphActor;
  readonly requiredPermissionScopes: readonly LifeOpsContextGraphPermissionScope[];
  readonly maxSensitivity: LifeOpsContextGraphSensitivity;
  readonly allowedSourceFamilies: ReadonlySet<LifeOpsContextGraphSourceFamily>;
  readonly includeEvidenceQuotes: boolean;
  readonly now: Date;
  readonly nowIso: string;
}

const SOURCE_FAMILY_SET = new Set<LifeOpsContextGraphSourceFamily>(
  LIFEOPS_CONTEXT_GRAPH_SOURCE_FAMILIES,
);
const NODE_KIND_SET = new Set<LifeOpsContextGraphNodeKind>(
  LIFEOPS_CONTEXT_GRAPH_NODE_KINDS,
);
const EDGE_KIND_SET = new Set<LifeOpsContextGraphEdgeKind>(
  LIFEOPS_CONTEXT_GRAPH_EDGE_KINDS,
);
const IDENTITY_REF_TYPE_SET = new Set<LifeOpsContextGraphIdentityRefType>(
  LIFEOPS_CONTEXT_GRAPH_IDENTITY_REF_TYPES,
);
const SENSITIVITY_SET = new Set<LifeOpsContextGraphSensitivity>(
  LIFEOPS_CONTEXT_GRAPH_SENSITIVITY_SCOPES,
);
const PERMISSION_SCOPE_SET = new Set<LifeOpsContextGraphPermissionScope>(
  LIFEOPS_CONTEXT_GRAPH_PERMISSION_SCOPES,
);

const SENSITIVITY_RANK: Record<LifeOpsContextGraphSensitivity, number> = {
  public: 0,
  personal: 1,
  private: 2,
  sensitive: 3,
  secret: 4,
};

const DEFAULT_QUERY_LIMIT = 25;
const DEFAULT_MAX_QUERY_LIMIT = 50;
const DEFAULT_STALE_CONFIDENCE_MULTIPLIER = 0.5;
const LOW_CONFIDENCE_THRESHOLD = 0.25;
const IDENTITY_PRIORITY: Record<LifeOpsContextGraphIdentityRefType, number> = {
  email: 0,
  phone: 1,
  contact_id: 2,
  calendar_attendee: 3,
  platform_user: 4,
  memory_entity: 5,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertNonEmptyString(
  value: unknown,
  code: LifeOpsContextGraphErrorCode,
  field: string,
): string {
  if (typeof value !== "string") {
    throw new LifeOpsContextGraphError(code, `${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new LifeOpsContextGraphError(code, `${field} is required.`);
  }
  return trimmed;
}

function normalizeOptionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new LifeOpsContextGraphError(
      "INVALID_OBSERVATION",
      `${field} must be a string when provided.`,
    );
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseIsoDate(
  value: unknown,
  code: LifeOpsContextGraphErrorCode,
  field: string,
): string {
  const raw = assertNonEmptyString(value, code, field);
  const millis = Date.parse(raw);
  if (!Number.isFinite(millis)) {
    throw new LifeOpsContextGraphError(code, `${field} must be an ISO date.`);
  }
  return new Date(millis).toISOString();
}

function normalizeOptionalIsoDate(
  value: string | null | undefined,
  field: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return parseIsoDate(value, "INVALID_OBSERVATION", field);
}

function compareIso(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}

function minIso(a: string, b: string): string {
  return compareIso(a, b) <= 0 ? a : b;
}

function maxIso(a: string, b: string): string {
  return compareIso(a, b) >= 0 ? a : b;
}

function assertSourceFamily(value: unknown): LifeOpsContextGraphSourceFamily {
  if (typeof value !== "string" || !SOURCE_FAMILY_SET.has(value as never)) {
    throw new LifeOpsContextGraphError(
      "INVALID_SOURCE_FAMILY",
      `Unsupported context source family: ${String(value)}.`,
    );
  }
  return value as LifeOpsContextGraphSourceFamily;
}

function assertNodeKind(value: unknown): LifeOpsContextGraphNodeKind {
  if (typeof value !== "string" || !NODE_KIND_SET.has(value as never)) {
    throw new LifeOpsContextGraphError(
      "INVALID_NODE_KIND",
      `Unsupported context node kind: ${String(value)}.`,
    );
  }
  return value as LifeOpsContextGraphNodeKind;
}

function assertEdgeKind(value: unknown): LifeOpsContextGraphEdgeKind {
  if (typeof value !== "string" || !EDGE_KIND_SET.has(value as never)) {
    throw new LifeOpsContextGraphError(
      "INVALID_EDGE_KIND",
      `Unsupported context edge kind: ${String(value)}.`,
    );
  }
  return value as LifeOpsContextGraphEdgeKind;
}

function assertSensitivity(value: unknown): LifeOpsContextGraphSensitivity {
  if (typeof value !== "string" || !SENSITIVITY_SET.has(value as never)) {
    throw new LifeOpsContextGraphError(
      "INVALID_SENSITIVITY",
      `Unsupported context sensitivity: ${String(value)}.`,
    );
  }
  return value as LifeOpsContextGraphSensitivity;
}

function assertConfidence(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new LifeOpsContextGraphError(
      "INVALID_CONFIDENCE",
      "Evidence confidence must be a finite number in [0, 1].",
    );
  }
  return value;
}

function normalizePermissionScopes(
  value: readonly LifeOpsContextGraphPermissionScope[] | undefined,
  code: LifeOpsContextGraphErrorCode,
): readonly LifeOpsContextGraphPermissionScope[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new LifeOpsContextGraphError(
      code,
      "At least one permission scope is required.",
    );
  }
  const scopes: LifeOpsContextGraphPermissionScope[] = [];
  for (const scope of value) {
    if (
      typeof scope !== "string" ||
      !PERMISSION_SCOPE_SET.has(scope as never)
    ) {
      throw new LifeOpsContextGraphError(
        "INVALID_PERMISSION_SCOPE",
        `Unsupported permission scope: ${String(scope)}.`,
      );
    }
    const normalized = scope as LifeOpsContextGraphPermissionScope;
    if (!scopes.includes(normalized)) {
      scopes.push(normalized);
    }
  }
  return scopes.sort();
}

function normalizeSourceFamilies(
  value: readonly LifeOpsContextGraphSourceFamily[] | undefined,
): readonly LifeOpsContextGraphSourceFamily[] {
  if (value === undefined) {
    return LIFEOPS_CONTEXT_GRAPH_SOURCE_FAMILIES;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new LifeOpsContextGraphError(
      "INVALID_QUERY",
      "sourceFamilies must contain at least one source family.",
    );
  }
  const families: LifeOpsContextGraphSourceFamily[] = [];
  for (const sourceFamily of value) {
    const normalized = assertSourceFamily(sourceFamily);
    if (!families.includes(normalized)) {
      families.push(normalized);
    }
  }
  return families;
}

function normalizeIdentityValue(
  type: LifeOpsContextGraphIdentityRefType,
  value: string,
): string {
  const trimmed = value.trim();
  if (type === "email") {
    return trimmed.toLowerCase();
  }
  if (type === "phone") {
    return trimmed.replace(/[\s().-]/g, "");
  }
  return trimmed.toLowerCase();
}

function normalizeIdentityRef(
  ref: LifeOpsContextGraphIdentityRefInput,
): LifeOpsContextGraphIdentityRef {
  if (!isRecord(ref)) {
    throw new LifeOpsContextGraphError(
      "INVALID_IDENTITY_REF",
      "Identity refs must be objects.",
    );
  }
  const type = ref.type;
  if (typeof type !== "string" || !IDENTITY_REF_TYPE_SET.has(type as never)) {
    throw new LifeOpsContextGraphError(
      "INVALID_IDENTITY_REF",
      `Unsupported identity ref type: ${String(type)}.`,
    );
  }
  const value = assertNonEmptyString(
    ref.value,
    "INVALID_IDENTITY_REF",
    "identityRef.value",
  );
  return {
    type: type as LifeOpsContextGraphIdentityRefType,
    value,
    normalizedValue: normalizeIdentityValue(type, value),
    sourceFamily:
      ref.sourceFamily === undefined
        ? undefined
        : assertSourceFamily(ref.sourceFamily),
    verified: ref.verified,
  };
}

function identityKey(ref: LifeOpsContextGraphIdentityRef): string {
  return `${ref.type}:${ref.normalizedValue}`;
}

function sortIdentityRefs(
  refs: readonly LifeOpsContextGraphIdentityRef[],
): LifeOpsContextGraphIdentityRef[] {
  return [...refs].sort((a, b) => {
    const priority = IDENTITY_PRIORITY[a.type] - IDENTITY_PRIORITY[b.type];
    if (priority !== 0) return priority;
    return a.normalizedValue.localeCompare(b.normalizedValue);
  });
}

function mergeIdentityRefs(
  a: readonly LifeOpsContextGraphIdentityRef[],
  b: readonly LifeOpsContextGraphIdentityRef[],
): readonly LifeOpsContextGraphIdentityRef[] {
  const byKey = new Map<string, LifeOpsContextGraphIdentityRef>();
  for (const ref of [...a, ...b]) {
    const key = identityKey(ref);
    const current = byKey.get(key);
    if (!current || ref.verified === true) {
      byKey.set(key, ref);
    }
  }
  return sortIdentityRefs([...byKey.values()]);
}

function normalizeExternalRef(
  ref: LifeOpsContextGraphExternalRef,
): LifeOpsContextGraphExternalRef {
  if (!isRecord(ref)) {
    throw new LifeOpsContextGraphError(
      "INVALID_OBSERVATION",
      "External refs must be objects.",
    );
  }
  return {
    sourceFamily: assertSourceFamily(ref.sourceFamily),
    sourceId: assertNonEmptyString(
      ref.sourceId,
      "INVALID_PROVENANCE",
      "externalRef.sourceId",
    ),
    url: normalizeOptionalString(ref.url, "externalRef.url") ?? undefined,
  };
}

function externalRefKey(ref: LifeOpsContextGraphExternalRef): string {
  return `${ref.sourceFamily}:${ref.sourceId}`;
}

function mergeExternalRefs(
  a: readonly LifeOpsContextGraphExternalRef[],
  b: readonly LifeOpsContextGraphExternalRef[],
): readonly LifeOpsContextGraphExternalRef[] {
  const byKey = new Map<string, LifeOpsContextGraphExternalRef>();
  for (const ref of [...a, ...b]) {
    byKey.set(externalRefKey(ref), ref);
  }
  return [...byKey.values()].sort((left, right) =>
    externalRefKey(left).localeCompare(externalRefKey(right)),
  );
}

function normalizeProvenance(
  input: LifeOpsContextGraphProvenanceInput,
): LifeOpsContextGraphProvenance {
  if (!isRecord(input)) {
    throw new LifeOpsContextGraphError(
      "INVALID_PROVENANCE",
      "Evidence provenance is required.",
    );
  }
  return {
    sourceFamily: assertSourceFamily(input.sourceFamily),
    sourceId: assertNonEmptyString(
      input.sourceId,
      "INVALID_PROVENANCE",
      "provenance.sourceId",
    ),
    connectorId: assertNonEmptyString(
      input.connectorId,
      "INVALID_PROVENANCE",
      "provenance.connectorId",
    ),
    observedAt: parseIsoDate(
      input.observedAt,
      "INVALID_PROVENANCE",
      "provenance.observedAt",
    ),
    accountId:
      normalizeOptionalString(input.accountId, "provenance.accountId") ??
      undefined,
    url: normalizeOptionalString(input.url, "provenance.url") ?? undefined,
    rawContentHash:
      normalizeOptionalString(
        input.rawContentHash,
        "provenance.rawContentHash",
      ) ?? undefined,
    adapterVersion:
      normalizeOptionalString(
        input.adapterVersion,
        "provenance.adapterVersion",
      ) ?? undefined,
  };
}

function provenanceKey(provenance: LifeOpsContextGraphProvenance): string {
  return [
    provenance.sourceFamily,
    provenance.connectorId,
    provenance.accountId ?? "",
    provenance.sourceId,
    provenance.rawContentHash ?? "",
  ].join("|");
}

function mergeProvenance(
  a: readonly LifeOpsContextGraphProvenance[],
  b: readonly LifeOpsContextGraphProvenance[],
): readonly LifeOpsContextGraphProvenance[] {
  const byKey = new Map<string, LifeOpsContextGraphProvenance>();
  for (const provenance of [...a, ...b]) {
    const key = provenanceKey(provenance);
    const current = byKey.get(key);
    if (!current || compareIso(provenance.observedAt, current.observedAt) > 0) {
      byKey.set(key, provenance);
    }
  }
  return [...byKey.values()].sort((left, right) =>
    provenanceKey(left).localeCompare(provenanceKey(right)),
  );
}

function contentHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableId(prefix: string, key: string): string {
  return `${prefix}_${contentHash(key)}`;
}

function evidenceFingerprint(evidence: LifeOpsContextGraphEvidence): string {
  const firstProvenance = evidence.provenance[0];
  const content = `${evidence.summary}\n${evidence.quote ?? ""}`;
  if (firstProvenance.rawContentHash) {
    return `raw:${firstProvenance.rawContentHash}:${contentHash(content)}`;
  }
  return [
    "source",
    firstProvenance.sourceFamily,
    firstProvenance.sourceId,
    contentHash(content),
  ].join(":");
}

function normalizeEvidence(
  input: LifeOpsContextGraphEvidenceInput,
): LifeOpsContextGraphEvidence {
  if (!isRecord(input)) {
    throw new LifeOpsContextGraphError(
      "INVALID_OBSERVATION",
      "Evidence entries must be objects.",
    );
  }
  const summary = assertNonEmptyString(
    input.summary,
    "INVALID_OBSERVATION",
    "evidence.summary",
  );
  const quote = normalizeOptionalString(input.quote, "evidence.quote");
  const provenance = normalizeProvenance(input.provenance);
  const staleAfter = normalizeOptionalIsoDate(
    input.staleAfter,
    "evidence.staleAfter",
  );
  const expiresAt = normalizeOptionalIsoDate(
    input.expiresAt,
    "evidence.expiresAt",
  );
  const evidenceWithoutId: Omit<LifeOpsContextGraphEvidence, "id"> = {
    summary,
    confidence: assertConfidence(input.confidence),
    sensitivity: assertSensitivity(input.sensitivity),
    permissionScopes: normalizePermissionScopes(
      input.permissionScopes,
      "INVALID_PERMISSION_SCOPE",
    ),
    provenance: [provenance],
    quote: quote ?? undefined,
    staleAfter,
    expiresAt,
    metadata: input.metadata ?? {},
    firstObservedAt: provenance.observedAt,
    lastObservedAt: provenance.observedAt,
  };
  const fingerprint = evidenceFingerprint({
    ...evidenceWithoutId,
    id: "",
  });
  return {
    ...evidenceWithoutId,
    id: stableId("cg_ev", fingerprint),
  };
}

function maxSensitivity(
  values: readonly LifeOpsContextGraphSensitivity[],
): LifeOpsContextGraphSensitivity {
  let selected: LifeOpsContextGraphSensitivity = "public";
  for (const value of values) {
    if (SENSITIVITY_RANK[value] > SENSITIVITY_RANK[selected]) {
      selected = value;
    }
  }
  return selected;
}

function mergePermissionScopeIntersection(
  a: readonly LifeOpsContextGraphPermissionScope[],
  b: readonly LifeOpsContextGraphPermissionScope[],
): readonly LifeOpsContextGraphPermissionScope[] {
  const right = new Set(b);
  return a.filter((scope) => right.has(scope)).sort();
}

function mergeEvidence(
  existing: LifeOpsContextGraphEvidence,
  incoming: LifeOpsContextGraphEvidence,
): LifeOpsContextGraphEvidence {
  return {
    ...existing,
    confidence: Math.max(existing.confidence, incoming.confidence),
    sensitivity: maxSensitivity([existing.sensitivity, incoming.sensitivity]),
    permissionScopes: mergePermissionScopeIntersection(
      existing.permissionScopes,
      incoming.permissionScopes,
    ),
    provenance: mergeProvenance(existing.provenance, incoming.provenance),
    staleAfter:
      existing.staleAfter && incoming.staleAfter
        ? minIso(existing.staleAfter, incoming.staleAfter)
        : (existing.staleAfter ?? incoming.staleAfter),
    expiresAt:
      existing.expiresAt && incoming.expiresAt
        ? minIso(existing.expiresAt, incoming.expiresAt)
        : (existing.expiresAt ?? incoming.expiresAt),
    metadata: { ...existing.metadata, ...incoming.metadata },
    firstObservedAt: minIso(existing.firstObservedAt, incoming.firstObservedAt),
    lastObservedAt: maxIso(existing.lastObservedAt, incoming.lastObservedAt),
  };
}

function mergeEvidenceLists(
  existing: readonly LifeOpsContextGraphEvidence[],
  incoming: readonly LifeOpsContextGraphEvidence[],
): NormalizedEvidenceList {
  const byFingerprint = new Map<string, LifeOpsContextGraphEvidence>();
  let created = 0;
  let merged = 0;
  for (const evidence of existing) {
    byFingerprint.set(evidenceFingerprint(evidence), evidence);
  }
  for (const evidence of incoming) {
    const key = evidenceFingerprint(evidence);
    const current = byFingerprint.get(key);
    if (!current) {
      byFingerprint.set(key, evidence);
      created += 1;
      continue;
    }
    byFingerprint.set(key, mergeEvidence(current, evidence));
    merged += 1;
  }
  const evidence = [...byFingerprint.values()].sort((left, right) => {
    const confidence = right.confidence - left.confidence;
    if (confidence !== 0) return confidence;
    return compareIso(right.lastObservedAt, left.lastObservedAt);
  });
  return { evidence, created, merged };
}

export function mergeLifeOpsContextConfidenceScores(
  scores: readonly number[],
): number {
  if (scores.length === 0) {
    return 0;
  }
  let missProbability = 1;
  for (const score of scores) {
    const confidence = assertConfidence(score);
    missProbability *= 1 - confidence;
  }
  return Number((1 - missProbability).toFixed(6));
}

function sensitivityFromEvidence(
  evidence: readonly LifeOpsContextGraphEvidence[],
): LifeOpsContextGraphSensitivity {
  return maxSensitivity(evidence.map((entry) => entry.sensitivity));
}

function confidenceFromEvidence(
  evidence: readonly LifeOpsContextGraphEvidence[],
): number {
  return mergeLifeOpsContextConfidenceScores(
    evidence.map((entry) => entry.confidence),
  );
}

function nodeKey(kind: LifeOpsContextGraphNodeKind, stableKey: string): string {
  return `${kind}:${stableKey.trim().toLowerCase()}`;
}

function edgeKey(
  sourceNodeId: string,
  kind: LifeOpsContextGraphEdgeKind,
  targetNodeId: string,
  stableKeyValue: string | null,
): string {
  if (stableKeyValue) {
    return `stable:${stableKeyValue.trim().toLowerCase()}`;
  }
  return `${sourceNodeId}:${kind}:${targetNodeId}`;
}

function validateMetadata(
  value: LifeOpsContextGraphMetadata | undefined,
): LifeOpsContextGraphMetadata {
  return value ?? {};
}

function containsAllScopes(
  available: readonly LifeOpsContextGraphPermissionScope[],
  required: readonly LifeOpsContextGraphPermissionScope[],
): boolean {
  const availableSet = new Set(available);
  return required.every((scope) => availableSet.has(scope));
}

function normalizeQueryLimit(
  limit: number | undefined,
  maxQueryLimit: number,
): { requested: number; applied: number } {
  if (limit === undefined) {
    return { requested: DEFAULT_QUERY_LIMIT, applied: DEFAULT_QUERY_LIMIT };
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new LifeOpsContextGraphError(
      "INVALID_QUERY",
      "Query limit must be a positive integer.",
    );
  }
  return { requested: limit, applied: Math.min(limit, maxQueryLimit) };
}

function normalizeDepth(depth: number | undefined): number {
  if (depth === undefined) {
    return 1;
  }
  if (!Number.isInteger(depth) || depth < 0 || depth > 8) {
    throw new LifeOpsContextGraphError(
      "INVALID_QUERY",
      "Query depth must be an integer in [0, 8].",
    );
  }
  return depth;
}

function normalizeQueryNow(now: string | Date | undefined): Date {
  if (now === undefined) {
    return new Date();
  }
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) {
    throw new LifeOpsContextGraphError(
      "INVALID_QUERY",
      "Query now must be a valid date.",
    );
  }
  return date;
}

function normalizeActor(
  actor: LifeOpsContextGraphActor | undefined,
): LifeOpsContextGraphActor {
  if (!actor) {
    return { kind: "planner", permissionScopes: ["planner"] };
  }
  if (
    actor.kind !== "planner" &&
    actor.kind !== "user" &&
    actor.kind !== "system"
  ) {
    throw new LifeOpsContextGraphError(
      "INVALID_QUERY",
      "Query actor kind is invalid.",
    );
  }
  return {
    ...actor,
    permissionScopes:
      actor.permissionScopes === undefined
        ? undefined
        : normalizePermissionScopes(actor.permissionScopes, "INVALID_QUERY"),
  };
}

function hasExpired(evidence: LifeOpsContextGraphEvidence, now: Date): boolean {
  return (
    evidence.expiresAt !== null &&
    Date.parse(evidence.expiresAt) <= now.getTime()
  );
}

function isStale(evidence: LifeOpsContextGraphEvidence, now: Date): boolean {
  return (
    evidence.staleAfter !== null &&
    Date.parse(evidence.staleAfter) <= now.getTime()
  );
}

function effectiveConfidence(
  evidence: LifeOpsContextGraphEvidence,
  degradedReasons: readonly LifeOpsContextGraphDegradedReason[],
  staleConfidenceMultiplier: number,
): number {
  const staleMultiplier = degradedReasons.includes("stale_evidence")
    ? staleConfidenceMultiplier
    : 1;
  return Number((evidence.confidence * staleMultiplier).toFixed(6));
}

function sourceFamiliesForEvidence(
  evidence: LifeOpsContextGraphEvidence,
): readonly LifeOpsContextGraphSourceFamily[] {
  return [...new Set(evidence.provenance.map((entry) => entry.sourceFamily))];
}

function toPlannerProvenance(
  provenance: readonly LifeOpsContextGraphProvenance[],
): readonly LifeOpsPlannerSliceProvenance[] {
  return provenance.map((entry) => ({
    sourceFamily: entry.sourceFamily,
    sourceId: entry.sourceId,
    connectorId: entry.connectorId,
    observedAt: entry.observedAt,
  }));
}

function defaultPolicyDecision(): LifeOpsContextGraphPolicyDecision {
  return { allow: true, redaction: "summary_only" };
}

export class LifeOpsContextGraph {
  private readonly nodes = new Map<string, LifeOpsContextGraphNode>();
  private readonly nodeKeyIndex = new Map<string, string>();
  private readonly identityIndex = new Map<string, string>();
  private readonly edges = new Map<string, LifeOpsContextGraphEdge>();
  private readonly edgeKeyIndex = new Map<string, string>();
  private readonly outgoingEdges = new Map<string, Set<string>>();
  private readonly incomingEdges = new Map<string, Set<string>>();
  private readonly policyGate: LifeOpsContextGraphPolicyGate | undefined;
  private readonly maxQueryLimit: number;
  private readonly staleConfidenceMultiplier: number;

  constructor(options: LifeOpsContextGraphOptions = {}) {
    if (
      options.maxQueryLimit !== undefined &&
      (!Number.isInteger(options.maxQueryLimit) || options.maxQueryLimit <= 0)
    ) {
      throw new LifeOpsContextGraphError(
        "INVALID_QUERY",
        "maxQueryLimit must be a positive integer.",
      );
    }
    if (
      options.staleConfidenceMultiplier !== undefined &&
      (typeof options.staleConfidenceMultiplier !== "number" ||
        !Number.isFinite(options.staleConfidenceMultiplier) ||
        options.staleConfidenceMultiplier < 0 ||
        options.staleConfidenceMultiplier > 1)
    ) {
      throw new LifeOpsContextGraphError(
        "INVALID_CONFIDENCE",
        "staleConfidenceMultiplier must be in [0, 1].",
      );
    }
    this.policyGate = options.policyGate;
    this.maxQueryLimit = options.maxQueryLimit ?? DEFAULT_MAX_QUERY_LIMIT;
    this.staleConfidenceMultiplier =
      options.staleConfidenceMultiplier ?? DEFAULT_STALE_CONFIDENCE_MULTIPLIER;
  }

  ingestObservation(
    observation: LifeOpsContextGraphObservation,
  ): LifeOpsContextGraphIngestResult {
    const observationId = assertNonEmptyString(
      observation.id,
      "INVALID_OBSERVATION",
      "observation.id",
    );
    parseIsoDate(
      observation.capturedAt,
      "INVALID_OBSERVATION",
      "observation.capturedAt",
    );
    if (!Array.isArray(observation.nodes) || observation.nodes.length === 0) {
      throw new LifeOpsContextGraphError(
        "INVALID_OBSERVATION",
        "At least one node observation is required.",
      );
    }

    const result = {
      observationId,
      nodesCreated: 0,
      nodesUpdated: 0,
      edgesCreated: 0,
      edgesUpdated: 0,
      evidenceCreated: 0,
      evidenceMerged: 0,
    };

    for (const node of observation.nodes) {
      const upsert = this.upsertNode(node);
      result.nodesCreated += upsert.created ? 1 : 0;
      result.nodesUpdated += upsert.created ? 0 : 1;
      result.evidenceCreated += upsert.evidenceCreated;
      result.evidenceMerged += upsert.evidenceMerged;
    }

    for (const edge of observation.edges ?? []) {
      const upsert = this.upsertEdge(edge);
      result.edgesCreated += upsert.created ? 1 : 0;
      result.edgesUpdated += upsert.created ? 0 : 1;
      result.evidenceCreated += upsert.evidenceCreated;
      result.evidenceMerged += upsert.evidenceMerged;
    }

    return result;
  }

  getNode(id: string): LifeOpsContextGraphNode | null {
    const node = this.nodes.get(id);
    return node ? this.cloneNode(node) : null;
  }

  getEdge(id: string): LifeOpsContextGraphEdge | null {
    const edge = this.edges.get(id);
    return edge ? this.cloneEdge(edge) : null;
  }

  getNodeByIdentity(
    ref: LifeOpsContextGraphIdentityRefInput,
  ): LifeOpsContextGraphNode | null {
    const normalized = normalizeIdentityRef(ref);
    const nodeId = this.identityIndex.get(identityKey(normalized));
    return nodeId ? this.getNode(nodeId) : null;
  }

  listNodes(): readonly LifeOpsContextGraphNode[] {
    return [...this.nodes.values()].map((node) => this.cloneNode(node));
  }

  listEdges(): readonly LifeOpsContextGraphEdge[] {
    return [...this.edges.values()].map((edge) => this.cloneEdge(edge));
  }

  async queryPlannerSlice(
    query: LifeOpsContextGraphQuery = {},
  ): Promise<LifeOpsPlannerSlice> {
    const limit = normalizeQueryLimit(query.limit, this.maxQueryLimit);
    const depth = normalizeDepth(query.depth);
    const now = normalizeQueryNow(query.now);
    const queryContext: QueryContext = {
      actor: normalizeActor(query.actor),
      requiredPermissionScopes: normalizePermissionScopes(
        query.requiredPermissionScopes ?? ["planner"],
        "INVALID_QUERY",
      ),
      maxSensitivity: assertSensitivity(query.maxSensitivity ?? "personal"),
      allowedSourceFamilies: new Set(
        normalizeSourceFamilies(query.sourceFamilies),
      ),
      includeEvidenceQuotes: query.includeEvidenceQuotes === true,
      now,
      nowIso: now.toISOString(),
    };

    const candidateNodeIds = this.resolveCandidateNodeIds(query, depth).slice(
      0,
      limit.applied,
    );
    const allowedNodeKinds = query.nodeKinds
      ? new Set(query.nodeKinds.map(assertNodeKind))
      : null;
    const visibleNodeIds = new Set<string>();
    const nodes: LifeOpsPlannerSliceNode[] = [];
    const withheld: LifeOpsContextGraphWithheldItem[] = [];
    const degraded: LifeOpsContextGraphDegradedItem[] = [];

    for (const nodeId of candidateNodeIds) {
      const node = this.nodes.get(nodeId);
      if (!node || (allowedNodeKinds && !allowedNodeKinds.has(node.kind))) {
        continue;
      }
      const projection = await this.projectEvidence(
        "node",
        node.id,
        node.evidence,
        queryContext,
      );
      withheld.push(...projection.withheld);
      degraded.push(...projection.degraded);
      if (projection.evidence.length === 0) {
        continue;
      }
      visibleNodeIds.add(node.id);
      const nodeDegraded = this.collectDegradedReasons(
        projection.degraded,
        projection.withheld,
      );
      nodes.push({
        id: node.id,
        kind: node.kind,
        label: node.label,
        summary: node.summary,
        confidence: mergeLifeOpsContextConfidenceScores(
          projection.evidence.map((entry) => entry.confidence),
        ),
        sensitivity: maxSensitivity(
          projection.evidence.map((entry) => entry.sensitivity),
        ),
        evidence: query.includeEvidence === false ? [] : projection.evidence,
        evidenceCount: node.evidence.length,
        withheldEvidenceCount: projection.withheld.length,
        degradedReasons: nodeDegraded,
      });
    }

    const edges: LifeOpsPlannerSliceEdge[] = [];
    if (query.includeEdges !== false) {
      const allowedEdgeKinds = query.edgeKinds
        ? new Set(query.edgeKinds.map(assertEdgeKind))
        : null;
      const edgeIds = this.resolveCandidateEdgeIds([...visibleNodeIds]);
      for (const edgeId of edgeIds) {
        const edge = this.edges.get(edgeId);
        if (!edge) {
          continue;
        }
        if (
          !visibleNodeIds.has(edge.sourceNodeId) ||
          !visibleNodeIds.has(edge.targetNodeId) ||
          (allowedEdgeKinds && !allowedEdgeKinds.has(edge.kind))
        ) {
          continue;
        }
        const projection = await this.projectEvidence(
          "edge",
          edge.id,
          edge.evidence,
          queryContext,
        );
        withheld.push(...projection.withheld);
        degraded.push(...projection.degraded);
        if (projection.evidence.length === 0) {
          continue;
        }
        const edgeDegraded = this.collectDegradedReasons(
          projection.degraded,
          projection.withheld,
        );
        edges.push({
          id: edge.id,
          kind: edge.kind,
          sourceNodeId: edge.sourceNodeId,
          targetNodeId: edge.targetNodeId,
          confidence: mergeLifeOpsContextConfidenceScores(
            projection.evidence.map((entry) => entry.confidence),
          ),
          sensitivity: maxSensitivity(
            projection.evidence.map((entry) => entry.sensitivity),
          ),
          evidence: query.includeEvidence === false ? [] : projection.evidence,
          evidenceCount: edge.evidence.length,
          withheldEvidenceCount: projection.withheld.length,
          degradedReasons: edgeDegraded,
        });
      }
    }

    return {
      nodes,
      edges,
      withheld,
      degraded,
      requestedLimit: limit.requested,
      appliedLimit: limit.applied,
      generatedAt: queryContext.nowIso,
    };
  }

  private upsertNode(input: LifeOpsContextGraphNodeInput): {
    readonly id: string;
    readonly created: boolean;
    readonly evidenceCreated: number;
    readonly evidenceMerged: number;
  } {
    const kind = assertNodeKind(input.kind);
    const label = assertNonEmptyString(
      input.label,
      "INVALID_OBSERVATION",
      "node.label",
    );
    if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
      throw new LifeOpsContextGraphError(
        "INVALID_PROVENANCE",
        "Node evidence is required.",
      );
    }
    const stableKey = normalizeOptionalString(
      input.stableKey,
      "node.stableKey",
    );
    const identityRefs = sortIdentityRefs(
      (input.identityRefs ?? []).map(normalizeIdentityRef),
    );
    if (identityRefs.length > 0 && kind !== "person") {
      throw new LifeOpsContextGraphError(
        "INVALID_IDENTITY_REF",
        "Only person nodes may carry identity refs.",
      );
    }
    const externalRefs = (input.externalRefs ?? []).map(normalizeExternalRef);
    const evidence = input.evidence.map(normalizeEvidence);
    const existingId = this.findExistingNodeId(kind, stableKey, identityRefs);
    const canonicalKey =
      stableKey !== null
        ? nodeKey(kind, stableKey)
        : identityRefs[0]
          ? `person:${identityKey(identityRefs[0])}`
          : null;
    if (!existingId && !canonicalKey) {
      throw new LifeOpsContextGraphError(
        "INVALID_OBSERVATION",
        "Node observations require a stableKey or person identity ref.",
      );
    }

    const existing = existingId ? this.nodes.get(existingId) : null;
    if (!existing) {
      const mergedEvidence = mergeEvidenceLists([], evidence);
      const id = stableId("cg_node", canonicalKey ?? label);
      const createdAt = mergedEvidence.evidence[0]?.firstObservedAt;
      if (!createdAt) {
        throw new LifeOpsContextGraphError(
          "INVALID_PROVENANCE",
          "Node evidence provenance is required.",
        );
      }
      const node: LifeOpsContextGraphNode = {
        id,
        kind,
        label,
        confidence: confidenceFromEvidence(mergedEvidence.evidence),
        sensitivity: sensitivityFromEvidence(mergedEvidence.evidence),
        evidence: mergedEvidence.evidence,
        stableKey,
        summary: normalizeOptionalString(input.summary, "node.summary"),
        identityRefs,
        externalRefs,
        properties: validateMetadata(input.properties),
        createdAt,
        updatedAt: mergedEvidence.evidence.reduce(
          (current, entry) => maxIso(current, entry.lastObservedAt),
          createdAt,
        ),
      };
      this.nodes.set(id, node);
      this.indexNode(node);
      return {
        id,
        created: true,
        evidenceCreated: mergedEvidence.created,
        evidenceMerged: mergedEvidence.merged,
      };
    }

    const mergedEvidence = mergeEvidenceLists(existing.evidence, evidence);
    const next: LifeOpsContextGraphNode = {
      ...existing,
      label: existing.label === "Unknown" ? label : existing.label,
      confidence: confidenceFromEvidence(mergedEvidence.evidence),
      sensitivity: sensitivityFromEvidence(mergedEvidence.evidence),
      evidence: mergedEvidence.evidence,
      stableKey: existing.stableKey ?? stableKey,
      summary:
        existing.summary ??
        normalizeOptionalString(input.summary, "node.summary"),
      identityRefs: mergeIdentityRefs(existing.identityRefs, identityRefs),
      externalRefs: mergeExternalRefs(existing.externalRefs, externalRefs),
      properties: {
        ...existing.properties,
        ...validateMetadata(input.properties),
      },
      updatedAt: mergedEvidence.evidence.reduce(
        (current, entry) => maxIso(current, entry.lastObservedAt),
        existing.updatedAt,
      ),
    };
    this.nodes.set(next.id, next);
    this.indexNode(next);
    return {
      id: next.id,
      created: false,
      evidenceCreated: mergedEvidence.created,
      evidenceMerged: mergedEvidence.merged,
    };
  }

  private upsertEdge(input: LifeOpsContextGraphEdgeInput): {
    readonly id: string;
    readonly created: boolean;
    readonly evidenceCreated: number;
    readonly evidenceMerged: number;
  } {
    const kind = assertEdgeKind(input.kind);
    if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
      throw new LifeOpsContextGraphError(
        "INVALID_PROVENANCE",
        "Edge evidence is required.",
      );
    }
    const sourceNodeId = this.resolveNodeReference(input.source);
    const targetNodeId = this.resolveNodeReference(input.target);
    const stableKey = normalizeOptionalString(
      input.stableKey,
      "edge.stableKey",
    );
    const key = edgeKey(sourceNodeId, kind, targetNodeId, stableKey);
    const evidence = input.evidence.map(normalizeEvidence);
    const existingId = this.edgeKeyIndex.get(key);
    const existing = existingId ? this.edges.get(existingId) : null;

    if (!existing) {
      const mergedEvidence = mergeEvidenceLists([], evidence);
      const id = stableId("cg_edge", key);
      const createdAt = mergedEvidence.evidence[0]?.firstObservedAt;
      if (!createdAt) {
        throw new LifeOpsContextGraphError(
          "INVALID_PROVENANCE",
          "Edge evidence provenance is required.",
        );
      }
      const edge: LifeOpsContextGraphEdge = {
        id,
        kind,
        sourceNodeId,
        targetNodeId,
        confidence: confidenceFromEvidence(mergedEvidence.evidence),
        sensitivity: sensitivityFromEvidence(mergedEvidence.evidence),
        evidence: mergedEvidence.evidence,
        stableKey,
        properties: validateMetadata(input.properties),
        createdAt,
        updatedAt: mergedEvidence.evidence.reduce(
          (current, entry) => maxIso(current, entry.lastObservedAt),
          createdAt,
        ),
      };
      this.edges.set(edge.id, edge);
      this.edgeKeyIndex.set(key, edge.id);
      this.indexEdge(edge);
      return {
        id,
        created: true,
        evidenceCreated: mergedEvidence.created,
        evidenceMerged: mergedEvidence.merged,
      };
    }

    const mergedEvidence = mergeEvidenceLists(existing.evidence, evidence);
    const next: LifeOpsContextGraphEdge = {
      ...existing,
      confidence: confidenceFromEvidence(mergedEvidence.evidence),
      sensitivity: sensitivityFromEvidence(mergedEvidence.evidence),
      evidence: mergedEvidence.evidence,
      properties: {
        ...existing.properties,
        ...validateMetadata(input.properties),
      },
      updatedAt: mergedEvidence.evidence.reduce(
        (current, entry) => maxIso(current, entry.lastObservedAt),
        existing.updatedAt,
      ),
    };
    this.edges.set(next.id, next);
    this.indexEdge(next);
    return {
      id: next.id,
      created: false,
      evidenceCreated: mergedEvidence.created,
      evidenceMerged: mergedEvidence.merged,
    };
  }

  private findExistingNodeId(
    kind: LifeOpsContextGraphNodeKind,
    stableKey: string | null,
    identityRefs: readonly LifeOpsContextGraphIdentityRef[],
  ): string | null {
    if (stableKey) {
      const existing = this.nodeKeyIndex.get(nodeKey(kind, stableKey));
      if (existing) return existing;
    }
    for (const ref of identityRefs) {
      const existing = this.identityIndex.get(identityKey(ref));
      if (existing) return existing;
    }
    return null;
  }

  private indexNode(node: LifeOpsContextGraphNode): void {
    if (node.stableKey) {
      this.nodeKeyIndex.set(nodeKey(node.kind, node.stableKey), node.id);
    }
    for (const ref of node.identityRefs) {
      this.identityIndex.set(identityKey(ref), node.id);
    }
  }

  private indexEdge(edge: LifeOpsContextGraphEdge): void {
    const key = edgeKey(
      edge.sourceNodeId,
      edge.kind,
      edge.targetNodeId,
      edge.stableKey,
    );
    this.edgeKeyIndex.set(key, edge.id);
    if (!this.outgoingEdges.has(edge.sourceNodeId)) {
      this.outgoingEdges.set(edge.sourceNodeId, new Set());
    }
    this.outgoingEdges.get(edge.sourceNodeId)?.add(edge.id);
    if (!this.incomingEdges.has(edge.targetNodeId)) {
      this.incomingEdges.set(edge.targetNodeId, new Set());
    }
    this.incomingEdges.get(edge.targetNodeId)?.add(edge.id);
  }

  private resolveNodeReference(
    reference: LifeOpsContextGraphNodeReferenceInput,
  ): string {
    if (!isRecord(reference)) {
      throw new LifeOpsContextGraphError(
        "NODE_NOT_FOUND",
        "Node reference must be an object.",
      );
    }
    if ("nodeId" in reference) {
      const nodeId = assertNonEmptyString(
        reference.nodeId,
        "NODE_NOT_FOUND",
        "nodeRef.nodeId",
      );
      if (!this.nodes.has(nodeId)) {
        throw new LifeOpsContextGraphError(
          "NODE_NOT_FOUND",
          `Context graph node not found: ${nodeId}.`,
        );
      }
      return nodeId;
    }
    const kind = assertNodeKind(reference.kind);
    if ("stableKey" in reference) {
      const stableKey = assertNonEmptyString(
        reference.stableKey,
        "NODE_NOT_FOUND",
        "nodeRef.stableKey",
      );
      const nodeId = this.nodeKeyIndex.get(nodeKey(kind, stableKey));
      if (nodeId) return nodeId;
    }
    if (kind === "person" && "identityRefs" in reference) {
      const refs = reference.identityRefs.map(normalizeIdentityRef);
      for (const ref of refs) {
        const nodeId = this.identityIndex.get(identityKey(ref));
        if (nodeId) return nodeId;
      }
    }
    throw new LifeOpsContextGraphError(
      "NODE_NOT_FOUND",
      "Context graph node reference could not be resolved.",
    );
  }

  private resolveCandidateNodeIds(
    query: LifeOpsContextGraphQuery,
    depth: number,
  ): string[] {
    if (!query.focus) {
      return [...this.nodes.values()]
        .sort((left, right) => {
          const confidence = right.confidence - left.confidence;
          if (confidence !== 0) return confidence;
          return compareIso(right.updatedAt, left.updatedAt);
        })
        .map((node) => node.id);
    }

    const focusNodeId = this.resolveNodeReference(query.focus);
    const visitedNodes = new Set<string>([focusNodeId]);
    const visitedEdges = new Set<string>();
    let frontier = [focusNodeId];
    for (let level = 0; level < depth; level += 1) {
      const nextFrontier: string[] = [];
      for (const nodeId of frontier) {
        const edgeIds = [
          ...(this.outgoingEdges.get(nodeId) ?? []),
          ...(this.incomingEdges.get(nodeId) ?? []),
        ];
        for (const edgeId of edgeIds) {
          if (visitedEdges.has(edgeId)) {
            continue;
          }
          visitedEdges.add(edgeId);
          const edge = this.edges.get(edgeId);
          if (!edge) {
            continue;
          }
          const otherNodeId =
            edge.sourceNodeId === nodeId
              ? edge.targetNodeId
              : edge.sourceNodeId;
          if (!visitedNodes.has(otherNodeId)) {
            visitedNodes.add(otherNodeId);
            nextFrontier.push(otherNodeId);
          }
        }
      }
      frontier = nextFrontier;
      if (frontier.length === 0) {
        break;
      }
    }
    return [...visitedNodes];
  }

  private resolveCandidateEdgeIds(nodeIds: readonly string[]): string[] {
    const nodeSet = new Set(nodeIds);
    const edgeIds = new Set<string>();
    for (const nodeId of nodeIds) {
      for (const edgeId of this.outgoingEdges.get(nodeId) ?? []) {
        const edge = this.edges.get(edgeId);
        if (edge && nodeSet.has(edge.targetNodeId)) {
          edgeIds.add(edgeId);
        }
      }
      for (const edgeId of this.incomingEdges.get(nodeId) ?? []) {
        const edge = this.edges.get(edgeId);
        if (edge && nodeSet.has(edge.sourceNodeId)) {
          edgeIds.add(edgeId);
        }
      }
    }
    return [...edgeIds].sort();
  }

  private async projectEvidence(
    targetType: "node" | "edge",
    targetId: string,
    evidence: readonly LifeOpsContextGraphEvidence[],
    context: QueryContext,
  ): Promise<EvidenceProjection> {
    const projected: LifeOpsPlannerSliceEvidence[] = [];
    const withheld: LifeOpsContextGraphWithheldItem[] = [];
    const degraded: LifeOpsContextGraphDegradedItem[] = [];

    for (const entry of evidence) {
      const sourceFamilies = sourceFamiliesForEvidence(entry);
      const withheldReason = this.resolveStaticWithheldReason(entry, context);
      if (withheldReason) {
        withheld.push({
          targetType,
          targetId,
          evidenceId: entry.id,
          reason: withheldReason,
          sourceFamilies,
        });
        continue;
      }

      const policyDecision = await this.evaluatePolicy({
        operation: "planner_slice",
        actor: context.actor,
        targetType,
        targetId,
        evidence: entry,
        requiredPermissionScopes: context.requiredPermissionScopes,
        maxSensitivity: context.maxSensitivity,
        now: context.nowIso,
      });
      if (!policyDecision.allow) {
        withheld.push({
          targetType,
          targetId,
          evidenceId: entry.id,
          reason:
            "reason" in policyDecision
              ? (policyDecision.reason ?? "policy_denied")
              : "policy_denied",
          sourceFamilies,
        });
        continue;
      }

      const reasons: LifeOpsContextGraphDegradedReason[] = [
        ...(policyDecision.degradedReasons ?? []),
      ];
      if (isStale(entry, context.now)) {
        reasons.push("stale_evidence");
      }
      const confidence = effectiveConfidence(
        entry,
        reasons,
        this.staleConfidenceMultiplier,
      );
      if (confidence < LOW_CONFIDENCE_THRESHOLD) {
        reasons.push("low_confidence");
      }
      if (reasons.length > 0) {
        degraded.push({
          targetType,
          targetId,
          evidenceId: entry.id,
          reasons: [...new Set(reasons)],
        });
      }
      const redaction = policyDecision.redaction ?? "summary_only";
      const canShowQuote =
        context.includeEvidenceQuotes &&
        redaction === "none" &&
        entry.sensitivity === "public" &&
        entry.quote !== undefined;
      projected.push({
        evidenceId: entry.id,
        summary: entry.summary,
        confidence,
        sensitivity: entry.sensitivity,
        provenance: toPlannerProvenance(entry.provenance),
        degradedReasons: [...new Set(reasons)],
        redacted: !canShowQuote,
        quote: canShowQuote ? entry.quote : undefined,
      });
    }

    return { evidence: projected, withheld, degraded };
  }

  private resolveStaticWithheldReason(
    evidence: LifeOpsContextGraphEvidence,
    context: QueryContext,
  ): LifeOpsContextGraphWithheldReason | null {
    if (
      evidence.provenance.some(
        (entry) => !context.allowedSourceFamilies.has(entry.sourceFamily),
      )
    ) {
      return "source_family_not_allowed";
    }
    if (hasExpired(evidence, context.now)) {
      return "expired_evidence";
    }
    if (
      !containsAllScopes(
        evidence.permissionScopes,
        context.requiredPermissionScopes,
      )
    ) {
      return "missing_permission_scope";
    }
    if (
      SENSITIVITY_RANK[evidence.sensitivity] >
      SENSITIVITY_RANK[context.maxSensitivity]
    ) {
      return "sensitivity_scope_restricted";
    }
    return null;
  }

  private async evaluatePolicy(
    request: LifeOpsContextGraphPolicyRequest,
  ): Promise<LifeOpsContextGraphPolicyDecision> {
    if (!this.policyGate) {
      return defaultPolicyDecision();
    }
    try {
      return await this.policyGate(request);
    } catch {
      return { allow: false, reason: "policy_denied" };
    }
  }

  private collectDegradedReasons(
    degraded: readonly LifeOpsContextGraphDegradedItem[],
    withheld: readonly LifeOpsContextGraphWithheldItem[],
  ): readonly LifeOpsContextGraphDegradedReason[] {
    const reasons = new Set<LifeOpsContextGraphDegradedReason>();
    for (const item of degraded) {
      for (const reason of item.reasons) {
        reasons.add(reason);
      }
    }
    if (withheld.length > 0) {
      reasons.add("partial_evidence_withheld");
    }
    return [...reasons].sort();
  }

  private cloneNode(node: LifeOpsContextGraphNode): LifeOpsContextGraphNode {
    return {
      ...node,
      evidence: node.evidence.map((evidence) => ({
        ...evidence,
        provenance: [...evidence.provenance],
        permissionScopes: [...evidence.permissionScopes],
      })),
      identityRefs: [...node.identityRefs],
      externalRefs: [...node.externalRefs],
      properties: { ...node.properties },
    };
  }

  private cloneEdge(edge: LifeOpsContextGraphEdge): LifeOpsContextGraphEdge {
    return {
      ...edge,
      evidence: edge.evidence.map((evidence) => ({
        ...evidence,
        provenance: [...evidence.provenance],
        permissionScopes: [...evidence.permissionScopes],
      })),
      properties: { ...edge.properties },
    };
  }
}

export function createLifeOpsContextGraph(
  options?: LifeOpsContextGraphOptions,
): LifeOpsContextGraph {
  return new LifeOpsContextGraph(options);
}
