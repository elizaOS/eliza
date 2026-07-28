/**
 * Typed contracts for source-grounded school and activity obligations.
 *
 * Source text is always untrusted evidence. These contracts separate immutable
 * observations from action proposals so an extractor can never turn words in
 * an email, document, calendar description, or voice transcript into authority
 * to send, purchase, submit, or mutate a calendar.
 */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { isValidTimeZone } from "@elizaos/shared";

export type SchoolJsonValue =
  | null
  | boolean
  | number
  | string
  | SchoolJsonValue[]
  | { [key: string]: SchoolJsonValue };

export const SOURCE_ARTIFACT_KINDS = [
  "voice",
  "gmail",
  "document",
  "calendar",
  "school_portal",
  "activity_feed",
] as const;
export type SourceArtifactKind = (typeof SOURCE_ARTIFACT_KINDS)[number];

export const SOURCE_AUTHORITY_CLASSES = [
  "informational",
  "owner_statement",
  "school_calendar",
  "school_notice",
  "school_official",
  "signed_school_correction",
] as const;
export type SourceAuthorityClass = (typeof SOURCE_AUTHORITY_CLASSES)[number];

export const SOURCE_VISIBILITY_SCOPES = [
  "owner_private",
  "household",
  "child_scoped",
] as const;
export type SourceVisibilityScope = (typeof SOURCE_VISIBILITY_SCOPES)[number];

export interface SourceActorRef {
  kind: "entity" | "external";
  id: string;
  label: string | null;
}

export interface SourceArtifactInput {
  kind: SourceArtifactKind;
  sourceId: string;
  stableReference: string;
  snapshotReference: string;
  sourceActor: SourceActorRef;
  observedAt: string;
  retrievedAt: string;
  effectiveAt: string | null;
  contentSha256: string;
  untrustedContent: string;
  visibility: SourceVisibilityScope;
}

export interface SourceArtifact extends SourceArtifactInput {
  id: string;
  createdAt: string;
}

export interface SourceVersion {
  sequence: number;
  externalVersion: string;
}

export interface SourceFactCandidate {
  stableFactKey: string;
  domain: string;
  factType: string;
  value: SchoolJsonValue;
  subjectEntityIds: string[];
  confidence: number;
  authority: SourceAuthorityClass;
  version: SourceVersion;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  visibility: SourceVisibilityScope;
  extractorId: string;
  extractorVersion: string;
  supersedesStableFactKeys: string[];
  contradictsStableFactKeys: string[];
}

export interface SourceFact extends SourceFactCandidate {
  id: string;
  artifactId: string;
  revisionSha256: string;
  createdAt: string;
}

export interface ChildReference {
  preferredName: string | null;
  externalChildId: string | null;
  schoolName: string | null;
  grade: string | null;
  teamName: string | null;
}

export interface ChildResolutionCandidate {
  entityId: string;
  preferredName: string;
  matchedHints: string[];
}

export type ChildResolution =
  | {
      status: "resolved";
      entityId: string;
      matchedHints: string[];
    }
  | {
      status: "ambiguous";
      candidates: ChildResolutionCandidate[];
      question: string;
    }
  | {
      status: "unresolved";
      candidates: ChildResolutionCandidate[];
      question: string;
    };

export type SchoolNoticeTiming =
  | {
      kind: "instant";
      startAt: string;
      endAt: string;
      timezone: string;
    }
  | {
      kind: "date";
      startDate: string;
      endDateExclusive: string;
    };

export interface SchoolNoticeDeadline {
  label: string;
  dueAt: string;
}

export interface SchoolNoticeForm {
  label: string;
  stableReference: string;
  required: boolean;
}

export interface SchoolNoticeCost {
  amountMinor: number;
  currency: string;
  refundable: boolean | null;
}

export interface SchoolNoticeLocation {
  label: string;
  address: string | null;
}

export interface SchoolNoticeContact {
  entityId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
}

export const SCHOOL_NOTICE_ACTION_KINDS = [
  "review",
  "prepare",
  "calendar_draft",
  "send_draft",
  "purchase_draft",
  "submit_form_draft",
] as const;
export type SchoolNoticeActionKind =
  (typeof SCHOOL_NOTICE_ACTION_KINDS)[number];

export interface SchoolNoticeNextAction {
  kind: SchoolNoticeActionKind;
  label: string;
  dueAt: string | null;
  targetReference: string | null;
}

export const SCHOOL_NOTICE_KINDS = [
  "announcement",
  "event",
  "deadline",
  "correction",
  "cancellation",
] as const;
export type SchoolNoticeKind = (typeof SCHOOL_NOTICE_KINDS)[number];

export interface SchoolNoticeExtraction {
  noticeKey: string;
  kind: SchoolNoticeKind;
  title: string;
  childReference: ChildReference;
  timing: SchoolNoticeTiming | null;
  deadlines: SchoolNoticeDeadline[];
  forms: SchoolNoticeForm[];
  cost: SchoolNoticeCost | null;
  location: SchoolNoticeLocation | null;
  contact: SchoolNoticeContact | null;
  nextActions: SchoolNoticeNextAction[];
  correctsNoticeKey: string | null;
  cancelsNoticeKey: string | null;
}

export const ACTION_EFFECT_CLASSES = [
  "read_only",
  "internal_reversible",
  "calendar_write",
  "external_send",
  "purchase",
  "document_submission",
] as const;
export type ActionEffectClass = (typeof ACTION_EFFECT_CLASSES)[number];

export type ActionApprovalRequirement =
  | "none"
  | "owner_approval"
  | "multi_party_approval";

export interface ActionBundleItem {
  id: string;
  kind: SchoolNoticeActionKind | "clarify_child" | "resolve_conflict";
  label: string;
  dueAt: string | null;
  targetReference: string | null;
  effectClass: ActionEffectClass;
  approvalRequirement: ActionApprovalRequirement;
  state: "proposed" | "blocked";
}

export interface ActionBundle {
  id: string;
  noticeKey: string;
  sourceFactIds: string[];
  childEntityId: string | null;
  revision: number;
  state: "proposed" | "needs_clarification" | "conflicted" | "cancelled";
  items: ActionBundleItem[];
  responsibilityAssignmentId: string | null;
  createdAt: string;
}

export interface ResponsibilityAssignmentInput {
  subjectKey: string;
  conceptionOwnerId: string;
  planningOwnerId: string;
  executionOwnerId: string;
  monitoringOwnerId: string;
  minimumStandard: string | null;
  acceptedBy: string[];
  startsAt: string;
  endsAt: string | null;
}

export interface ResponsibilityAssignment
  extends ResponsibilityAssignmentInput {
  id: string;
  createdAt: string;
}

export type SchoolNoticeResolution =
  | {
      noticeKey: string;
      state: "active" | "cancelled" | "needs_clarification";
      currentFactIds: string[];
      supersededFactIds: string[];
      contradictionFactIds: [];
      materialSha256: string;
      extraction: SchoolNoticeExtraction;
      childEntityId: string | null;
    }
  | {
      noticeKey: string;
      state: "conflicted";
      currentFactIds: [];
      supersededFactIds: string[];
      contradictionFactIds: string[];
      materialSha256: null;
      extraction: null;
      childEntityId: null;
    };

export interface IngestSchoolNoticeInput {
  artifact: SourceArtifactInput;
  extraction: SchoolNoticeExtraction;
  confidence: number;
  authority: SourceAuthorityClass;
  version: SourceVersion;
  extractorId: string;
  extractorVersion: string;
  responsibility: ResponsibilityAssignmentInput | null;
}

export interface IngestSchoolNoticeResult {
  artifact: SourceArtifact;
  sourceFact: SourceFact;
  childResolution: ChildResolution;
  noticeResolution: SchoolNoticeResolution;
  actionBundle: ActionBundle;
  responsibilityAssignment: ResponsibilityAssignment | null;
  actionBundleReplayed: boolean;
}

export type SchoolSourceFactErrorCode =
  | "SCHOOL_GRAPH_UNAVAILABLE"
  | "SCHOOL_IMMUTABLE_CONFLICT"
  | "SCHOOL_INVALID_CONTRACT"
  | "SCHOOL_SOURCE_NOT_FOUND"
  | "SCHOOL_SUBJECT_NOT_FOUND";

export class SchoolSourceFactError extends ElizaError {
  override readonly name = "SchoolSourceFactError";

  constructor(
    message: string,
    code: SchoolSourceFactErrorCode,
    context?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, {
      code,
      context,
      cause,
      severity: code === "SCHOOL_SOURCE_NOT_FOUND" ? "ephemeral" : "fatal",
    });
  }
}

function invalid(message: string, context?: Record<string, unknown>): never {
  throw new SchoolSourceFactError(message, "SCHOOL_INVALID_CONTRACT", context);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    return invalid(`${field} must be a non-empty string`, { field });
  }
  return value.trim();
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredText(value, field);
}

function canonicalInstant(value: unknown, field: string): string {
  const text = requiredText(value, field);
  const timestamp = Date.parse(text);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== text
  ) {
    return invalid(`${field} must be a canonical UTC ISO-8601 timestamp`, {
      field,
      value: text,
    });
  }
  return text;
}

function nullableInstant(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return canonicalInstant(value, field);
}

function localDate(value: unknown, field: string): string {
  const text = requiredText(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
    return invalid(`${field} must be a YYYY-MM-DD local date`, {
      field,
      value: text,
    });
  }
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== text
  ) {
    return invalid(`${field} must be a real local date`, {
      field,
      value: text,
    });
  }
  return text;
}

function confidenceValue(value: unknown, field = "confidence"): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    return invalid(`${field} must be between 0 and 1`, { field });
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    return invalid(`${field} must be an array of non-empty strings`, {
      field,
    });
  }
  return Array.from(new Set(value.map((entry) => entry.trim()))).sort();
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`${field} must be an object`, { field });
  }
  return value as Record<string, unknown>;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  field: string,
): T[number] {
  const text = requiredText(value, field);
  const matched = values.find((candidate) => candidate === text);
  if (!matched) {
    return invalid(`${field} has an unsupported value`, {
      field,
      value: text,
    });
  }
  return matched;
}

function jsonValue(value: unknown, field: string): SchoolJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return invalid(`${field} contains a non-finite number`, { field });
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => jsonValue(entry, `${field}[${index}]`));
  }
  const record = asRecord(value, field);
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, jsonValue(entry, `${field}.${key}`)]),
  );
}

export function canonicalSchoolJson(value: unknown): string {
  return JSON.stringify(jsonValue(value, "value"));
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableSchoolId(prefix: string, value: unknown): string {
  return `${prefix}_${sha256(canonicalSchoolJson(value)).slice(0, 32)}`;
}

export function normalizeSourceActor(
  value: unknown,
  field = "sourceActor",
): SourceActorRef {
  const record = asRecord(value, field);
  const kind = enumValue(
    record.kind,
    ["entity", "external"] as const,
    `${field}.kind`,
  );
  return {
    kind,
    id: requiredText(record.id, `${field}.id`),
    label: nullableText(record.label, `${field}.label`),
  };
}

export function normalizeSourceArtifactInput(
  value: unknown,
): SourceArtifactInput {
  const record = asRecord(value, "artifact");
  const contentSha256 = requiredText(
    record.contentSha256,
    "artifact.contentSha256",
  ).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(contentSha256)) {
    return invalid("artifact.contentSha256 must be lowercase SHA-256", {
      field: "artifact.contentSha256",
    });
  }
  const untrustedContent =
    typeof record.untrustedContent === "string"
      ? record.untrustedContent
      : invalid("artifact.untrustedContent must be a string");
  if (Buffer.byteLength(untrustedContent, "utf8") > 64 * 1024) {
    return invalid("artifact.untrustedContent exceeds the 64 KiB boundary", {
      field: "artifact.untrustedContent",
    });
  }
  return {
    kind: enumValue(record.kind, SOURCE_ARTIFACT_KINDS, "artifact.kind"),
    sourceId: requiredText(record.sourceId, "artifact.sourceId"),
    stableReference: requiredText(
      record.stableReference,
      "artifact.stableReference",
    ),
    snapshotReference: requiredText(
      record.snapshotReference,
      "artifact.snapshotReference",
    ),
    sourceActor: normalizeSourceActor(record.sourceActor),
    observedAt: canonicalInstant(record.observedAt, "artifact.observedAt"),
    retrievedAt: canonicalInstant(record.retrievedAt, "artifact.retrievedAt"),
    effectiveAt: nullableInstant(record.effectiveAt, "artifact.effectiveAt"),
    contentSha256,
    untrustedContent,
    visibility: enumValue(
      record.visibility,
      SOURCE_VISIBILITY_SCOPES,
      "artifact.visibility",
    ),
  };
}

export function normalizeSourceVersion(
  value: unknown,
  field = "version",
): SourceVersion {
  const record = asRecord(value, field);
  if (
    typeof record.sequence !== "number" ||
    !Number.isInteger(record.sequence) ||
    record.sequence < 1
  ) {
    return invalid(`${field}.sequence must be a positive integer`, { field });
  }
  return {
    sequence: record.sequence,
    externalVersion: requiredText(
      record.externalVersion,
      `${field}.externalVersion`,
    ),
  };
}

export function normalizeSourceFactCandidate(
  value: unknown,
): SourceFactCandidate {
  const record = asRecord(value, "candidate");
  const effectiveFrom = nullableInstant(
    record.effectiveFrom,
    "candidate.effectiveFrom",
  );
  const effectiveUntil = nullableInstant(
    record.effectiveUntil,
    "candidate.effectiveUntil",
  );
  if (
    effectiveFrom &&
    effectiveUntil &&
    Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)
  ) {
    return invalid("candidate.effectiveUntil must follow effectiveFrom");
  }
  return {
    stableFactKey: requiredText(
      record.stableFactKey,
      "candidate.stableFactKey",
    ),
    domain: requiredText(record.domain, "candidate.domain"),
    factType: requiredText(record.factType, "candidate.factType"),
    value: jsonValue(record.value, "candidate.value"),
    subjectEntityIds: stringArray(
      record.subjectEntityIds,
      "candidate.subjectEntityIds",
    ),
    confidence: confidenceValue(record.confidence),
    authority: enumValue(
      record.authority,
      SOURCE_AUTHORITY_CLASSES,
      "candidate.authority",
    ),
    version: normalizeSourceVersion(record.version, "candidate.version"),
    effectiveFrom,
    effectiveUntil,
    visibility: enumValue(
      record.visibility,
      SOURCE_VISIBILITY_SCOPES,
      "candidate.visibility",
    ),
    extractorId: requiredText(record.extractorId, "candidate.extractorId"),
    extractorVersion: requiredText(
      record.extractorVersion,
      "candidate.extractorVersion",
    ),
    supersedesStableFactKeys: stringArray(
      record.supersedesStableFactKeys,
      "candidate.supersedesStableFactKeys",
    ),
    contradictsStableFactKeys: stringArray(
      record.contradictsStableFactKeys,
      "candidate.contradictsStableFactKeys",
    ),
  };
}

function normalizeChildReference(value: unknown): ChildReference {
  const record = asRecord(value, "extraction.childReference");
  return {
    preferredName: nullableText(
      record.preferredName,
      "extraction.childReference.preferredName",
    ),
    externalChildId: nullableText(
      record.externalChildId,
      "extraction.childReference.externalChildId",
    ),
    schoolName: nullableText(
      record.schoolName,
      "extraction.childReference.schoolName",
    ),
    grade: nullableText(record.grade, "extraction.childReference.grade"),
    teamName: nullableText(
      record.teamName,
      "extraction.childReference.teamName",
    ),
  };
}

function normalizeTiming(value: unknown): SchoolNoticeTiming | null {
  if (value === null || value === undefined) return null;
  const record = asRecord(value, "extraction.timing");
  const kind = enumValue(
    record.kind,
    ["instant", "date"] as const,
    "extraction.timing.kind",
  );
  if (kind === "date") {
    const startDate = localDate(
      record.startDate,
      "extraction.timing.startDate",
    );
    const endDateExclusive = localDate(
      record.endDateExclusive,
      "extraction.timing.endDateExclusive",
    );
    if (endDateExclusive <= startDate) {
      return invalid(
        "extraction.timing.endDateExclusive must follow startDate",
      );
    }
    return { kind, startDate, endDateExclusive };
  }
  const startAt = canonicalInstant(record.startAt, "extraction.timing.startAt");
  const endAt = canonicalInstant(record.endAt, "extraction.timing.endAt");
  if (Date.parse(endAt) <= Date.parse(startAt)) {
    return invalid("extraction.timing.endAt must follow startAt");
  }
  const timezone = requiredText(record.timezone, "extraction.timing.timezone");
  if (!isValidTimeZone(timezone)) {
    return invalid("extraction.timing.timezone must be an IANA time zone", {
      timezone,
    });
  }
  return { kind, startAt, endAt, timezone };
}

function normalizeDeadlines(value: unknown): SchoolNoticeDeadline[] {
  if (!Array.isArray(value)) {
    return invalid("extraction.deadlines must be an array");
  }
  return value.map((entry, index) => {
    const record = asRecord(entry, `extraction.deadlines[${index}]`);
    return {
      label: requiredText(record.label, `extraction.deadlines[${index}].label`),
      dueAt: canonicalInstant(
        record.dueAt,
        `extraction.deadlines[${index}].dueAt`,
      ),
    };
  });
}

function normalizeForms(value: unknown): SchoolNoticeForm[] {
  if (!Array.isArray(value)) {
    return invalid("extraction.forms must be an array");
  }
  return value.map((entry, index) => {
    const record = asRecord(entry, `extraction.forms[${index}]`);
    if (typeof record.required !== "boolean") {
      return invalid(`extraction.forms[${index}].required must be a boolean`);
    }
    return {
      label: requiredText(record.label, `extraction.forms[${index}].label`),
      stableReference: requiredText(
        record.stableReference,
        `extraction.forms[${index}].stableReference`,
      ),
      required: record.required,
    };
  });
}

function normalizeCost(value: unknown): SchoolNoticeCost | null {
  if (value === null || value === undefined) return null;
  const record = asRecord(value, "extraction.cost");
  if (
    typeof record.amountMinor !== "number" ||
    !Number.isInteger(record.amountMinor) ||
    record.amountMinor < 0
  ) {
    return invalid(
      "extraction.cost.amountMinor must be a non-negative integer",
    );
  }
  if (record.refundable !== null && typeof record.refundable !== "boolean") {
    return invalid("extraction.cost.refundable must be boolean or null");
  }
  const currency = requiredText(
    record.currency,
    "extraction.cost.currency",
  ).toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency)) {
    return invalid("extraction.cost.currency must be a three-letter code");
  }
  return {
    amountMinor: record.amountMinor,
    currency,
    refundable: record.refundable,
  };
}

function normalizeLocation(value: unknown): SchoolNoticeLocation | null {
  if (value === null || value === undefined) return null;
  const record = asRecord(value, "extraction.location");
  return {
    label: requiredText(record.label, "extraction.location.label"),
    address: nullableText(record.address, "extraction.location.address"),
  };
}

function normalizeContact(value: unknown): SchoolNoticeContact | null {
  if (value === null || value === undefined) return null;
  const record = asRecord(value, "extraction.contact");
  return {
    entityId: nullableText(record.entityId, "extraction.contact.entityId"),
    name: requiredText(record.name, "extraction.contact.name"),
    email: nullableText(record.email, "extraction.contact.email"),
    phone: nullableText(record.phone, "extraction.contact.phone"),
  };
}

function normalizeNextActions(value: unknown): SchoolNoticeNextAction[] {
  if (!Array.isArray(value)) {
    return invalid("extraction.nextActions must be an array");
  }
  return value.map((entry, index) => {
    const record = asRecord(entry, `extraction.nextActions[${index}]`);
    return {
      kind: enumValue(
        record.kind,
        SCHOOL_NOTICE_ACTION_KINDS,
        `extraction.nextActions[${index}].kind`,
      ),
      label: requiredText(
        record.label,
        `extraction.nextActions[${index}].label`,
      ),
      dueAt: nullableInstant(
        record.dueAt,
        `extraction.nextActions[${index}].dueAt`,
      ),
      targetReference: nullableText(
        record.targetReference,
        `extraction.nextActions[${index}].targetReference`,
      ),
    };
  });
}

export function normalizeSchoolNoticeExtraction(
  value: unknown,
): SchoolNoticeExtraction {
  const record = asRecord(value, "extraction");
  const noticeKey = requiredText(record.noticeKey, "extraction.noticeKey");
  const kind = enumValue(record.kind, SCHOOL_NOTICE_KINDS, "extraction.kind");
  const correctsNoticeKey = nullableText(
    record.correctsNoticeKey,
    "extraction.correctsNoticeKey",
  );
  const cancelsNoticeKey = nullableText(
    record.cancelsNoticeKey,
    "extraction.cancelsNoticeKey",
  );
  if (kind === "correction" && !correctsNoticeKey) {
    return invalid("correction notices require correctsNoticeKey");
  }
  if (kind === "cancellation" && !cancelsNoticeKey) {
    return invalid("cancellation notices require cancelsNoticeKey");
  }
  return {
    noticeKey,
    kind,
    title: requiredText(record.title, "extraction.title"),
    childReference: normalizeChildReference(record.childReference),
    timing: normalizeTiming(record.timing),
    deadlines: normalizeDeadlines(record.deadlines),
    forms: normalizeForms(record.forms),
    cost: normalizeCost(record.cost),
    location: normalizeLocation(record.location),
    contact: normalizeContact(record.contact),
    nextActions: normalizeNextActions(record.nextActions),
    correctsNoticeKey,
    cancelsNoticeKey,
  };
}

export function normalizeResponsibilityAssignmentInput(
  value: unknown,
): ResponsibilityAssignmentInput {
  const record = asRecord(value, "responsibility");
  const startsAt = canonicalInstant(record.startsAt, "responsibility.startsAt");
  const endsAt = nullableInstant(record.endsAt, "responsibility.endsAt");
  if (endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
    return invalid("responsibility.endsAt must follow startsAt");
  }
  return {
    subjectKey: requiredText(record.subjectKey, "responsibility.subjectKey"),
    conceptionOwnerId: requiredText(
      record.conceptionOwnerId,
      "responsibility.conceptionOwnerId",
    ),
    planningOwnerId: requiredText(
      record.planningOwnerId,
      "responsibility.planningOwnerId",
    ),
    executionOwnerId: requiredText(
      record.executionOwnerId,
      "responsibility.executionOwnerId",
    ),
    monitoringOwnerId: requiredText(
      record.monitoringOwnerId,
      "responsibility.monitoringOwnerId",
    ),
    minimumStandard: nullableText(
      record.minimumStandard,
      "responsibility.minimumStandard",
    ),
    acceptedBy: stringArray(record.acceptedBy, "responsibility.acceptedBy"),
    startsAt,
    endsAt,
  };
}

export function authorityRank(authority: SourceAuthorityClass): number {
  if (authority === "signed_school_correction") return 60;
  if (authority === "school_official") return 50;
  if (authority === "school_notice") return 40;
  if (authority === "school_calendar") return 30;
  if (authority === "owner_statement") return 20;
  return 10;
}

export function materialNoticeSha256(
  extraction: SchoolNoticeExtraction,
  childEntityId: string | null,
): string {
  return sha256(
    canonicalSchoolJson({
      extraction,
      childEntityId,
    }),
  );
}

export function sourceFactRevisionSha256(
  artifactId: string,
  candidate: SourceFactCandidate,
): string {
  return sha256(
    canonicalSchoolJson({
      artifactId,
      candidate,
    }),
  );
}
