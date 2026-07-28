/**
 * Structural contracts for household caregiver and transport capacity.
 *
 * The model deliberately records explicit authorization, source freshness,
 * compatibility, handoff windows, and resource assignments. It never infers
 * that a person may supervise a child, that a restraint fits, or that approval
 * reserves a resource merely from conversational text.
 */
import { createHash } from "node:crypto";
import { ElizaError, stableStringify } from "@elizaos/core";

export const RESOURCE_CAPACITY_POLICY_VERSION =
  "household-resource-capacity.v1" as const;
export const RESOURCE_CAPACITY_REVIEW_WORKFLOW_ID =
  "household.resource-capacity.proposal.review" as const;
const ABSOLUTE_CAPACITY_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i;

export const HOUSEHOLD_RESOURCE_KINDS = [
  "caregiver",
  "vehicle",
  "car_seat",
] as const;
export type HouseholdResourceKind = (typeof HOUSEHOLD_RESOURCE_KINDS)[number];

export const RESOURCE_AUTHORIZATION_STATES = [
  "authorized",
  "pending",
  "revoked",
  "expired",
] as const;
export type ResourceAuthorizationState =
  (typeof RESOURCE_AUTHORIZATION_STATES)[number];

export const RESOURCE_AVAILABILITY_STATES = [
  "available",
  "unavailable",
  "unknown",
] as const;
export type ResourceAvailabilityState =
  (typeof RESOURCE_AVAILABILITY_STATES)[number];

export const CAR_SEAT_CLASSES = [
  "rear_facing",
  "forward_facing",
  "high_back_booster",
  "backless_booster",
  "adaptive_harness",
] as const;
export type CarSeatClass = (typeof CAR_SEAT_CLASSES)[number];

export const CAR_SEAT_INSTALLATION_STATES = [
  "confirmed",
  "unconfirmed",
  "incompatible",
] as const;
export type CarSeatInstallationState =
  (typeof CAR_SEAT_INSTALLATION_STATES)[number];

export interface ResourceAuthorization {
  readonly state: ResourceAuthorizationState;
  readonly validFrom: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly authorizedByEntityIds: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface ResourceAvailabilityWindow {
  readonly windowId: string;
  readonly state: ResourceAvailabilityState;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly sourceRef: string;
  readonly observedAt: string;
  readonly expiresAt: string | null;
}

interface HouseholdResourceDefinitionBase {
  readonly schemaVersion: typeof RESOURCE_CAPACITY_POLICY_VERSION;
  readonly resourceId: string;
  readonly householdId: string;
  readonly kind: HouseholdResourceKind;
  readonly label: string;
  readonly active: boolean;
  readonly capabilityIds: readonly string[];
  readonly authorization: ResourceAuthorization;
  readonly availability: readonly ResourceAvailabilityWindow[];
}

export interface CaregiverResourceDefinition
  extends HouseholdResourceDefinitionBase {
  readonly kind: "caregiver";
  readonly caregiverEntityId: string;
  readonly authorizedChildEntityIds: readonly string[];
  readonly maximumConcurrentChildren: number;
  readonly trainingCapabilityIds: readonly string[];
}

export interface VehicleResourceDefinition
  extends HouseholdResourceDefinitionBase {
  readonly kind: "vehicle";
  readonly assetRef: string;
  readonly passengerCapacity: number;
  readonly authorizedOperatorEntityIds: readonly string[];
  readonly supportedCarSeatResourceIds: readonly string[];
  readonly accessibilityCapabilityIds: readonly string[];
}

export interface CarSeatResourceDefinition
  extends HouseholdResourceDefinitionBase {
  readonly kind: "car_seat";
  readonly seatClass: CarSeatClass;
  readonly compatibleChildEntityIds: readonly string[];
  readonly compatibleVehicleResourceIds: readonly string[];
  readonly installationState: CarSeatInstallationState;
  readonly installationEvidenceRef: string | null;
  readonly installationObservedAt: string | null;
  readonly installationExpiresAt: string | null;
}

export type HouseholdResourceDefinition =
  | CaregiverResourceDefinition
  | VehicleResourceDefinition
  | CarSeatResourceDefinition;

export type HouseholdResourceRevision = HouseholdResourceDefinition & {
  readonly revision: number;
  readonly contentSha256: string;
  readonly createdAt: string;
};

export interface CapacityHandoffWindow {
  readonly handoffId: string;
  readonly kind: "pickup" | "dropoff";
  readonly startsAt: string;
  readonly endsAt: string;
  readonly locationRef: string;
  readonly requiredPrincipalEntityIds: readonly string[];
}

export interface CapacityCarSeatRequirement {
  readonly childEntityId: string;
  readonly seatClass: CarSeatClass;
}

export interface CapacityNeedRequirements {
  readonly caregiverCount: number;
  readonly caregiverCapabilityIds: readonly string[];
  readonly vehicleRequired: boolean;
  readonly passengerCount: number;
  readonly carSeats: readonly CapacityCarSeatRequirement[];
  readonly accessibilityCapabilityIds: readonly string[];
}

export interface CapacityNeed {
  readonly needId: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly preparationMinutes: number;
  readonly recoveryMinutes: number;
  readonly originLocationRef: string;
  readonly destinationLocationRef: string;
  readonly childEntityIds: readonly string[];
  readonly requirements: CapacityNeedRequirements;
  readonly handoffs: readonly CapacityHandoffWindow[];
  readonly sourceRefs: readonly string[];
}

export interface ResourceCapacityPlan {
  readonly householdId: string;
  readonly title: string;
  readonly childEntityIds: readonly string[];
  readonly needs: readonly CapacityNeed[];
}

export const RESOURCE_ASSIGNMENT_ROLES = [
  "caregiver_primary",
  "caregiver_backup",
  "vehicle",
  "car_seat",
] as const;
export type ResourceAssignmentRole = (typeof RESOURCE_ASSIGNMENT_ROLES)[number];

export interface ResourceCapacityAssignment {
  readonly needId: string;
  readonly resourceId: string;
  readonly role: ResourceAssignmentRole;
}

export interface ResourceTransitionEvidence {
  readonly resourceId: string;
  readonly fromNeedId: string;
  readonly toNeedId: string;
  readonly minimumMinutes: number;
  readonly sourceRef: string;
  readonly observedAt: string;
  readonly expiresAt: string | null;
}

export interface ResourceCapacityEvaluationInput {
  readonly plan: ResourceCapacityPlan;
  readonly assignments: readonly ResourceCapacityAssignment[];
  readonly transitions: readonly ResourceTransitionEvidence[];
  readonly maximumSourceAgeMinutes: number;
}

export const RESOURCE_CAPACITY_CONFLICT_KINDS = [
  "resource_not_found",
  "resource_inactive",
  "resource_kind_mismatch",
  "authorization_pending",
  "authorization_revoked",
  "authorization_expired",
  "child_not_authorized",
  "availability_unknown",
  "outside_availability",
  "contradictory_availability",
  "source_stale",
  "caregiver_shortfall",
  "caregiver_capacity_exceeded",
  "caregiver_capability_missing",
  "vehicle_missing",
  "vehicle_capacity_exceeded",
  "vehicle_operator_unauthorized",
  "car_seat_missing",
  "car_seat_incompatible",
  "car_seat_installation_unconfirmed",
  "accessibility_capability_missing",
  "handoff_window_missed",
  "handoff_principal_missing",
  "direct_overlap",
  "transition_evidence_missing",
  "contradictory_transition_evidence",
  "transition_time_insufficient",
  "pending_proposal_reservation",
  "duplicate_assignment",
] as const;
export type ResourceCapacityConflictKind =
  (typeof RESOURCE_CAPACITY_CONFLICT_KINDS)[number];

export interface ResourceCapacityConflict {
  readonly conflictId: string;
  readonly kind: ResourceCapacityConflictKind;
  readonly needIds: readonly string[];
  readonly resourceIds: readonly string[];
  readonly subjectEntityIds: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly facts: readonly string[];
}

export interface ResourceSnapshotRef {
  readonly resourceId: string;
  readonly revision: number;
  readonly contentSha256: string;
}

export interface ResourceCapacityEvaluation {
  readonly feasible: boolean;
  readonly evaluatedAt: string;
  readonly inputSha256: string;
  readonly resourceSnapshots: readonly ResourceSnapshotRef[];
  readonly conflicts: readonly ResourceCapacityConflict[];
  readonly explanationFacts: readonly string[];
  readonly noReservationCreated: true;
}

export interface PendingResourceReservation {
  readonly proposalId: string;
  readonly resourceId: string;
  readonly needId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly expiresAt: string;
}

export interface ResourceCapacityProposal {
  readonly proposalId: string;
  readonly agentId: string;
  readonly version: 1;
  readonly householdId: string;
  readonly createdByEntityId: string;
  readonly idempotencyKey: string;
  readonly inputSha256: string;
  readonly contentSha256: string;
  readonly plan: ResourceCapacityPlan;
  readonly assignments: readonly ResourceCapacityAssignment[];
  readonly transitions: readonly ResourceTransitionEvidence[];
  readonly maximumSourceAgeMinutes: number;
  readonly evaluation: ResourceCapacityEvaluation;
  readonly requiredApproverEntityIds: readonly string[];
  readonly status: "blocked" | "pending_review";
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly noExternalEffect: true;
}

export interface ResourceCapacityApprovalLink {
  readonly proposalId: string;
  readonly proposalVersion: 1;
  readonly partyEntityId: string;
  readonly approvalRequestId: string;
  readonly createdAt: string;
}

export type ResourceCapacityReviewState =
  | "blocked"
  | "pending_review"
  | "review_complete"
  | "declined"
  | "cancelled"
  | "invalidated"
  | "expired";

export type ResourceCapacityTerminalState =
  | "declined"
  | "cancelled"
  | "expired";

export interface ResourceCapacityProposalTerminal {
  readonly proposalId: string;
  readonly state: ResourceCapacityTerminalState;
  readonly reason: string;
  readonly terminalAt: string;
}

export interface ResourceCapacityReviewProjection {
  readonly proposal: ResourceCapacityProposal;
  readonly effectiveState: ResourceCapacityReviewState;
  readonly approvals: readonly {
    readonly partyEntityId: string;
    readonly approvalRequestId: string;
    readonly state:
      | "pending"
      | "approved"
      | "executing"
      | "done"
      | "rejected"
      | "expired";
  }[];
  readonly reviewTaskId: string | null;
  readonly invalidatedResourceIds: readonly string[];
  readonly invalidationConflicts: readonly ResourceCapacityConflict[];
  readonly noReservationCreated: true;
  readonly noCalendarMutationCreated: true;
  readonly noMessageSent: true;
}

export type ResourceCapacityErrorCode =
  | "RESOURCE_CAPACITY_ACCESS_DENIED"
  | "RESOURCE_CAPACITY_CONFLICT"
  | "RESOURCE_CAPACITY_ENTITY_NOT_FOUND"
  | "RESOURCE_CAPACITY_INVALID_CONTRACT"
  | "RESOURCE_CAPACITY_NOT_FOUND"
  | "RESOURCE_CAPACITY_PERSISTED_DATA_INVALID";

export class ResourceCapacityError extends ElizaError {
  override readonly name = "ResourceCapacityError";

  constructor(
    message: string,
    code: ResourceCapacityErrorCode,
    context?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, {
      code,
      context,
      cause,
      severity:
        code === "RESOURCE_CAPACITY_INVALID_CONTRACT" ||
        code === "RESOURCE_CAPACITY_PERSISTED_DATA_INVALID"
          ? "fatal"
          : "ephemeral",
    });
  }
}

function invalid(message: string, context?: Record<string, unknown>): never {
  throw new ResourceCapacityError(
    message,
    "RESOURCE_CAPACITY_INVALID_CONTRACT",
    context,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function resourceCapacitySha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function requireCapacityText(
  value: unknown,
  field: string,
  maximumLength = 500,
): string {
  if (typeof value !== "string") {
    return invalid(`${field} must be a string`, { field });
  }
  const normalized = value.trim();
  const hasControl = Array.from(normalized).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    hasControl
  ) {
    return invalid(`${field} is empty, too long, or contains control text`, {
      field,
      maximumLength,
    });
  }
  return normalized;
}

export function requireCapacityInteger(
  value: unknown,
  field: string,
  minimum = 0,
  maximum = 100_000,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return invalid(`${field} must be an integer in range`, {
      field,
      minimum,
      maximum,
    });
  }
  return value;
}

export function requireCapacityTimestamp(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || !ABSOLUTE_CAPACITY_TIMESTAMP.test(value)) {
    return invalid(`${field} must include Z or an explicit UTC offset`, {
      field,
    });
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    return invalid(`${field} must be an ISO-8601 timestamp`, { field, value });
  }
  return new Date(milliseconds).toISOString();
}

export function uniqueCapacityIds(
  value: unknown,
  field: string,
  options?: { allowEmpty?: boolean },
): string[] {
  if (!Array.isArray(value)) {
    return invalid(`${field} must be an array`, { field });
  }
  const normalized = value.map((entry, index) =>
    requireCapacityText(entry, `${field}[${index}]`, 500),
  );
  const unique = Array.from(new Set(normalized)).sort();
  if (!options?.allowEmpty && unique.length === 0) {
    return invalid(`${field} must not be empty`, { field });
  }
  return unique;
}

function enumValue<T extends string>(
  value: unknown,
  field: string,
  values: readonly T[],
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    return invalid(`${field} is unsupported`, { field, value });
  }
  return value as T;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requireCapacityTimestamp(value, field);
}

function normalizeAuthorization(
  value: unknown,
  field: string,
): ResourceAuthorization {
  if (!isRecord(value)) {
    return invalid(`${field} must be an object`, { field });
  }
  const state = enumValue(
    value.state,
    `${field}.state`,
    RESOURCE_AUTHORIZATION_STATES,
  );
  const validFrom = requireCapacityTimestamp(
    value.validFrom,
    `${field}.validFrom`,
  );
  const expiresAt = nullableTimestamp(value.expiresAt, `${field}.expiresAt`);
  const revokedAt = nullableTimestamp(value.revokedAt, `${field}.revokedAt`);
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(validFrom)) {
    return invalid(`${field}.expiresAt must follow validFrom`, { field });
  }
  if (state === "revoked" && revokedAt === null) {
    return invalid(`${field}.revokedAt is required for revoked authority`, {
      field,
    });
  }
  if (state !== "revoked" && revokedAt !== null) {
    return invalid(`${field}.revokedAt is only valid for revoked authority`, {
      field,
      state,
    });
  }
  if (state === "expired" && expiresAt === null) {
    return invalid(`${field}.expiresAt is required for expired authority`, {
      field,
    });
  }
  return {
    state,
    validFrom,
    expiresAt,
    revokedAt,
    authorizedByEntityIds: uniqueCapacityIds(
      value.authorizedByEntityIds,
      `${field}.authorizedByEntityIds`,
    ),
    evidenceRefs: uniqueCapacityIds(
      value.evidenceRefs,
      `${field}.evidenceRefs`,
    ),
  };
}

function normalizeAvailabilityWindow(
  value: unknown,
  field: string,
): ResourceAvailabilityWindow {
  if (!isRecord(value)) {
    return invalid(`${field} must be an object`, { field });
  }
  const startsAt = requireCapacityTimestamp(
    value.startsAt,
    `${field}.startsAt`,
  );
  const endsAt = requireCapacityTimestamp(value.endsAt, `${field}.endsAt`);
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    return invalid(`${field}.endsAt must follow startsAt`, { field });
  }
  const observedAt = requireCapacityTimestamp(
    value.observedAt,
    `${field}.observedAt`,
  );
  const expiresAt = nullableTimestamp(value.expiresAt, `${field}.expiresAt`);
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(observedAt)) {
    return invalid(`${field}.expiresAt must follow observedAt`, { field });
  }
  return {
    windowId: requireCapacityText(value.windowId, `${field}.windowId`, 300),
    state: enumValue(
      value.state,
      `${field}.state`,
      RESOURCE_AVAILABILITY_STATES,
    ),
    startsAt,
    endsAt,
    sourceRef: requireCapacityText(value.sourceRef, `${field}.sourceRef`, 500),
    observedAt,
    expiresAt,
  };
}

function normalizeCommonResource(
  value: Record<string, unknown>,
): HouseholdResourceDefinitionBase {
  if (value.schemaVersion !== RESOURCE_CAPACITY_POLICY_VERSION) {
    return invalid("resource.schemaVersion is unsupported", {
      schemaVersion: value.schemaVersion,
    });
  }
  if (typeof value.active !== "boolean") {
    return invalid("resource.active must be a boolean");
  }
  if (!Array.isArray(value.availability) || value.availability.length === 0) {
    return invalid("resource.availability must contain source evidence");
  }
  return {
    schemaVersion: RESOURCE_CAPACITY_POLICY_VERSION,
    resourceId: requireCapacityText(value.resourceId, "resource.resourceId"),
    householdId: requireCapacityText(value.householdId, "resource.householdId"),
    kind: enumValue(value.kind, "resource.kind", HOUSEHOLD_RESOURCE_KINDS),
    label: requireCapacityText(value.label, "resource.label", 300),
    active: value.active,
    capabilityIds: uniqueCapacityIds(
      value.capabilityIds,
      "resource.capabilityIds",
      { allowEmpty: true },
    ),
    authorization: normalizeAuthorization(
      value.authorization,
      "resource.authorization",
    ),
    availability: value.availability.map((window, index) =>
      normalizeAvailabilityWindow(window, `resource.availability[${index}]`),
    ),
  };
}

export function normalizeResourceDefinition(
  value: unknown,
): HouseholdResourceDefinition {
  if (!isRecord(value)) {
    return invalid("resource must be an object");
  }
  const common = normalizeCommonResource(value);
  if (common.kind === "caregiver") {
    return {
      ...common,
      kind: "caregiver",
      caregiverEntityId: requireCapacityText(
        value.caregiverEntityId,
        "resource.caregiverEntityId",
      ),
      authorizedChildEntityIds: uniqueCapacityIds(
        value.authorizedChildEntityIds,
        "resource.authorizedChildEntityIds",
      ),
      maximumConcurrentChildren: requireCapacityInteger(
        value.maximumConcurrentChildren,
        "resource.maximumConcurrentChildren",
        1,
        100,
      ),
      trainingCapabilityIds: uniqueCapacityIds(
        value.trainingCapabilityIds,
        "resource.trainingCapabilityIds",
        { allowEmpty: true },
      ),
    };
  }
  if (common.kind === "vehicle") {
    return {
      ...common,
      kind: "vehicle",
      assetRef: requireCapacityText(value.assetRef, "resource.assetRef"),
      passengerCapacity: requireCapacityInteger(
        value.passengerCapacity,
        "resource.passengerCapacity",
        1,
        100,
      ),
      authorizedOperatorEntityIds: uniqueCapacityIds(
        value.authorizedOperatorEntityIds,
        "resource.authorizedOperatorEntityIds",
      ),
      supportedCarSeatResourceIds: uniqueCapacityIds(
        value.supportedCarSeatResourceIds,
        "resource.supportedCarSeatResourceIds",
        { allowEmpty: true },
      ),
      accessibilityCapabilityIds: uniqueCapacityIds(
        value.accessibilityCapabilityIds,
        "resource.accessibilityCapabilityIds",
        { allowEmpty: true },
      ),
    };
  }
  const installationState = enumValue(
    value.installationState,
    "resource.installationState",
    CAR_SEAT_INSTALLATION_STATES,
  );
  const installationEvidenceRef =
    value.installationEvidenceRef === null
      ? null
      : requireCapacityText(
          value.installationEvidenceRef,
          "resource.installationEvidenceRef",
          500,
        );
  const installationObservedAt =
    value.installationObservedAt === null
      ? null
      : requireCapacityTimestamp(
          value.installationObservedAt,
          "resource.installationObservedAt",
        );
  const installationExpiresAt =
    value.installationExpiresAt === null
      ? null
      : requireCapacityTimestamp(
          value.installationExpiresAt,
          "resource.installationExpiresAt",
        );
  if (installationState === "confirmed" && installationEvidenceRef === null) {
    return invalid(
      "resource.installationEvidenceRef is required for a confirmed installation",
    );
  }
  if (installationState === "confirmed" && installationObservedAt === null) {
    return invalid(
      "resource.installationObservedAt is required for a confirmed installation",
    );
  }
  if (
    installationExpiresAt !== null &&
    (installationObservedAt === null ||
      Date.parse(installationExpiresAt) <= Date.parse(installationObservedAt))
  ) {
    return invalid(
      "resource.installationExpiresAt must follow installationObservedAt",
    );
  }
  return {
    ...common,
    kind: "car_seat",
    seatClass: enumValue(
      value.seatClass,
      "resource.seatClass",
      CAR_SEAT_CLASSES,
    ),
    compatibleChildEntityIds: uniqueCapacityIds(
      value.compatibleChildEntityIds,
      "resource.compatibleChildEntityIds",
    ),
    compatibleVehicleResourceIds: uniqueCapacityIds(
      value.compatibleVehicleResourceIds,
      "resource.compatibleVehicleResourceIds",
    ),
    installationState,
    installationEvidenceRef,
    installationObservedAt,
    installationExpiresAt,
  };
}

function normalizeRequirements(
  value: unknown,
  field: string,
): CapacityNeedRequirements {
  if (!isRecord(value)) {
    return invalid(`${field} must be an object`, { field });
  }
  if (typeof value.vehicleRequired !== "boolean") {
    return invalid(`${field}.vehicleRequired must be a boolean`, { field });
  }
  if (!Array.isArray(value.carSeats)) {
    return invalid(`${field}.carSeats must be an array`, { field });
  }
  const carSeats = value.carSeats.map(
    (entry, index): CapacityCarSeatRequirement => {
      if (!isRecord(entry)) {
        return invalid(`${field}.carSeats[${index}] must be an object`);
      }
      return {
        childEntityId: requireCapacityText(
          entry.childEntityId,
          `${field}.carSeats[${index}].childEntityId`,
        ),
        seatClass: enumValue(
          entry.seatClass,
          `${field}.carSeats[${index}].seatClass`,
          CAR_SEAT_CLASSES,
        ),
      };
    },
  );
  const duplicateChild = carSeats.find(
    (seat, index) =>
      carSeats.findIndex(
        (candidate) => candidate.childEntityId === seat.childEntityId,
      ) !== index,
  );
  if (duplicateChild) {
    return invalid(`${field}.carSeats repeats a child`, {
      childEntityId: duplicateChild.childEntityId,
    });
  }
  const passengerCount = requireCapacityInteger(
    value.passengerCount,
    `${field}.passengerCount`,
    0,
    100,
  );
  if (!value.vehicleRequired && (passengerCount > 0 || carSeats.length > 0)) {
    return invalid(
      `${field}.vehicleRequired must be true when passengers or car seats are required`,
      { field },
    );
  }
  return {
    caregiverCount: requireCapacityInteger(
      value.caregiverCount,
      `${field}.caregiverCount`,
      0,
      20,
    ),
    caregiverCapabilityIds: uniqueCapacityIds(
      value.caregiverCapabilityIds,
      `${field}.caregiverCapabilityIds`,
      { allowEmpty: true },
    ),
    vehicleRequired: value.vehicleRequired,
    passengerCount,
    carSeats,
    accessibilityCapabilityIds: uniqueCapacityIds(
      value.accessibilityCapabilityIds,
      `${field}.accessibilityCapabilityIds`,
      { allowEmpty: true },
    ),
  };
}

function normalizeHandoff(
  value: unknown,
  field: string,
): CapacityHandoffWindow {
  if (!isRecord(value)) {
    return invalid(`${field} must be an object`, { field });
  }
  const startsAt = requireCapacityTimestamp(
    value.startsAt,
    `${field}.startsAt`,
  );
  const endsAt = requireCapacityTimestamp(value.endsAt, `${field}.endsAt`);
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    return invalid(`${field}.endsAt must follow startsAt`, { field });
  }
  return {
    handoffId: requireCapacityText(value.handoffId, `${field}.handoffId`),
    kind: enumValue(value.kind, `${field}.kind`, ["pickup", "dropoff"]),
    startsAt,
    endsAt,
    locationRef: requireCapacityText(value.locationRef, `${field}.locationRef`),
    requiredPrincipalEntityIds: uniqueCapacityIds(
      value.requiredPrincipalEntityIds,
      `${field}.requiredPrincipalEntityIds`,
      { allowEmpty: true },
    ),
  };
}

function normalizeNeed(value: unknown, field: string): CapacityNeed {
  if (!isRecord(value)) {
    return invalid(`${field} must be an object`, { field });
  }
  const startsAt = requireCapacityTimestamp(
    value.startsAt,
    `${field}.startsAt`,
  );
  const endsAt = requireCapacityTimestamp(value.endsAt, `${field}.endsAt`);
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    return invalid(`${field}.endsAt must follow startsAt`, { field });
  }
  if (!Array.isArray(value.handoffs)) {
    return invalid(`${field}.handoffs must be an array`, { field });
  }
  const childEntityIds = uniqueCapacityIds(
    value.childEntityIds,
    `${field}.childEntityIds`,
  );
  const requirements = normalizeRequirements(
    value.requirements,
    `${field}.requirements`,
  );
  const outsideNeed = requirements.carSeats.filter(
    (seat) => !childEntityIds.includes(seat.childEntityId),
  );
  if (outsideNeed.length > 0) {
    return invalid(`${field}.requirements.carSeats names an unrelated child`, {
      childEntityIds: outsideNeed.map((seat) => seat.childEntityId),
    });
  }
  return {
    needId: requireCapacityText(value.needId, `${field}.needId`),
    title: requireCapacityText(value.title, `${field}.title`, 500),
    startsAt,
    endsAt,
    preparationMinutes: requireCapacityInteger(
      value.preparationMinutes,
      `${field}.preparationMinutes`,
      0,
      24 * 60,
    ),
    recoveryMinutes: requireCapacityInteger(
      value.recoveryMinutes,
      `${field}.recoveryMinutes`,
      0,
      24 * 60,
    ),
    originLocationRef: requireCapacityText(
      value.originLocationRef,
      `${field}.originLocationRef`,
    ),
    destinationLocationRef: requireCapacityText(
      value.destinationLocationRef,
      `${field}.destinationLocationRef`,
    ),
    childEntityIds,
    requirements,
    handoffs: value.handoffs.map((handoff, index) =>
      normalizeHandoff(handoff, `${field}.handoffs[${index}]`),
    ),
    sourceRefs: uniqueCapacityIds(value.sourceRefs, `${field}.sourceRefs`),
  };
}

export function normalizeCapacityPlan(value: unknown): ResourceCapacityPlan {
  if (!isRecord(value)) {
    return invalid("plan must be an object");
  }
  if (!Array.isArray(value.needs) || value.needs.length === 0) {
    return invalid("plan.needs must not be empty");
  }
  const childEntityIds = uniqueCapacityIds(
    value.childEntityIds,
    "plan.childEntityIds",
  );
  const needs = value.needs.map((need, index) =>
    normalizeNeed(need, `plan.needs[${index}]`),
  );
  const needIds = needs.map((need) => need.needId);
  if (new Set(needIds).size !== needIds.length) {
    return invalid("plan.needs contains duplicate needId values");
  }
  const unrelated = needs.flatMap((need) =>
    need.childEntityIds.filter((child) => !childEntityIds.includes(child)),
  );
  if (unrelated.length > 0) {
    return invalid("plan.need names a child outside plan.childEntityIds", {
      childEntityIds: Array.from(new Set(unrelated)),
    });
  }
  return {
    householdId: requireCapacityText(value.householdId, "plan.householdId"),
    title: requireCapacityText(value.title, "plan.title", 500),
    childEntityIds,
    needs,
  };
}

export function capacityPlanEarliestOccupiedAt(
  plan: ResourceCapacityPlan,
): string {
  const earliest = Math.min(
    ...plan.needs.map(
      (need) => Date.parse(need.startsAt) - need.preparationMinutes * 60 * 1000,
    ),
  );
  return new Date(earliest).toISOString();
}

export function normalizeCapacityAssignments(
  value: unknown,
): ResourceCapacityAssignment[] {
  if (!Array.isArray(value)) {
    return invalid("assignments must be an array");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      return invalid(`assignments[${index}] must be an object`);
    }
    return {
      needId: requireCapacityText(entry.needId, `assignments[${index}].needId`),
      resourceId: requireCapacityText(
        entry.resourceId,
        `assignments[${index}].resourceId`,
      ),
      role: enumValue(
        entry.role,
        `assignments[${index}].role`,
        RESOURCE_ASSIGNMENT_ROLES,
      ),
    };
  });
}

export function normalizeTransitionEvidence(
  value: unknown,
): ResourceTransitionEvidence[] {
  if (!Array.isArray(value)) {
    return invalid("transitions must be an array");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      return invalid(`transitions[${index}] must be an object`);
    }
    const observedAt = requireCapacityTimestamp(
      entry.observedAt,
      `transitions[${index}].observedAt`,
    );
    const expiresAt = nullableTimestamp(
      entry.expiresAt,
      `transitions[${index}].expiresAt`,
    );
    if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(observedAt)) {
      return invalid(`transitions[${index}].expiresAt must follow observedAt`);
    }
    return {
      resourceId: requireCapacityText(
        entry.resourceId,
        `transitions[${index}].resourceId`,
      ),
      fromNeedId: requireCapacityText(
        entry.fromNeedId,
        `transitions[${index}].fromNeedId`,
      ),
      toNeedId: requireCapacityText(
        entry.toNeedId,
        `transitions[${index}].toNeedId`,
      ),
      minimumMinutes: requireCapacityInteger(
        entry.minimumMinutes,
        `transitions[${index}].minimumMinutes`,
        0,
        7 * 24 * 60,
      ),
      sourceRef: requireCapacityText(
        entry.sourceRef,
        `transitions[${index}].sourceRef`,
      ),
      observedAt,
      expiresAt,
    };
  });
}

export function normalizeCapacityEvaluationInput(
  value: unknown,
): ResourceCapacityEvaluationInput {
  if (!isRecord(value)) {
    return invalid("capacity evaluation input must be an object");
  }
  const plan = normalizeCapacityPlan(value.plan);
  const assignments = normalizeCapacityAssignments(value.assignments);
  const transitions = normalizeTransitionEvidence(value.transitions);
  const needIds = new Set(plan.needs.map((need) => need.needId));
  for (const assignment of assignments) {
    if (!needIds.has(assignment.needId)) {
      return invalid("assignment names an unknown need", {
        needId: assignment.needId,
      });
    }
  }
  for (const transition of transitions) {
    if (
      !needIds.has(transition.fromNeedId) ||
      !needIds.has(transition.toNeedId) ||
      transition.fromNeedId === transition.toNeedId
    ) {
      return invalid("transition must connect two different known needs", {
        fromNeedId: transition.fromNeedId,
        toNeedId: transition.toNeedId,
      });
    }
  }
  return {
    plan,
    assignments,
    transitions,
    maximumSourceAgeMinutes: requireCapacityInteger(
      value.maximumSourceAgeMinutes,
      "maximumSourceAgeMinutes",
      1,
      365 * 24 * 60,
    ),
  };
}

export function resourceIdentitySha256(
  value: Pick<
    HouseholdResourceDefinition,
    "resourceId" | "householdId" | "kind"
  >,
): string {
  return resourceCapacitySha256({
    resourceId: value.resourceId,
    householdId: value.householdId,
    kind: value.kind,
  });
}

export function resourceRevisionSha256(
  definition: HouseholdResourceDefinition,
  revision: number,
): string {
  return resourceCapacitySha256({ definition, revision });
}

export function normalizeResourceRevision(
  value: unknown,
): HouseholdResourceRevision {
  if (!isRecord(value)) {
    return invalid("resource revision must be an object");
  }
  const definition = normalizeResourceDefinition(value);
  const revision = requireCapacityInteger(
    value.revision,
    "resource.revision",
    1,
  );
  const createdAt = requireCapacityTimestamp(
    value.createdAt,
    "resource.createdAt",
  );
  const contentSha256 = requireCapacityText(
    value.contentSha256,
    "resource.contentSha256",
    64,
  );
  if (contentSha256 !== resourceRevisionSha256(definition, revision)) {
    return invalid("resource revision hash does not match its contents", {
      resourceId: definition.resourceId,
      revision,
    });
  }
  return { ...definition, revision, contentSha256, createdAt };
}

export function proposalInputSha256(
  value: ResourceCapacityEvaluationInput & {
    readonly requiredApproverEntityIds: readonly string[];
    readonly expiresAt: string;
  },
): string {
  return resourceCapacitySha256(value);
}

export function proposalContentSha256(
  value: Omit<ResourceCapacityProposal, "contentSha256">,
): string {
  return resourceCapacitySha256(value);
}

export function normalizeCapacityProposal(
  value: unknown,
): ResourceCapacityProposal {
  if (!isRecord(value)) {
    return invalid("resource-capacity proposal must be an object");
  }
  if (!isRecord(value.evaluation)) {
    return invalid("proposal.evaluation must be an object");
  }
  const input = normalizeCapacityEvaluationInput({
    plan: value.plan,
    assignments: value.assignments,
    transitions: value.transitions,
    maximumSourceAgeMinutes: value.maximumSourceAgeMinutes,
  });
  const resourceSnapshotsValue = value.evaluation.resourceSnapshots;
  const conflictsValue = value.evaluation.conflicts;
  const explanationFactsValue = value.evaluation.explanationFacts;
  if (
    !Array.isArray(resourceSnapshotsValue) ||
    !Array.isArray(conflictsValue) ||
    !Array.isArray(explanationFactsValue) ||
    typeof value.evaluation.feasible !== "boolean" ||
    value.evaluation.noReservationCreated !== true
  ) {
    return invalid("proposal.evaluation has an invalid structure");
  }
  const evaluation: ResourceCapacityEvaluation = {
    feasible: value.evaluation.feasible,
    evaluatedAt: requireCapacityTimestamp(
      value.evaluation.evaluatedAt,
      "proposal.evaluation.evaluatedAt",
    ),
    inputSha256: requireCapacityText(
      value.evaluation.inputSha256,
      "proposal.evaluation.inputSha256",
      64,
    ),
    resourceSnapshots: resourceSnapshotsValue.map((snapshot, index) => {
      if (!isRecord(snapshot)) {
        return invalid(
          `proposal.evaluation.resourceSnapshots[${index}] must be an object`,
        );
      }
      return {
        resourceId: requireCapacityText(
          snapshot.resourceId,
          `proposal.evaluation.resourceSnapshots[${index}].resourceId`,
        ),
        revision: requireCapacityInteger(
          snapshot.revision,
          `proposal.evaluation.resourceSnapshots[${index}].revision`,
          1,
        ),
        contentSha256: requireCapacityText(
          snapshot.contentSha256,
          `proposal.evaluation.resourceSnapshots[${index}].contentSha256`,
          64,
        ),
      };
    }),
    conflicts: conflictsValue.map((conflict, index) => {
      if (!isRecord(conflict)) {
        return invalid(`proposal.evaluation.conflicts[${index}] is invalid`);
      }
      return {
        conflictId: requireCapacityText(
          conflict.conflictId,
          `proposal.evaluation.conflicts[${index}].conflictId`,
        ),
        kind: enumValue(
          conflict.kind,
          `proposal.evaluation.conflicts[${index}].kind`,
          RESOURCE_CAPACITY_CONFLICT_KINDS,
        ),
        needIds: uniqueCapacityIds(
          conflict.needIds,
          `proposal.evaluation.conflicts[${index}].needIds`,
          { allowEmpty: true },
        ),
        resourceIds: uniqueCapacityIds(
          conflict.resourceIds,
          `proposal.evaluation.conflicts[${index}].resourceIds`,
          { allowEmpty: true },
        ),
        subjectEntityIds: uniqueCapacityIds(
          conflict.subjectEntityIds,
          `proposal.evaluation.conflicts[${index}].subjectEntityIds`,
          { allowEmpty: true },
        ),
        sourceRefs: uniqueCapacityIds(
          conflict.sourceRefs,
          `proposal.evaluation.conflicts[${index}].sourceRefs`,
          { allowEmpty: true },
        ),
        facts: uniqueCapacityIds(
          conflict.facts,
          `proposal.evaluation.conflicts[${index}].facts`,
        ),
      };
    }),
    explanationFacts: uniqueCapacityIds(
      explanationFactsValue,
      "proposal.evaluation.explanationFacts",
      { allowEmpty: true },
    ),
    noReservationCreated: true,
  };
  const snapshotResourceIds = evaluation.resourceSnapshots.map(
    (snapshot) => snapshot.resourceId,
  );
  const uniqueSnapshotResourceIds = Array.from(
    new Set(snapshotResourceIds),
  ).sort();
  const assignedResourceIds = Array.from(
    new Set(input.assignments.map((assignment) => assignment.resourceId)),
  ).sort();
  if (
    evaluation.inputSha256 !== resourceCapacitySha256(input) ||
    evaluation.feasible !== (evaluation.conflicts.length === 0) ||
    uniqueSnapshotResourceIds.length !== snapshotResourceIds.length ||
    (evaluation.feasible &&
      resourceCapacitySha256(uniqueSnapshotResourceIds) !==
        resourceCapacitySha256(assignedResourceIds))
  ) {
    return invalid(
      "proposal.evaluation does not match its normalized input, conflicts, or resource snapshots",
    );
  }
  if (
    typeof value.agentId !== "string" ||
    value.version !== 1 ||
    value.noExternalEffect !== true ||
    (value.status !== "blocked" && value.status !== "pending_review")
  ) {
    return invalid("resource-capacity proposal has invalid fixed fields");
  }
  const withoutHash: Omit<ResourceCapacityProposal, "contentSha256"> = {
    proposalId: requireCapacityText(value.proposalId, "proposal.proposalId"),
    agentId: requireCapacityText(value.agentId, "proposal.agentId"),
    version: 1,
    householdId: requireCapacityText(value.householdId, "proposal.householdId"),
    createdByEntityId: requireCapacityText(
      value.createdByEntityId,
      "proposal.createdByEntityId",
    ),
    idempotencyKey: requireCapacityText(
      value.idempotencyKey,
      "proposal.idempotencyKey",
    ),
    inputSha256: requireCapacityText(
      value.inputSha256,
      "proposal.inputSha256",
      64,
    ),
    plan: input.plan,
    assignments: input.assignments,
    transitions: input.transitions,
    maximumSourceAgeMinutes: input.maximumSourceAgeMinutes,
    evaluation,
    requiredApproverEntityIds: uniqueCapacityIds(
      value.requiredApproverEntityIds,
      "proposal.requiredApproverEntityIds",
    ),
    status: value.status,
    expiresAt: requireCapacityTimestamp(value.expiresAt, "proposal.expiresAt"),
    createdAt: requireCapacityTimestamp(value.createdAt, "proposal.createdAt"),
    noExternalEffect: true,
  };
  if (
    withoutHash.householdId !== withoutHash.plan.householdId ||
    withoutHash.status !==
      (withoutHash.evaluation.feasible ? "pending_review" : "blocked") ||
    Date.parse(withoutHash.expiresAt) <= Date.parse(withoutHash.createdAt) ||
    Date.parse(withoutHash.expiresAt) >
      Date.parse(capacityPlanEarliestOccupiedAt(withoutHash.plan)) ||
    withoutHash.inputSha256 !==
      proposalInputSha256({
        plan: withoutHash.plan,
        assignments: withoutHash.assignments,
        transitions: withoutHash.transitions,
        maximumSourceAgeMinutes: withoutHash.maximumSourceAgeMinutes,
        requiredApproverEntityIds: withoutHash.requiredApproverEntityIds,
        expiresAt: withoutHash.expiresAt,
      })
  ) {
    return invalid(
      "resource-capacity proposal identity, status, expiry, or input hash is inconsistent",
      { proposalId: withoutHash.proposalId },
    );
  }
  const contentSha256 = requireCapacityText(
    value.contentSha256,
    "proposal.contentSha256",
    64,
  );
  if (contentSha256 !== proposalContentSha256(withoutHash)) {
    return invalid(
      "resource-capacity proposal hash does not match its contents",
      {
        proposalId: withoutHash.proposalId,
      },
    );
  }
  return { ...withoutHash, contentSha256 };
}
