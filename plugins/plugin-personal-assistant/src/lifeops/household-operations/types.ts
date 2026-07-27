/**
 * Typed household-operations records for vendors, maintenance, child items,
 * seasonal opportunities, responsibility ownership, and weekly briefs.
 *
 * Entity IDs always refer to the runtime knowledge graph. SQL records are
 * append-only domain projections; they never become a second identity graph,
 * scheduler, approval queue, or external-effect executor.
 */
import { createHash } from "node:crypto";
import { ElizaError, stableStringify } from "@elizaos/core";
import { isValidTimeZone } from "@elizaos/shared";

export type HouseholdOperationsJson =
  | null
  | boolean
  | number
  | string
  | HouseholdOperationsJson[]
  | { [key: string]: HouseholdOperationsJson };

export const HOUSEHOLD_OPERATION_RECORD_KINDS = [
  "vendor_profile",
  "almanac_entry",
  "opportunity",
  "item_threshold",
  "responsibility_assignment",
] as const;
export type HouseholdOperationRecordKind =
  (typeof HOUSEHOLD_OPERATION_RECORD_KINDS)[number];

export const HOUSEHOLD_OBSERVATION_KINDS = [
  "home_state",
  "inventory_level",
  "child_item_size",
] as const;
export type HouseholdObservationKind =
  (typeof HOUSEHOLD_OBSERVATION_KINDS)[number];

export const HOUSEHOLD_SOURCE_KINDS = [
  "authenticated_user",
  "provider_receipt",
  "vendor_receipt",
  "source_document",
  "photo",
  "sensor",
  "scheduled_task_state",
  "inference",
] as const;
export type HouseholdSourceKind = (typeof HOUSEHOLD_SOURCE_KINDS)[number];

export const HOUSEHOLD_AUTHORITY_CLASSES = [
  "user_confirmed",
  "provider_confirmed",
  "vendor_provided",
  "document_extracted",
  "sensor_observed",
  "inferred",
] as const;
export type HouseholdAuthorityClass =
  (typeof HOUSEHOLD_AUTHORITY_CLASSES)[number];

export const HOUSEHOLD_SERVICE_EVENT_KINDS = [
  "due_identified",
  "outreach_drafted",
  "outreach_approved",
  "outreach_sent",
  "scheduled",
  "completed",
  "cancelled",
  "failed",
  "unknown",
] as const;
export type HouseholdServiceEventKind =
  (typeof HOUSEHOLD_SERVICE_EVENT_KINDS)[number];

export const HOUSEHOLD_OPPORTUNITY_STATES = [
  "unknown",
  "not_open",
  "available",
  "full",
  "waitlisted",
  "confirmed",
  "declined",
  "closed",
] as const;
export type HouseholdOpportunityState =
  (typeof HOUSEHOLD_OPPORTUNITY_STATES)[number];

export const HOUSEHOLD_RESPONSIBILITY_PHASES = [
  "conception",
  "planning",
  "execution",
  "monitoring",
] as const;
export type HouseholdResponsibilityPhase =
  (typeof HOUSEHOLD_RESPONSIBILITY_PHASES)[number];

export const HOUSEHOLD_RESPONSIBILITY_SIGNAL_KINDS = [
  "delivered",
  "opened",
  "acknowledged",
  "dismissed",
  "declined",
  "overdue",
  "completed",
] as const;
export type HouseholdResponsibilitySignalKind =
  (typeof HOUSEHOLD_RESPONSIBILITY_SIGNAL_KINDS)[number];

export type HouseholdOperationsVisibility =
  | { kind: "owner_private" }
  | { kind: "household" }
  | { kind: "principals"; principalEntityIds: string[] }
  | { kind: "child_scoped"; childEntityId: string };

export interface HouseholdSourceProvenance {
  kind: HouseholdSourceKind;
  sourceId: string;
  sourceRevision: number;
  observedAt: string;
  evidenceRef: string;
  authority: HouseholdAuthorityClass;
  confidence: number;
}

export interface LocalAccessWindow {
  daysOfWeek: number[];
  localStart: string;
  localEnd: string;
  timezone: string;
  note: string | null;
}

interface HouseholdRecordDefinitionBase {
  kind: HouseholdOperationRecordKind;
  recordId: string;
  householdId: string;
  active: boolean;
  visibility: HouseholdOperationsVisibility;
}

export interface VendorProfileDefinition extends HouseholdRecordDefinitionBase {
  kind: "vendor_profile";
  vendorEntityId: string;
  serviceKinds: string[];
  contactRouteRefs: string[];
  accessWindows: LocalAccessWindow[];
  accountReference: string | null;
  notes: string | null;
}

export type AlmanacTrigger =
  | {
      kind: "annual_window";
      opens: { month: number; day: number };
      closes: { month: number; day: number };
      timezone: string;
    }
  | {
      kind: "interval_after_service";
      serviceKind: string;
      afterDays: number;
      windowDays: number;
      timezone: string;
    }
  | {
      kind: "source_window";
      opensAt: string;
      closesAt: string;
      timezone: string;
    };

export interface AlmanacEntryDefinition extends HouseholdRecordDefinitionBase {
  kind: "almanac_entry";
  title: string;
  subjectKey: string;
  category: "maintenance" | "registration" | "replacement" | "family_capacity";
  trigger: AlmanacTrigger;
  vendorProfileRecordId: string | null;
  responsibilityAssignmentId: string | null;
  preparationLeadDays: number;
  sourceObservationIds: string[];
}

export interface HouseholdCapacityPolicy {
  preserveUnstructuredTime: boolean;
  maximumStructuredHoursPerWeek: number | null;
  existingStructuredHoursPerWeek: number | null;
  evidenceRefs: string[];
}

export interface OpportunityDefinition extends HouseholdRecordDefinitionBase {
  kind: "opportunity";
  title: string;
  subjectKey: string;
  subjectEntityIds: string[];
  almanacEntryRecordId: string;
  opensAt: string;
  closesAt: string;
  state: HouseholdOpportunityState;
  coverageContribution: "none" | "confirmed";
  confirmationEvidenceRef: string | null;
  plannedStructuredHoursPerWeek: number | null;
  capacityPolicy: HouseholdCapacityPolicy;
  proposedEffect: "read_only" | "external_outreach" | "registration";
  approvalRequirement: "none" | "owner_approval" | "multi_party_approval";
  effectIdempotencyKey: string;
  provenance: HouseholdSourceProvenance;
}

export interface ItemReplacementThresholdDefinition
  extends HouseholdRecordDefinitionBase {
  kind: "item_threshold";
  childEntityId: string;
  itemCategory: string;
  inventorySubjectKey: string | null;
  minimumUsableCount: number | null;
  replacementFitStates: Array<"too_small" | "damaged">;
  approvalRequirement: "owner_approval" | "multi_party_approval";
}

export interface ResponsibilityOwners {
  conceptionOwnerId: string;
  planningOwnerId: string;
  executionOwnerId: string;
  monitoringOwnerId: string;
}

export interface ResponsibilityNonUsePolicy {
  dismissalThreshold: number;
  overdueThreshold: number;
  evaluationWindowDays: number;
  escalationMode:
    | "private_renegotiation"
    | "household_conversation"
    | "request_acknowledgement";
}

export interface ResponsibilityAssignmentDefinition
  extends HouseholdRecordDefinitionBase {
  kind: "responsibility_assignment";
  subjectKey: string;
  owners: ResponsibilityOwners;
  minimumStandard: string | null;
  acceptedByEntityIds: string[];
  startsAt: string;
  endsAt: string | null;
  nonUsePolicy: ResponsibilityNonUsePolicy;
}

export type HouseholdOperationDefinition =
  | VendorProfileDefinition
  | AlmanacEntryDefinition
  | OpportunityDefinition
  | ItemReplacementThresholdDefinition
  | ResponsibilityAssignmentDefinition;

export type HouseholdOperationRevision<
  T extends HouseholdOperationDefinition = HouseholdOperationDefinition,
> = T & {
  revision: number;
  contentSha256: string;
  createdAt: string;
};

export type HouseholdObservationValue =
  | {
      kind: "home_state";
      state: string;
      details: HouseholdOperationsJson | null;
    }
  | {
      kind: "inventory_level";
      quantity: number | null;
      unit: string;
      state: "confirmed" | "estimated" | "unknown";
    }
  | {
      kind: "child_item_size";
      childEntityId: string;
      itemCategory: string;
      sizeLabel: string | null;
      fitState: "too_small" | "fits" | "room_to_grow" | "damaged" | "unknown";
      measurement: {
        value: number;
        unit: "cm" | "in";
      } | null;
    };

export interface HouseholdObservationInput {
  householdId: string;
  subjectKey: string;
  subjectEntityIds: string[];
  observationKind: HouseholdObservationKind;
  value: HouseholdObservationValue;
  provenance: HouseholdSourceProvenance;
  visibility: HouseholdOperationsVisibility;
  supersedesObservationId: string | null;
  correctsObservationId: string | null;
}

export interface HouseholdObservation extends HouseholdObservationInput {
  observationId: string;
  contentSha256: string;
  createdAt: string;
}

export type HouseholdObservationResolution =
  | { state: "unknown"; reason: "no_observation" | "low_confidence" }
  | {
      state: "ambiguous";
      observationIds: string[];
      reason: "equal_authority_conflict";
    }
  | { state: "known"; observation: HouseholdObservation };

export interface HouseholdServiceWindow {
  startsAt: string;
  endsAt: string;
}

export interface HouseholdServiceEventInput {
  eventKey: string;
  householdId: string;
  subjectKey: string;
  serviceKind: string;
  vendorEntityId: string | null;
  eventKind: HouseholdServiceEventKind;
  serviceWindow: HouseholdServiceWindow | null;
  relatedCalendarEventId: string | null;
  approvalReference: string | null;
  providerReceiptReference: string | null;
  completionEvidenceReference: string | null;
  provenance: HouseholdSourceProvenance;
  visibility: HouseholdOperationsVisibility;
}

export interface HouseholdServiceEvent extends HouseholdServiceEventInput {
  eventId: string;
  contentSha256: string;
  createdAt: string;
}

export interface ResponsibilitySignalInput {
  signalKey: string;
  householdId: string;
  assignmentRecordId: string;
  assignmentRevision: number;
  phase: HouseholdResponsibilityPhase;
  ownerEntityId: string;
  signalKind: HouseholdResponsibilitySignalKind;
  relatedTaskId: string | null;
  provenance: HouseholdSourceProvenance;
}

export interface ResponsibilitySignal extends ResponsibilitySignalInput {
  signalId: string;
  contentSha256: string;
  createdAt: string;
}

export interface ResponsibilityReviewProposal {
  reviewId: string;
  householdId: string;
  assignmentRecordId: string;
  assignmentRevision: number;
  snapshotSha256: string;
  trigger: "repeated_dismissal" | "repeated_overdue" | "dismissal_and_overdue";
  currentOwners: ResponsibilityOwners;
  ownerChanges: [];
  affectedEntityIds: string[];
  requiredApproverEntityIds: string[];
  proposedMode: ResponsibilityNonUsePolicy["escalationMode"];
  state: "proposed";
  createdAt: string;
}

export interface OpportunityEvaluation {
  state: "recommend" | "do_not_recommend" | "needs_information" | "complete";
  countsAsCoverage: boolean;
  reasons: string[];
  effectDraft: {
    effect: OpportunityDefinition["proposedEffect"];
    idempotencyKey: string;
    approvalRequirement: OpportunityDefinition["approvalRequirement"];
  } | null;
}

export interface ItemReplacementRecommendation {
  state: "no_action" | "verify" | "replacement_draft";
  reasons: string[];
  purchaseAllowed: false;
  approvalRequirement:
    | ItemReplacementThresholdDefinition["approvalRequirement"]
    | null;
  sourceObservationIds: string[];
}

export interface AlmanacWindowResolution {
  state: "known" | "unknown";
  startsAt: string | null;
  endsAt: string | null;
  reason: string | null;
  sourceEventId: string | null;
}

export interface HouseholdWeeklyBriefItem {
  itemId: string;
  kind:
    | "maintenance_due"
    | "opportunity"
    | "item_replacement"
    | "responsibility_review";
  title: string;
  subjectKey: string;
  state: string;
  dueWindow: HouseholdServiceWindow | null;
  responsibleEntityIds: string[];
  sourceRefs: string[];
  uncertainty: "none" | "needs_information" | "ambiguous";
  visibility: HouseholdOperationsVisibility;
  proposedAction: {
    effect:
      | "read_only"
      | "verify"
      | "external_outreach_draft"
      | "registration_draft"
      | "purchase_draft"
      | "renegotiation_proposal";
    approvalRequirement: "none" | "owner_approval" | "multi_party_approval";
    idempotencyKey: string | null;
  };
  vendorContext: {
    vendorEntityId: string;
    contactRouteRefs: string[];
    accessWindows: LocalAccessWindow[];
  } | null;
  countsAsCoverage: boolean | null;
  calendarCheck: {
    state: "required" | "available" | "conflicted" | "unknown";
    checkedAt: string | null;
    sourceRefs: string[];
    conflictRefs: string[];
  } | null;
}

export interface HouseholdCalendarCheck {
  subjectKey: string;
  window: HouseholdServiceWindow;
  state: "available" | "conflicted" | "unknown";
  checkedAt: string;
  sourceRefs: string[];
  conflictRefs: string[];
}

export interface HouseholdWeeklyBriefQuestion {
  questionId: string;
  prompt: string;
  sourceRefs: string[];
  visibility: HouseholdOperationsVisibility;
}

export interface HouseholdWeeklyBrief {
  briefId: string;
  householdId: string;
  window: HouseholdServiceWindow;
  generatedAt: string;
  snapshotSha256: string;
  items: HouseholdWeeklyBriefItem[];
  questions: HouseholdWeeklyBriefQuestion[];
  createdAt: string;
}

export interface HouseholdWeeklyBriefView {
  briefId: string;
  householdId: string;
  window: HouseholdServiceWindow;
  generatedAt: string;
  snapshotSha256: string;
  items: HouseholdWeeklyBriefItem[];
  questions: HouseholdWeeklyBriefQuestion[];
}

export type HouseholdOperationsErrorCode =
  | "HOUSEHOLD_OPERATIONS_ACCESS_DENIED"
  | "HOUSEHOLD_OPERATIONS_AMBIGUOUS"
  | "HOUSEHOLD_OPERATIONS_CONFLICT"
  | "HOUSEHOLD_OPERATIONS_ENTITY_NOT_FOUND"
  | "HOUSEHOLD_OPERATIONS_GRAPH_UNAVAILABLE"
  | "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT"
  | "HOUSEHOLD_OPERATIONS_NOT_FOUND"
  | "HOUSEHOLD_OPERATIONS_RELATIONSHIP_REQUIRED";

export class HouseholdOperationsError extends ElizaError {
  override readonly name = "HouseholdOperationsError";

  constructor(
    message: string,
    code: HouseholdOperationsErrorCode,
    context?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, {
      code,
      context,
      cause,
      severity:
        code === "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT" ||
        code === "HOUSEHOLD_OPERATIONS_GRAPH_UNAVAILABLE"
          ? "fatal"
          : "ephemeral",
    });
  }
}

function invalid(message: string, context?: Record<string, unknown>): never {
  throw new HouseholdOperationsError(
    message,
    "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
    context,
  );
}

export function requireOperationsText(
  value: unknown,
  field: string,
  maxLength = 500,
): string {
  if (typeof value !== "string") {
    return invalid(`${field} must be a string`, { field });
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    return invalid(`${field} must contain 1-${maxLength} characters`, {
      field,
    });
  }
  for (const character of normalized) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 8) ||
        codePoint === 11 ||
        codePoint === 12 ||
        (codePoint >= 14 && codePoint <= 31) ||
        codePoint === 127)
    ) {
      return invalid(`${field} contains a disallowed control character`, {
        field,
      });
    }
  }
  return normalized;
}

export function optionalOperationsText(
  value: unknown,
  field: string,
  maxLength = 2_000,
): string | null {
  if (value === null || value === undefined) return null;
  return requireOperationsText(value, field, maxLength);
}

export function requireOperationsInteger(
  value: unknown,
  field: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return invalid(
      `${field} must be an integer from ${minimum} to ${maximum}`,
      {
        field,
      },
    );
  }
  return value;
}

export function requireOperationsNumber(
  value: unknown,
  field: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    return invalid(`${field} must be a finite number`, { field });
  }
  return value;
}

export function requireOperationsTimestamp(
  value: unknown,
  field: string,
): string {
  const text = requireOperationsText(value, field, 100);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    return invalid(`${field} must be an ISO-8601 timestamp`, { field });
  }
  return new Date(timestamp).toISOString();
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    return invalid(`${field} must be a boolean`, { field });
  }
  return value;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return invalid(`${field} must be a plain object`, { field });
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    return invalid(`${field} must be an array`, { field });
  }
  return value;
}

function stringArray(
  value: unknown,
  field: string,
  options?: { maxItems?: number; allowEmpty?: boolean },
): string[] {
  const array = requireArray(value, field);
  const maxItems = options?.maxItems ?? 100;
  if (array.length > maxItems || (!options?.allowEmpty && array.length === 0)) {
    return invalid(`${field} has an invalid number of entries`, { field });
  }
  return Array.from(
    new Set(
      array.map((entry, index) =>
        requireOperationsText(entry, `${field}[${index}]`, 500),
      ),
    ),
  ).sort();
}

function enumValue<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  const text = requireOperationsText(value, field, 100);
  const match = allowed.find((candidate) => candidate === text);
  if (!match) {
    return invalid(`${field} has an unsupported value`, { field, value: text });
  }
  return match;
}

export function normalizeVisibility(
  value: unknown,
  field = "visibility",
): HouseholdOperationsVisibility {
  const record = requireObject(value, field);
  const kind = enumValue(record.kind, `${field}.kind`, [
    "owner_private",
    "household",
    "principals",
    "child_scoped",
  ] as const);
  if (kind === "principals") {
    return {
      kind,
      principalEntityIds: stringArray(
        record.principalEntityIds,
        `${field}.principalEntityIds`,
      ),
    };
  }
  if (kind === "child_scoped") {
    return {
      kind,
      childEntityId: requireOperationsText(
        record.childEntityId,
        `${field}.childEntityId`,
        300,
      ),
    };
  }
  return { kind };
}

function normalizeProvenance(
  value: unknown,
  field = "provenance",
): HouseholdSourceProvenance {
  const record = requireObject(value, field);
  const kind = enumValue(record.kind, `${field}.kind`, HOUSEHOLD_SOURCE_KINDS);
  const authority = enumValue(
    record.authority,
    `${field}.authority`,
    HOUSEHOLD_AUTHORITY_CLASSES,
  );
  const allowedAuthorities: Record<
    HouseholdSourceKind,
    readonly HouseholdAuthorityClass[]
  > = {
    authenticated_user: ["user_confirmed"],
    provider_receipt: ["provider_confirmed"],
    vendor_receipt: ["vendor_provided", "provider_confirmed"],
    source_document: ["document_extracted"],
    photo: ["document_extracted"],
    sensor: ["sensor_observed"],
    scheduled_task_state: ["provider_confirmed"],
    inference: ["inferred"],
  };
  if (!allowedAuthorities[kind].includes(authority)) {
    return invalid(
      `${field}.authority is not valid for the declared source kind`,
      { field, kind, authority },
    );
  }
  return {
    kind,
    sourceId: requireOperationsText(record.sourceId, `${field}.sourceId`, 500),
    sourceRevision: requireOperationsInteger(
      record.sourceRevision,
      `${field}.sourceRevision`,
      1,
    ),
    observedAt: requireOperationsTimestamp(
      record.observedAt,
      `${field}.observedAt`,
    ),
    evidenceRef: requireOperationsText(
      record.evidenceRef,
      `${field}.evidenceRef`,
      1_000,
    ),
    authority,
    confidence: requireOperationsNumber(
      record.confidence,
      `${field}.confidence`,
      0,
      1,
    ),
  };
}

function normalizeAccessWindow(
  value: unknown,
  field: string,
): LocalAccessWindow {
  const record = requireObject(value, field);
  const days = requireArray(record.daysOfWeek, `${field}.daysOfWeek`).map(
    (day, index) =>
      requireOperationsInteger(day, `${field}.daysOfWeek[${index}]`, 0, 6),
  );
  if (days.length === 0) {
    return invalid(`${field}.daysOfWeek cannot be empty`, { field });
  }
  const localStart = requireOperationsText(
    record.localStart,
    `${field}.localStart`,
    5,
  );
  const localEnd = requireOperationsText(
    record.localEnd,
    `${field}.localEnd`,
    5,
  );
  const localTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
  if (
    !localTimePattern.test(localStart) ||
    !localTimePattern.test(localEnd) ||
    localStart >= localEnd
  ) {
    return invalid(`${field} has an invalid local time window`, { field });
  }
  const timezone = requireOperationsText(
    record.timezone,
    `${field}.timezone`,
    100,
  );
  if (!isValidTimeZone(timezone)) {
    return invalid(`${field}.timezone is not an IANA timezone`, { timezone });
  }
  return {
    daysOfWeek: Array.from(new Set(days)).sort((left, right) => left - right),
    localStart,
    localEnd,
    timezone,
    note: optionalOperationsText(record.note, `${field}.note`, 500),
  };
}

function normalizeBase(
  value: unknown,
  expectedKind: HouseholdOperationRecordKind,
): HouseholdRecordDefinitionBase {
  const record = requireObject(value, expectedKind);
  const kind = enumValue(
    record.kind,
    `${expectedKind}.kind`,
    HOUSEHOLD_OPERATION_RECORD_KINDS,
  );
  if (kind !== expectedKind) {
    return invalid(`Expected ${expectedKind}, received ${kind}`, {
      expectedKind,
      kind,
    });
  }
  return {
    kind,
    recordId: requireOperationsText(record.recordId, `${kind}.recordId`, 300),
    householdId: requireOperationsText(
      record.householdId,
      `${kind}.householdId`,
      300,
    ),
    active: requireBoolean(record.active, `${kind}.active`),
    visibility: normalizeVisibility(record.visibility, `${kind}.visibility`),
  };
}

export function normalizeVendorProfileDefinition(
  value: unknown,
): VendorProfileDefinition {
  const record = requireObject(value, "vendor_profile");
  return {
    ...normalizeBase(record, "vendor_profile"),
    kind: "vendor_profile",
    vendorEntityId: requireOperationsText(
      record.vendorEntityId,
      "vendor_profile.vendorEntityId",
      300,
    ),
    serviceKinds: stringArray(
      record.serviceKinds,
      "vendor_profile.serviceKinds",
    ),
    contactRouteRefs: stringArray(
      record.contactRouteRefs,
      "vendor_profile.contactRouteRefs",
    ),
    accessWindows: requireArray(
      record.accessWindows,
      "vendor_profile.accessWindows",
    ).map((entry, index) =>
      normalizeAccessWindow(entry, `vendor_profile.accessWindows[${index}]`),
    ),
    accountReference: optionalOperationsText(
      record.accountReference,
      "vendor_profile.accountReference",
      500,
    ),
    notes: optionalOperationsText(record.notes, "vendor_profile.notes", 2_000),
  };
}

function normalizeMonthDay(
  value: unknown,
  field: string,
): { month: number; day: number } {
  const record = requireObject(value, field);
  const month = requireOperationsInteger(record.month, `${field}.month`, 1, 12);
  const day = requireOperationsInteger(record.day, `${field}.day`, 1, 31);
  const probe = new Date(Date.UTC(2024, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return invalid(`${field} is not a valid calendar date`, { field });
  }
  return { month, day };
}

function normalizeAlmanacTrigger(value: unknown): AlmanacTrigger {
  const record = requireObject(value, "almanac_entry.trigger");
  const kind = enumValue(record.kind, "almanac_entry.trigger.kind", [
    "annual_window",
    "interval_after_service",
    "source_window",
  ] as const);
  const timezone = requireOperationsText(
    record.timezone,
    "almanac_entry.trigger.timezone",
    100,
  );
  if (!isValidTimeZone(timezone)) {
    return invalid("almanac_entry.trigger.timezone is not an IANA timezone", {
      timezone,
    });
  }
  if (kind === "annual_window") {
    return {
      kind,
      opens: normalizeMonthDay(record.opens, "almanac_entry.trigger.opens"),
      closes: normalizeMonthDay(record.closes, "almanac_entry.trigger.closes"),
      timezone,
    };
  }
  if (kind === "interval_after_service") {
    return {
      kind,
      serviceKind: requireOperationsText(
        record.serviceKind,
        "almanac_entry.trigger.serviceKind",
        200,
      ),
      afterDays: requireOperationsInteger(
        record.afterDays,
        "almanac_entry.trigger.afterDays",
        1,
        3_650,
      ),
      windowDays: requireOperationsInteger(
        record.windowDays,
        "almanac_entry.trigger.windowDays",
        1,
        365,
      ),
      timezone,
    };
  }
  const opensAt = requireOperationsTimestamp(
    record.opensAt,
    "almanac_entry.trigger.opensAt",
  );
  const closesAt = requireOperationsTimestamp(
    record.closesAt,
    "almanac_entry.trigger.closesAt",
  );
  if (Date.parse(opensAt) >= Date.parse(closesAt)) {
    return invalid("almanac source window must close after it opens");
  }
  return { kind, opensAt, closesAt, timezone };
}

export function normalizeAlmanacEntryDefinition(
  value: unknown,
): AlmanacEntryDefinition {
  const record = requireObject(value, "almanac_entry");
  return {
    ...normalizeBase(record, "almanac_entry"),
    kind: "almanac_entry",
    title: requireOperationsText(record.title, "almanac_entry.title", 500),
    subjectKey: requireOperationsText(
      record.subjectKey,
      "almanac_entry.subjectKey",
      300,
    ),
    category: enumValue(record.category, "almanac_entry.category", [
      "maintenance",
      "registration",
      "replacement",
      "family_capacity",
    ] as const),
    trigger: normalizeAlmanacTrigger(record.trigger),
    vendorProfileRecordId: optionalOperationsText(
      record.vendorProfileRecordId,
      "almanac_entry.vendorProfileRecordId",
      300,
    ),
    responsibilityAssignmentId: optionalOperationsText(
      record.responsibilityAssignmentId,
      "almanac_entry.responsibilityAssignmentId",
      300,
    ),
    preparationLeadDays: requireOperationsInteger(
      record.preparationLeadDays,
      "almanac_entry.preparationLeadDays",
      0,
      365,
    ),
    sourceObservationIds: stringArray(
      record.sourceObservationIds,
      "almanac_entry.sourceObservationIds",
      { allowEmpty: true },
    ),
  };
}

function normalizeCapacityPolicy(value: unknown): HouseholdCapacityPolicy {
  const record = requireObject(value, "opportunity.capacityPolicy");
  return {
    preserveUnstructuredTime: requireBoolean(
      record.preserveUnstructuredTime,
      "opportunity.capacityPolicy.preserveUnstructuredTime",
    ),
    maximumStructuredHoursPerWeek:
      record.maximumStructuredHoursPerWeek === null
        ? null
        : requireOperationsNumber(
            record.maximumStructuredHoursPerWeek,
            "opportunity.capacityPolicy.maximumStructuredHoursPerWeek",
            0,
            168,
          ),
    existingStructuredHoursPerWeek:
      record.existingStructuredHoursPerWeek === null
        ? null
        : requireOperationsNumber(
            record.existingStructuredHoursPerWeek,
            "opportunity.capacityPolicy.existingStructuredHoursPerWeek",
            0,
            168,
          ),
    evidenceRefs: stringArray(
      record.evidenceRefs,
      "opportunity.capacityPolicy.evidenceRefs",
      { allowEmpty: true },
    ),
  };
}

export function normalizeOpportunityDefinition(
  value: unknown,
): OpportunityDefinition {
  const record = requireObject(value, "opportunity");
  const state = enumValue(
    record.state,
    "opportunity.state",
    HOUSEHOLD_OPPORTUNITY_STATES,
  );
  const coverageContribution = enumValue(
    record.coverageContribution,
    "opportunity.coverageContribution",
    ["none", "confirmed"] as const,
  );
  const confirmationEvidenceRef = optionalOperationsText(
    record.confirmationEvidenceRef,
    "opportunity.confirmationEvidenceRef",
    1_000,
  );
  if (coverageContribution === "confirmed") {
    if (state !== "confirmed" || !confirmationEvidenceRef) {
      return invalid(
        "Only an evidenced confirmed opportunity may count as coverage",
        { state, coverageContribution },
      );
    }
  } else if (state === "confirmed") {
    return invalid(
      "Confirmed opportunities require evidenced confirmed coverage",
    );
  }
  const opensAt = requireOperationsTimestamp(
    record.opensAt,
    "opportunity.opensAt",
  );
  const closesAt = requireOperationsTimestamp(
    record.closesAt,
    "opportunity.closesAt",
  );
  if (Date.parse(opensAt) >= Date.parse(closesAt)) {
    return invalid("opportunity.closesAt must be after opensAt");
  }
  const proposedEffect = enumValue(
    record.proposedEffect,
    "opportunity.proposedEffect",
    ["read_only", "external_outreach", "registration"] as const,
  );
  const approvalRequirement = enumValue(
    record.approvalRequirement,
    "opportunity.approvalRequirement",
    ["none", "owner_approval", "multi_party_approval"] as const,
  );
  if (proposedEffect !== "read_only" && approvalRequirement === "none") {
    return invalid("Consequential opportunity effects require approval");
  }
  return {
    ...normalizeBase(record, "opportunity"),
    kind: "opportunity",
    title: requireOperationsText(record.title, "opportunity.title", 500),
    subjectKey: requireOperationsText(
      record.subjectKey,
      "opportunity.subjectKey",
      300,
    ),
    subjectEntityIds: stringArray(
      record.subjectEntityIds,
      "opportunity.subjectEntityIds",
    ),
    almanacEntryRecordId: requireOperationsText(
      record.almanacEntryRecordId,
      "opportunity.almanacEntryRecordId",
      300,
    ),
    opensAt,
    closesAt,
    state,
    coverageContribution,
    confirmationEvidenceRef,
    plannedStructuredHoursPerWeek:
      record.plannedStructuredHoursPerWeek === null
        ? null
        : requireOperationsNumber(
            record.plannedStructuredHoursPerWeek,
            "opportunity.plannedStructuredHoursPerWeek",
            0,
            168,
          ),
    capacityPolicy: normalizeCapacityPolicy(record.capacityPolicy),
    proposedEffect,
    approvalRequirement,
    effectIdempotencyKey: requireOperationsText(
      record.effectIdempotencyKey,
      "opportunity.effectIdempotencyKey",
      500,
    ),
    provenance: normalizeProvenance(
      record.provenance,
      "opportunity.provenance",
    ),
  };
}

export function normalizeItemThresholdDefinition(
  value: unknown,
): ItemReplacementThresholdDefinition {
  const record = requireObject(value, "item_threshold");
  const replacementFitStates = requireArray(
    record.replacementFitStates,
    "item_threshold.replacementFitStates",
  ).map((entry, index) =>
    enumValue(entry, `item_threshold.replacementFitStates[${index}]`, [
      "too_small",
      "damaged",
    ] as const),
  );
  if (replacementFitStates.length === 0) {
    return invalid("item_threshold.replacementFitStates cannot be empty");
  }
  return {
    ...normalizeBase(record, "item_threshold"),
    kind: "item_threshold",
    childEntityId: requireOperationsText(
      record.childEntityId,
      "item_threshold.childEntityId",
      300,
    ),
    itemCategory: requireOperationsText(
      record.itemCategory,
      "item_threshold.itemCategory",
      300,
    ),
    inventorySubjectKey: optionalOperationsText(
      record.inventorySubjectKey,
      "item_threshold.inventorySubjectKey",
      300,
    ),
    minimumUsableCount:
      record.minimumUsableCount === null
        ? null
        : requireOperationsInteger(
            record.minimumUsableCount,
            "item_threshold.minimumUsableCount",
            0,
            10_000,
          ),
    replacementFitStates: Array.from(new Set(replacementFitStates)),
    approvalRequirement: enumValue(
      record.approvalRequirement,
      "item_threshold.approvalRequirement",
      ["owner_approval", "multi_party_approval"] as const,
    ),
  };
}

function normalizeResponsibilityOwners(value: unknown): ResponsibilityOwners {
  const record = requireObject(value, "responsibility_assignment.owners");
  return {
    conceptionOwnerId: requireOperationsText(
      record.conceptionOwnerId,
      "responsibility_assignment.owners.conceptionOwnerId",
      300,
    ),
    planningOwnerId: requireOperationsText(
      record.planningOwnerId,
      "responsibility_assignment.owners.planningOwnerId",
      300,
    ),
    executionOwnerId: requireOperationsText(
      record.executionOwnerId,
      "responsibility_assignment.owners.executionOwnerId",
      300,
    ),
    monitoringOwnerId: requireOperationsText(
      record.monitoringOwnerId,
      "responsibility_assignment.owners.monitoringOwnerId",
      300,
    ),
  };
}

function normalizeNonUsePolicy(value: unknown): ResponsibilityNonUsePolicy {
  const record = requireObject(value, "responsibility_assignment.nonUsePolicy");
  return {
    dismissalThreshold: requireOperationsInteger(
      record.dismissalThreshold,
      "responsibility_assignment.nonUsePolicy.dismissalThreshold",
      1,
      20,
    ),
    overdueThreshold: requireOperationsInteger(
      record.overdueThreshold,
      "responsibility_assignment.nonUsePolicy.overdueThreshold",
      1,
      20,
    ),
    evaluationWindowDays: requireOperationsInteger(
      record.evaluationWindowDays,
      "responsibility_assignment.nonUsePolicy.evaluationWindowDays",
      1,
      365,
    ),
    escalationMode: enumValue(
      record.escalationMode,
      "responsibility_assignment.nonUsePolicy.escalationMode",
      [
        "private_renegotiation",
        "household_conversation",
        "request_acknowledgement",
      ] as const,
    ),
  };
}

export function normalizeResponsibilityAssignmentDefinition(
  value: unknown,
): ResponsibilityAssignmentDefinition {
  const record = requireObject(value, "responsibility_assignment");
  const startsAt = requireOperationsTimestamp(
    record.startsAt,
    "responsibility_assignment.startsAt",
  );
  const endsAt =
    record.endsAt === null
      ? null
      : requireOperationsTimestamp(
          record.endsAt,
          "responsibility_assignment.endsAt",
        );
  if (endsAt !== null && Date.parse(startsAt) >= Date.parse(endsAt)) {
    return invalid("responsibility_assignment.endsAt must be after startsAt");
  }
  const owners = normalizeResponsibilityOwners(record.owners);
  const acceptedByEntityIds = stringArray(
    record.acceptedByEntityIds,
    "responsibility_assignment.acceptedByEntityIds",
  );
  const ownerIds = Object.values(owners);
  const unaccepted = ownerIds.filter(
    (ownerId) => !acceptedByEntityIds.includes(ownerId),
  );
  if (unaccepted.length > 0) {
    return invalid(
      "Every named responsibility owner must have accepted the assignment",
      { unaccepted },
    );
  }
  return {
    ...normalizeBase(record, "responsibility_assignment"),
    kind: "responsibility_assignment",
    subjectKey: requireOperationsText(
      record.subjectKey,
      "responsibility_assignment.subjectKey",
      300,
    ),
    owners,
    minimumStandard: optionalOperationsText(
      record.minimumStandard,
      "responsibility_assignment.minimumStandard",
      2_000,
    ),
    acceptedByEntityIds,
    startsAt,
    endsAt,
    nonUsePolicy: normalizeNonUsePolicy(record.nonUsePolicy),
  };
}

export function normalizeOperationDefinition(
  value: unknown,
): HouseholdOperationDefinition {
  const record = requireObject(value, "household operation definition");
  const kind = enumValue(
    record.kind,
    "household operation definition.kind",
    HOUSEHOLD_OPERATION_RECORD_KINDS,
  );
  if (kind === "vendor_profile")
    return normalizeVendorProfileDefinition(record);
  if (kind === "almanac_entry") return normalizeAlmanacEntryDefinition(record);
  if (kind === "opportunity") return normalizeOpportunityDefinition(record);
  if (kind === "item_threshold") {
    return normalizeItemThresholdDefinition(record);
  }
  return normalizeResponsibilityAssignmentDefinition(record);
}

export function normalizeOperationRevision(
  value: unknown,
): HouseholdOperationRevision {
  const record = requireObject(value, "household operation revision");
  const definition = normalizeOperationDefinition(record);
  const revision = requireOperationsInteger(record.revision, "revision", 1);
  const createdAt = requireOperationsTimestamp(record.createdAt, "createdAt");
  const contentSha256 = requireOperationsText(
    record.contentSha256,
    "contentSha256",
    64,
  );
  const expected = operationRevisionSha256(definition, revision);
  if (contentSha256 !== expected) {
    return invalid("Household operation revision content hash is invalid", {
      recordId: definition.recordId,
      revision,
    });
  }
  return { ...definition, revision, contentSha256, createdAt };
}

function normalizeJson(
  value: unknown,
  field: string,
  depth = 0,
): HouseholdOperationsJson {
  if (depth > 12) {
    return invalid(`${field} exceeds the maximum nesting depth`, { field });
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    if (typeof value === "string") {
      return requireOperationsText(value, field, 4_000);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return invalid(`${field} contains a non-finite number`, { field });
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 200) {
      return invalid(`${field} contains too many entries`, { field });
    }
    return value.map((entry, index) =>
      normalizeJson(entry, `${field}[${index}]`, depth + 1),
    );
  }
  const record = requireObject(value, field);
  const output: { [key: string]: HouseholdOperationsJson } = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      return invalid(`${field} contains a forbidden object key`, { field });
    }
    output[requireOperationsText(key, `${field}.key`, 200)] = normalizeJson(
      entry,
      `${field}.${key}`,
      depth + 1,
    );
  }
  if (stableStringify(output).length > 32_768) {
    return invalid(`${field} exceeds the maximum encoded size`, { field });
  }
  return output;
}

function normalizeObservationValue(value: unknown): HouseholdObservationValue {
  const record = requireObject(value, "observation.value");
  const kind = enumValue(record.kind, "observation.value.kind", [
    "home_state",
    "inventory_level",
    "child_item_size",
  ] as const);
  if (kind === "home_state") {
    return {
      kind,
      state: requireOperationsText(
        record.state,
        "observation.value.state",
        300,
      ),
      details:
        record.details === null
          ? null
          : normalizeJson(record.details, "observation.value.details"),
    };
  }
  if (kind === "inventory_level") {
    return {
      kind,
      quantity:
        record.quantity === null
          ? null
          : requireOperationsNumber(
              record.quantity,
              "observation.value.quantity",
              0,
              1_000_000,
            ),
      unit: requireOperationsText(record.unit, "observation.value.unit", 100),
      state: enumValue(record.state, "observation.value.state", [
        "confirmed",
        "estimated",
        "unknown",
      ] as const),
    };
  }
  const measurementRecord =
    record.measurement === null
      ? null
      : requireObject(record.measurement, "observation.value.measurement");
  return {
    kind,
    childEntityId: requireOperationsText(
      record.childEntityId,
      "observation.value.childEntityId",
      300,
    ),
    itemCategory: requireOperationsText(
      record.itemCategory,
      "observation.value.itemCategory",
      300,
    ),
    sizeLabel: optionalOperationsText(
      record.sizeLabel,
      "observation.value.sizeLabel",
      200,
    ),
    fitState: enumValue(record.fitState, "observation.value.fitState", [
      "too_small",
      "fits",
      "room_to_grow",
      "damaged",
      "unknown",
    ] as const),
    measurement: measurementRecord
      ? {
          value: requireOperationsNumber(
            measurementRecord.value,
            "observation.value.measurement.value",
            0,
            1_000,
          ),
          unit: enumValue(
            measurementRecord.unit,
            "observation.value.measurement.unit",
            ["cm", "in"] as const,
          ),
        }
      : null,
  };
}

export function normalizeObservationInput(
  value: unknown,
): HouseholdObservationInput {
  const record = requireObject(value, "observation");
  const observationKind = enumValue(
    record.observationKind,
    "observation.observationKind",
    HOUSEHOLD_OBSERVATION_KINDS,
  );
  const observationValue = normalizeObservationValue(record.value);
  if (observationValue.kind !== observationKind) {
    return invalid(
      "observationKind must match the discriminated observation value",
      { observationKind, valueKind: observationValue.kind },
    );
  }
  return {
    householdId: requireOperationsText(
      record.householdId,
      "observation.householdId",
      300,
    ),
    subjectKey: requireOperationsText(
      record.subjectKey,
      "observation.subjectKey",
      300,
    ),
    subjectEntityIds: stringArray(
      record.subjectEntityIds,
      "observation.subjectEntityIds",
      { allowEmpty: true },
    ),
    observationKind,
    value: observationValue,
    provenance: normalizeProvenance(
      record.provenance,
      "observation.provenance",
    ),
    visibility: normalizeVisibility(
      record.visibility,
      "observation.visibility",
    ),
    supersedesObservationId: optionalOperationsText(
      record.supersedesObservationId,
      "observation.supersedesObservationId",
      300,
    ),
    correctsObservationId: optionalOperationsText(
      record.correctsObservationId,
      "observation.correctsObservationId",
      300,
    ),
  };
}

export function normalizeObservation(value: unknown): HouseholdObservation {
  const record = requireObject(value, "observation");
  const input = normalizeObservationInput(record);
  const observationId = requireOperationsText(
    record.observationId,
    "observation.observationId",
    300,
  );
  const createdAt = requireOperationsTimestamp(
    record.createdAt,
    "observation.createdAt",
  );
  const contentSha256 = requireOperationsText(
    record.contentSha256,
    "observation.contentSha256",
    64,
  );
  if (contentSha256 !== contentSha(input)) {
    return invalid("Household observation content hash is invalid", {
      observationId,
    });
  }
  return { ...input, observationId, contentSha256, createdAt };
}

export function normalizeServiceEventInput(
  value: unknown,
): HouseholdServiceEventInput {
  const record = requireObject(value, "serviceEvent");
  const eventKind = enumValue(
    record.eventKind,
    "serviceEvent.eventKind",
    HOUSEHOLD_SERVICE_EVENT_KINDS,
  );
  const approvalReference = optionalOperationsText(
    record.approvalReference,
    "serviceEvent.approvalReference",
    1_000,
  );
  const providerReceiptReference = optionalOperationsText(
    record.providerReceiptReference,
    "serviceEvent.providerReceiptReference",
    1_000,
  );
  const completionEvidenceReference = optionalOperationsText(
    record.completionEvidenceReference,
    "serviceEvent.completionEvidenceReference",
    1_000,
  );
  if (
    (eventKind === "outreach_sent" || eventKind === "scheduled") &&
    (!approvalReference || !providerReceiptReference)
  ) {
    return invalid(
      `${eventKind} requires an approval and provider receipt reference`,
      { eventKind },
    );
  }
  if (eventKind === "completed" && !completionEvidenceReference) {
    return invalid(
      "A completed service event requires completion evidence; accepted, scheduled, or requested is not completion",
    );
  }
  const serviceWindowRecord =
    record.serviceWindow === null
      ? null
      : requireObject(record.serviceWindow, "serviceEvent.serviceWindow");
  const serviceWindow = serviceWindowRecord
    ? normalizeServiceWindow(serviceWindowRecord, "serviceEvent.serviceWindow")
    : null;
  return {
    eventKey: requireOperationsText(
      record.eventKey,
      "serviceEvent.eventKey",
      500,
    ),
    householdId: requireOperationsText(
      record.householdId,
      "serviceEvent.householdId",
      300,
    ),
    subjectKey: requireOperationsText(
      record.subjectKey,
      "serviceEvent.subjectKey",
      300,
    ),
    serviceKind: requireOperationsText(
      record.serviceKind,
      "serviceEvent.serviceKind",
      300,
    ),
    vendorEntityId: optionalOperationsText(
      record.vendorEntityId,
      "serviceEvent.vendorEntityId",
      300,
    ),
    eventKind,
    serviceWindow,
    relatedCalendarEventId: optionalOperationsText(
      record.relatedCalendarEventId,
      "serviceEvent.relatedCalendarEventId",
      500,
    ),
    approvalReference,
    providerReceiptReference,
    completionEvidenceReference,
    provenance: normalizeProvenance(
      record.provenance,
      "serviceEvent.provenance",
    ),
    visibility: normalizeVisibility(
      record.visibility,
      "serviceEvent.visibility",
    ),
  };
}

export function normalizeServiceEvent(value: unknown): HouseholdServiceEvent {
  const record = requireObject(value, "serviceEvent");
  const input = normalizeServiceEventInput(record);
  const eventId = requireOperationsText(
    record.eventId,
    "serviceEvent.eventId",
    300,
  );
  const contentSha256 = requireOperationsText(
    record.contentSha256,
    "serviceEvent.contentSha256",
    64,
  );
  if (contentSha256 !== contentSha(input)) {
    return invalid("Household service event content hash is invalid", {
      eventId,
    });
  }
  return {
    ...input,
    eventId,
    contentSha256,
    createdAt: requireOperationsTimestamp(
      record.createdAt,
      "serviceEvent.createdAt",
    ),
  };
}

export function normalizeResponsibilitySignalInput(
  value: unknown,
): ResponsibilitySignalInput {
  const record = requireObject(value, "responsibilitySignal");
  return {
    signalKey: requireOperationsText(
      record.signalKey,
      "responsibilitySignal.signalKey",
      500,
    ),
    householdId: requireOperationsText(
      record.householdId,
      "responsibilitySignal.householdId",
      300,
    ),
    assignmentRecordId: requireOperationsText(
      record.assignmentRecordId,
      "responsibilitySignal.assignmentRecordId",
      300,
    ),
    assignmentRevision: requireOperationsInteger(
      record.assignmentRevision,
      "responsibilitySignal.assignmentRevision",
      1,
    ),
    phase: enumValue(
      record.phase,
      "responsibilitySignal.phase",
      HOUSEHOLD_RESPONSIBILITY_PHASES,
    ),
    ownerEntityId: requireOperationsText(
      record.ownerEntityId,
      "responsibilitySignal.ownerEntityId",
      300,
    ),
    signalKind: enumValue(
      record.signalKind,
      "responsibilitySignal.signalKind",
      HOUSEHOLD_RESPONSIBILITY_SIGNAL_KINDS,
    ),
    relatedTaskId: optionalOperationsText(
      record.relatedTaskId,
      "responsibilitySignal.relatedTaskId",
      500,
    ),
    provenance: normalizeProvenance(
      record.provenance,
      "responsibilitySignal.provenance",
    ),
  };
}

export function normalizeResponsibilitySignal(
  value: unknown,
): ResponsibilitySignal {
  const record = requireObject(value, "responsibilitySignal");
  const input = normalizeResponsibilitySignalInput(record);
  const signalId = requireOperationsText(
    record.signalId,
    "responsibilitySignal.signalId",
    300,
  );
  const contentSha256 = requireOperationsText(
    record.contentSha256,
    "responsibilitySignal.contentSha256",
    64,
  );
  if (contentSha256 !== contentSha(input)) {
    return invalid("Responsibility signal content hash is invalid", {
      signalId,
    });
  }
  return {
    ...input,
    signalId,
    contentSha256,
    createdAt: requireOperationsTimestamp(
      record.createdAt,
      "responsibilitySignal.createdAt",
    ),
  };
}

export function normalizeResponsibilityReviewProposal(
  value: unknown,
): ResponsibilityReviewProposal {
  const record = requireObject(value, "responsibilityReview");
  const ownerChanges = requireArray(
    record.ownerChanges,
    "responsibilityReview.ownerChanges",
  );
  if (ownerChanges.length !== 0) {
    return invalid(
      "A non-use review may propose renegotiation but may not silently change responsibility owners",
    );
  }
  const state = enumValue(record.state, "responsibilityReview.state", [
    "proposed",
  ] as const);
  return {
    reviewId: requireOperationsText(
      record.reviewId,
      "responsibilityReview.reviewId",
      300,
    ),
    householdId: requireOperationsText(
      record.householdId,
      "responsibilityReview.householdId",
      300,
    ),
    assignmentRecordId: requireOperationsText(
      record.assignmentRecordId,
      "responsibilityReview.assignmentRecordId",
      300,
    ),
    assignmentRevision: requireOperationsInteger(
      record.assignmentRevision,
      "responsibilityReview.assignmentRevision",
      1,
    ),
    snapshotSha256: requireOperationsText(
      record.snapshotSha256,
      "responsibilityReview.snapshotSha256",
      64,
    ),
    trigger: enumValue(record.trigger, "responsibilityReview.trigger", [
      "repeated_dismissal",
      "repeated_overdue",
      "dismissal_and_overdue",
    ] as const),
    currentOwners: normalizeResponsibilityOwners(record.currentOwners),
    ownerChanges: [],
    affectedEntityIds: stringArray(
      record.affectedEntityIds,
      "responsibilityReview.affectedEntityIds",
    ),
    requiredApproverEntityIds: stringArray(
      record.requiredApproverEntityIds,
      "responsibilityReview.requiredApproverEntityIds",
    ),
    proposedMode: enumValue(
      record.proposedMode,
      "responsibilityReview.proposedMode",
      [
        "private_renegotiation",
        "household_conversation",
        "request_acknowledgement",
      ] as const,
    ),
    state,
    createdAt: requireOperationsTimestamp(
      record.createdAt,
      "responsibilityReview.createdAt",
    ),
  };
}

function normalizeBriefItem(
  value: unknown,
  index: number,
): HouseholdWeeklyBriefItem {
  const field = `weeklyBrief.items[${index}]`;
  const record = requireObject(value, field);
  const action = requireObject(
    record.proposedAction,
    `${field}.proposedAction`,
  );
  const vendor =
    record.vendorContext === null
      ? null
      : requireObject(record.vendorContext, `${field}.vendorContext`);
  const window =
    record.dueWindow === null
      ? null
      : normalizeServiceWindow(record.dueWindow, `${field}.dueWindow`);
  const countsAsCoverage =
    record.countsAsCoverage === null
      ? null
      : requireBoolean(record.countsAsCoverage, `${field}.countsAsCoverage`);
  const calendarCheck =
    record.calendarCheck === null
      ? null
      : requireObject(record.calendarCheck, `${field}.calendarCheck`);
  return {
    itemId: requireOperationsText(record.itemId, `${field}.itemId`, 300),
    kind: enumValue(record.kind, `${field}.kind`, [
      "maintenance_due",
      "opportunity",
      "item_replacement",
      "responsibility_review",
    ] as const),
    title: requireOperationsText(record.title, `${field}.title`, 500),
    subjectKey: requireOperationsText(
      record.subjectKey,
      `${field}.subjectKey`,
      300,
    ),
    state: requireOperationsText(record.state, `${field}.state`, 200),
    dueWindow: window,
    responsibleEntityIds: stringArray(
      record.responsibleEntityIds,
      `${field}.responsibleEntityIds`,
      { allowEmpty: true },
    ),
    sourceRefs: stringArray(record.sourceRefs, `${field}.sourceRefs`, {
      allowEmpty: true,
    }),
    uncertainty: enumValue(record.uncertainty, `${field}.uncertainty`, [
      "none",
      "needs_information",
      "ambiguous",
    ] as const),
    visibility: normalizeVisibility(record.visibility, `${field}.visibility`),
    proposedAction: {
      effect: enumValue(action.effect, `${field}.proposedAction.effect`, [
        "read_only",
        "verify",
        "external_outreach_draft",
        "registration_draft",
        "purchase_draft",
        "renegotiation_proposal",
      ] as const),
      approvalRequirement: enumValue(
        action.approvalRequirement,
        `${field}.proposedAction.approvalRequirement`,
        ["none", "owner_approval", "multi_party_approval"] as const,
      ),
      idempotencyKey: optionalOperationsText(
        action.idempotencyKey,
        `${field}.proposedAction.idempotencyKey`,
        500,
      ),
    },
    vendorContext: vendor
      ? {
          vendorEntityId: requireOperationsText(
            vendor.vendorEntityId,
            `${field}.vendorContext.vendorEntityId`,
            300,
          ),
          contactRouteRefs: stringArray(
            vendor.contactRouteRefs,
            `${field}.vendorContext.contactRouteRefs`,
          ),
          accessWindows: requireArray(
            vendor.accessWindows,
            `${field}.vendorContext.accessWindows`,
          ).map((entry, vendorIndex) =>
            normalizeAccessWindow(
              entry,
              `${field}.vendorContext.accessWindows[${vendorIndex}]`,
            ),
          ),
        }
      : null,
    countsAsCoverage,
    calendarCheck: calendarCheck
      ? {
          state: enumValue(
            calendarCheck.state,
            `${field}.calendarCheck.state`,
            ["required", "available", "conflicted", "unknown"] as const,
          ),
          checkedAt: optionalOperationsText(
            calendarCheck.checkedAt,
            `${field}.calendarCheck.checkedAt`,
            100,
          ),
          sourceRefs: stringArray(
            calendarCheck.sourceRefs,
            `${field}.calendarCheck.sourceRefs`,
            { allowEmpty: true },
          ),
          conflictRefs: stringArray(
            calendarCheck.conflictRefs,
            `${field}.calendarCheck.conflictRefs`,
            { allowEmpty: true },
          ),
        }
      : null,
  };
}

function normalizeBriefQuestion(
  value: unknown,
  index: number,
): HouseholdWeeklyBriefQuestion {
  const field = `weeklyBrief.questions[${index}]`;
  const record = requireObject(value, field);
  return {
    questionId: requireOperationsText(
      record.questionId,
      `${field}.questionId`,
      300,
    ),
    prompt: requireOperationsText(record.prompt, `${field}.prompt`, 1_000),
    sourceRefs: stringArray(record.sourceRefs, `${field}.sourceRefs`, {
      allowEmpty: true,
    }),
    visibility: normalizeVisibility(record.visibility, `${field}.visibility`),
  };
}

export function normalizeWeeklyBrief(value: unknown): HouseholdWeeklyBrief {
  const record = requireObject(value, "weeklyBrief");
  const items = requireArray(record.items, "weeklyBrief.items").map(
    normalizeBriefItem,
  );
  const questions = requireArray(record.questions, "weeklyBrief.questions").map(
    normalizeBriefQuestion,
  );
  if (questions.length > 3) {
    return invalid("A household weekly brief may ask at most three questions");
  }
  return {
    briefId: requireOperationsText(record.briefId, "weeklyBrief.briefId", 300),
    householdId: requireOperationsText(
      record.householdId,
      "weeklyBrief.householdId",
      300,
    ),
    window: normalizeServiceWindow(record.window, "weeklyBrief.window"),
    generatedAt: requireOperationsTimestamp(
      record.generatedAt,
      "weeklyBrief.generatedAt",
    ),
    snapshotSha256: requireOperationsText(
      record.snapshotSha256,
      "weeklyBrief.snapshotSha256",
      64,
    ),
    items,
    questions,
    createdAt: requireOperationsTimestamp(
      record.createdAt,
      "weeklyBrief.createdAt",
    ),
  };
}

export function normalizeServiceWindow(
  value: unknown,
  field = "window",
): HouseholdServiceWindow {
  const record = requireObject(value, field);
  const startsAt = requireOperationsTimestamp(
    record.startsAt,
    `${field}.startsAt`,
  );
  const endsAt = requireOperationsTimestamp(record.endsAt, `${field}.endsAt`);
  if (Date.parse(startsAt) >= Date.parse(endsAt)) {
    return invalid(`${field}.endsAt must be after startsAt`, { field });
  }
  return { startsAt, endsAt };
}

export function normalizeCalendarCheck(
  value: unknown,
  field = "calendarCheck",
): HouseholdCalendarCheck {
  const record = requireObject(value, field);
  return {
    subjectKey: requireOperationsText(
      record.subjectKey,
      `${field}.subjectKey`,
      300,
    ),
    window: normalizeServiceWindow(record.window, `${field}.window`),
    state: enumValue(record.state, `${field}.state`, [
      "available",
      "conflicted",
      "unknown",
    ] as const),
    checkedAt: requireOperationsTimestamp(
      record.checkedAt,
      `${field}.checkedAt`,
    ),
    sourceRefs: stringArray(record.sourceRefs, `${field}.sourceRefs`, {
      allowEmpty: true,
    }),
    conflictRefs: stringArray(record.conflictRefs, `${field}.conflictRefs`, {
      allowEmpty: true,
    }),
  };
}

export function operationRevisionSha256(
  definition: HouseholdOperationDefinition,
  revision: number,
): string {
  return contentSha({ definition, revision });
}

export function operationIdentitySha256(
  definition: HouseholdOperationDefinition,
): string {
  const shared = {
    kind: definition.kind,
    recordId: definition.recordId,
    householdId: definition.householdId,
  };
  if (definition.kind === "vendor_profile") {
    return contentSha({
      ...shared,
      vendorEntityId: definition.vendorEntityId,
    });
  }
  if (definition.kind === "almanac_entry") {
    return contentSha({ ...shared, subjectKey: definition.subjectKey });
  }
  if (definition.kind === "opportunity") {
    return contentSha({
      ...shared,
      subjectKey: definition.subjectKey,
      almanacEntryRecordId: definition.almanacEntryRecordId,
    });
  }
  if (definition.kind === "item_threshold") {
    return contentSha({
      ...shared,
      childEntityId: definition.childEntityId,
      itemCategory: definition.itemCategory,
    });
  }
  return contentSha({ ...shared, subjectKey: definition.subjectKey });
}

export function contentSha(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function stableOperationsId(prefix: string, value: unknown): string {
  return `${prefix}-${contentSha(value).slice(0, 40)}`;
}

export function householdAuthorityRank(
  authority: HouseholdAuthorityClass,
): number {
  if (authority === "user_confirmed") return 60;
  if (authority === "provider_confirmed") return 55;
  if (authority === "vendor_provided") return 50;
  if (authority === "document_extracted") return 40;
  if (authority === "sensor_observed") return 30;
  return 10;
}
