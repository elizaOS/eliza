/**
 * Deterministic household-capacity conflict solver.
 *
 * It reasons only over normalized records and exact timestamps. Calendar
 * overlap alone is insufficient: shared caregivers, vehicles, restraints,
 * travel transitions, handoffs, authorization, and stale evidence can block a
 * plan even when every adult's visible events are non-overlapping.
 */
import type {
  CapacityCarSeatRequirement,
  CapacityNeed,
  CaregiverResourceDefinition,
  CarSeatResourceDefinition,
  HouseholdResourceRevision,
  PendingResourceReservation,
  ResourceCapacityAssignment,
  ResourceCapacityConflict,
  ResourceCapacityConflictKind,
  ResourceCapacityEvaluation,
  ResourceCapacityEvaluationInput,
  ResourceTransitionEvidence,
  VehicleResourceDefinition,
} from "./types.js";
import {
  normalizeCapacityEvaluationInput,
  resourceCapacitySha256,
} from "./types.js";

interface SolverInput {
  readonly evaluation: ResourceCapacityEvaluationInput;
  readonly resources: readonly HouseholdResourceRevision[];
  readonly pendingReservations: readonly PendingResourceReservation[];
  readonly evaluatedAt: string;
}

interface Occupancy {
  readonly need: CapacityNeed;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
}

interface ConflictInput {
  readonly kind: ResourceCapacityConflictKind;
  readonly needIds?: readonly string[];
  readonly resourceIds?: readonly string[];
  readonly subjectEntityIds?: readonly string[];
  readonly sourceRefs?: readonly string[];
  readonly facts: readonly string[];
}

type CarSeatResource = HouseholdResourceRevision & CarSeatResourceDefinition;

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function addConflict(
  target: Map<string, ResourceCapacityConflict>,
  input: ConflictInput,
): void {
  const normalized = {
    kind: input.kind,
    needIds: unique(input.needIds ?? []),
    resourceIds: unique(input.resourceIds ?? []),
    subjectEntityIds: unique(input.subjectEntityIds ?? []),
    sourceRefs: unique(input.sourceRefs ?? []),
    facts: unique(input.facts),
  };
  const conflictId = `capacity-conflict-${resourceCapacitySha256(normalized).slice(0, 32)}`;
  target.set(conflictId, { conflictId, ...normalized });
}

function occupancy(need: CapacityNeed): Occupancy {
  return {
    need,
    startsAtMs: Date.parse(need.startsAt) - need.preparationMinutes * 60 * 1000,
    endsAtMs: Date.parse(need.endsAt) + need.recoveryMinutes * 60 * 1000,
  };
}

function intervalsOverlap(
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number,
): boolean {
  return firstStart < secondEnd && secondStart < firstEnd;
}

function assignmentRoleMatches(
  assignment: ResourceCapacityAssignment,
  resource: HouseholdResourceRevision,
): boolean {
  if (
    assignment.role === "caregiver_primary" ||
    assignment.role === "caregiver_backup"
  ) {
    return resource.kind === "caregiver";
  }
  if (assignment.role === "vehicle") return resource.kind === "vehicle";
  return resource.kind === "car_seat";
}

function sourceIsFresh(
  observedAt: string,
  expiresAt: string | null,
  evaluatedAtMs: number,
  maximumAgeMs: number,
): boolean {
  const observedAtMs = Date.parse(observedAt);
  return (
    observedAtMs <= evaluatedAtMs &&
    evaluatedAtMs - observedAtMs <= maximumAgeMs &&
    (expiresAt === null || Date.parse(expiresAt) > evaluatedAtMs)
  );
}

function checkAuthorization(
  conflicts: Map<string, ResourceCapacityConflict>,
  resource: HouseholdResourceRevision,
  occupied: Occupancy,
): void {
  const authorization = resource.authorization;
  const context = {
    needIds: [occupied.need.needId],
    resourceIds: [resource.resourceId],
    subjectEntityIds: occupied.need.childEntityIds,
    sourceRefs: authorization.evidenceRefs,
  };
  if (authorization.state === "pending") {
    addConflict(conflicts, {
      ...context,
      kind: "authorization_pending",
      facts: ["The resource authorization is still pending."],
    });
    return;
  }
  if (authorization.state === "revoked") {
    addConflict(conflicts, {
      ...context,
      kind: "authorization_revoked",
      facts: ["The resource authorization was revoked."],
    });
    return;
  }
  if (
    authorization.state === "expired" ||
    occupied.startsAtMs < Date.parse(authorization.validFrom) ||
    (authorization.expiresAt !== null &&
      occupied.endsAtMs > Date.parse(authorization.expiresAt))
  ) {
    addConflict(conflicts, {
      ...context,
      kind: "authorization_expired",
      facts: [
        "The resource authorization does not cover the full occupied window.",
      ],
    });
  }
}

function checkAvailability(
  conflicts: Map<string, ResourceCapacityConflict>,
  resource: HouseholdResourceRevision,
  occupied: Occupancy,
  evaluatedAtMs: number,
  maximumAgeMs: number,
): void {
  const overlapping = resource.availability.filter((window) =>
    intervalsOverlap(
      occupied.startsAtMs,
      occupied.endsAtMs,
      Date.parse(window.startsAt),
      Date.parse(window.endsAt),
    ),
  );
  const fresh = overlapping.filter((window) =>
    sourceIsFresh(
      window.observedAt,
      window.expiresAt,
      evaluatedAtMs,
      maximumAgeMs,
    ),
  );
  const stale = overlapping.filter(
    (window) =>
      !sourceIsFresh(
        window.observedAt,
        window.expiresAt,
        evaluatedAtMs,
        maximumAgeMs,
      ),
  );
  if (stale.length > 0 && fresh.length === 0) {
    addConflict(conflicts, {
      kind: "source_stale",
      needIds: [occupied.need.needId],
      resourceIds: [resource.resourceId],
      subjectEntityIds: occupied.need.childEntityIds,
      sourceRefs: stale.map((window) => window.sourceRef),
      facts: ["Resource availability evidence is stale or expired."],
    });
  }
  const freshAvailable = fresh.filter((window) => window.state === "available");
  const freshUnavailable = fresh.filter(
    (window) => window.state === "unavailable",
  );
  if (freshAvailable.length > 0 && freshUnavailable.length > 0) {
    addConflict(conflicts, {
      kind: "contradictory_availability",
      needIds: [occupied.need.needId],
      resourceIds: [resource.resourceId],
      subjectEntityIds: occupied.need.childEntityIds,
      sourceRefs: fresh.map((window) => window.sourceRef),
      facts: [
        "Fresh source records disagree about resource availability for this window.",
      ],
    });
  }
  if (freshUnavailable.length > 0) {
    addConflict(conflicts, {
      kind: "outside_availability",
      needIds: [occupied.need.needId],
      resourceIds: [resource.resourceId],
      subjectEntityIds: occupied.need.childEntityIds,
      sourceRefs: freshUnavailable.map((window) => window.sourceRef),
      facts: ["The resource is explicitly unavailable during this window."],
    });
  }
  const coveringAvailable = freshAvailable.some(
    (window) =>
      Date.parse(window.startsAt) <= occupied.startsAtMs &&
      Date.parse(window.endsAt) >= occupied.endsAtMs,
  );
  if (!coveringAvailable) {
    addConflict(conflicts, {
      kind: "availability_unknown",
      needIds: [occupied.need.needId],
      resourceIds: [resource.resourceId],
      subjectEntityIds: occupied.need.childEntityIds,
      sourceRefs: fresh.map((window) => window.sourceRef),
      facts: [
        "No fresh available window covers preparation, activity, and recovery.",
      ],
    });
  }
}

function assignedResourcesForNeed(
  needId: string,
  assignments: readonly ResourceCapacityAssignment[],
  resources: ReadonlyMap<string, HouseholdResourceRevision>,
): HouseholdResourceRevision[] {
  return assignments
    .filter((assignment) => assignment.needId === needId)
    .map((assignment) => resources.get(assignment.resourceId))
    .filter(
      (resource): resource is HouseholdResourceRevision =>
        resource !== undefined,
    );
}

function caregiverAssignments(
  needId: string,
  assignments: readonly ResourceCapacityAssignment[],
  resources: ReadonlyMap<string, HouseholdResourceRevision>,
  role: "caregiver_primary" | "caregiver_backup" = "caregiver_primary",
): Array<HouseholdResourceRevision & CaregiverResourceDefinition> {
  return assignments
    .filter(
      (assignment) => assignment.needId === needId && assignment.role === role,
    )
    .map((assignment) => resources.get(assignment.resourceId))
    .filter(
      (
        resource,
      ): resource is HouseholdResourceRevision & CaregiverResourceDefinition =>
        resource?.kind === "caregiver",
    );
}

function vehicleAssignments(
  needId: string,
  assignments: readonly ResourceCapacityAssignment[],
  resources: ReadonlyMap<string, HouseholdResourceRevision>,
): Array<HouseholdResourceRevision & VehicleResourceDefinition> {
  return assignments
    .filter(
      (assignment) =>
        assignment.needId === needId && assignment.role === "vehicle",
    )
    .map((assignment) => resources.get(assignment.resourceId))
    .filter(
      (
        resource,
      ): resource is HouseholdResourceRevision & VehicleResourceDefinition =>
        resource?.kind === "vehicle",
    );
}

function carSeatAssignments(
  needId: string,
  assignments: readonly ResourceCapacityAssignment[],
  resources: ReadonlyMap<string, HouseholdResourceRevision>,
): CarSeatResource[] {
  return assignments
    .filter(
      (assignment) =>
        assignment.needId === needId && assignment.role === "car_seat",
    )
    .map((assignment) => resources.get(assignment.resourceId))
    .filter(
      (
        resource,
      ): resource is HouseholdResourceRevision & CarSeatResourceDefinition =>
        resource?.kind === "car_seat",
    );
}

// A greedy first match can reject a feasible plan when a flexible restraint is
// consumed before a child-specific one. Augmenting paths preserve one seat per
// child while keeping resource-id ordering deterministic.
function matchCarSeatRequirements(
  requirements: readonly CapacityCarSeatRequirement[],
  seats: readonly CarSeatResource[],
  eligible: (
    requirement: CapacityCarSeatRequirement,
    seat: CarSeatResource,
  ) => boolean,
): Map<number, CarSeatResource> {
  const orderedSeats = [...seats].sort((left, right) =>
    left.resourceId.localeCompare(right.resourceId),
  );
  const seatOwner = new Map<string, number>();
  const seatByRequirement = new Map<number, CarSeatResource>();

  const assign = (
    requirementIndex: number,
    visitedSeatIds: Set<string>,
  ): boolean => {
    const requirement = requirements[requirementIndex];
    if (!requirement) return false;
    for (const seat of orderedSeats) {
      if (visitedSeatIds.has(seat.resourceId) || !eligible(requirement, seat)) {
        continue;
      }
      visitedSeatIds.add(seat.resourceId);
      const priorRequirementIndex = seatOwner.get(seat.resourceId);
      if (
        priorRequirementIndex === undefined ||
        assign(priorRequirementIndex, visitedSeatIds)
      ) {
        seatOwner.set(seat.resourceId, requirementIndex);
        seatByRequirement.set(requirementIndex, seat);
        return true;
      }
    }
    return false;
  };

  for (const requirementIndex of requirements.keys()) {
    assign(requirementIndex, new Set());
  }
  return seatByRequirement;
}

function carSeatMatchesChild(
  requirement: CapacityCarSeatRequirement,
  seat: CarSeatResource,
): boolean {
  return (
    seat.seatClass === requirement.seatClass &&
    seat.compatibleChildEntityIds.includes(requirement.childEntityId)
  );
}

function carSeatMatchesVehicle(
  seat: CarSeatResource,
  vehicles: readonly (HouseholdResourceRevision & VehicleResourceDefinition)[],
): boolean {
  return vehicles.some(
    (vehicle) =>
      seat.compatibleVehicleResourceIds.includes(vehicle.resourceId) &&
      vehicle.supportedCarSeatResourceIds.includes(seat.resourceId),
  );
}

function carSeatInstallationIsFresh(
  seat: CarSeatResource,
  evaluatedAtMs: number,
  maximumAgeMs: number,
): boolean {
  return (
    seat.installationState === "confirmed" &&
    seat.installationObservedAt !== null &&
    sourceIsFresh(
      seat.installationObservedAt,
      seat.installationExpiresAt,
      evaluatedAtMs,
      maximumAgeMs,
    )
  );
}

function unmatchedVehicleOperators(
  vehicles: readonly (HouseholdResourceRevision & VehicleResourceDefinition)[],
  caregivers: readonly (HouseholdResourceRevision &
    CaregiverResourceDefinition)[],
): Array<HouseholdResourceRevision & VehicleResourceDefinition> {
  const caregiverEntityIds = new Set(
    caregivers.map((caregiver) => caregiver.caregiverEntityId),
  );
  const vehiclesById = new Map(
    vehicles.map((vehicle) => [vehicle.resourceId, vehicle]),
  );
  const vehicleByOperator = new Map<string, string>();

  const assignOperator = (
    vehicle: HouseholdResourceRevision & VehicleResourceDefinition,
    visitedOperators: Set<string>,
  ): boolean => {
    for (const operatorEntityId of vehicle.authorizedOperatorEntityIds) {
      if (
        !caregiverEntityIds.has(operatorEntityId) ||
        visitedOperators.has(operatorEntityId)
      ) {
        continue;
      }
      visitedOperators.add(operatorEntityId);
      const priorVehicleId = vehicleByOperator.get(operatorEntityId);
      const priorVehicle = priorVehicleId
        ? vehiclesById.get(priorVehicleId)
        : undefined;
      if (!priorVehicle || assignOperator(priorVehicle, visitedOperators)) {
        vehicleByOperator.set(operatorEntityId, vehicle.resourceId);
        return true;
      }
    }
    return false;
  };

  return vehicles.filter(
    (vehicle) => !assignOperator(vehicle, new Set<string>()),
  );
}

function checkNeedRequirements(
  conflicts: Map<string, ResourceCapacityConflict>,
  need: CapacityNeed,
  assignments: readonly ResourceCapacityAssignment[],
  resources: ReadonlyMap<string, HouseholdResourceRevision>,
  evaluatedAtMs: number,
  maximumAgeMs: number,
): void {
  const primaryCaregivers = caregiverAssignments(
    need.needId,
    assignments,
    resources,
  );
  const assignedVehicles = vehicleAssignments(
    need.needId,
    assignments,
    resources,
  );
  const assignedCarSeats = carSeatAssignments(
    need.needId,
    assignments,
    resources,
  );
  const context = {
    needIds: [need.needId],
    subjectEntityIds: need.childEntityIds,
    sourceRefs: need.sourceRefs,
  };

  if (primaryCaregivers.length < need.requirements.caregiverCount) {
    addConflict(conflicts, {
      ...context,
      kind: "caregiver_shortfall",
      resourceIds: primaryCaregivers.map((resource) => resource.resourceId),
      facts: [
        `The need requires ${need.requirements.caregiverCount} primary caregiver(s), but ${primaryCaregivers.length} are assigned.`,
      ],
    });
  }
  const caregiverCapacity = primaryCaregivers.reduce(
    (total, resource) => total + resource.maximumConcurrentChildren,
    0,
  );
  if (
    need.requirements.caregiverCount > 0 &&
    caregiverCapacity < need.childEntityIds.length
  ) {
    addConflict(conflicts, {
      ...context,
      kind: "caregiver_capacity_exceeded",
      resourceIds: primaryCaregivers.map((resource) => resource.resourceId),
      facts: [
        "Assigned caregivers do not have enough recorded concurrent-child capacity.",
      ],
    });
  }
  for (const caregiver of primaryCaregivers) {
    const unauthorizedChildren = need.childEntityIds.filter(
      (child) => !caregiver.authorizedChildEntityIds.includes(child),
    );
    if (unauthorizedChildren.length > 0) {
      addConflict(conflicts, {
        ...context,
        kind: "child_not_authorized",
        resourceIds: [caregiver.resourceId],
        subjectEntityIds: unauthorizedChildren,
        sourceRefs: caregiver.authorization.evidenceRefs,
        facts: [
          "The caregiver has no recorded authorization for every named child.",
        ],
      });
    }
  }
  const caregiverCapabilities = new Set(
    primaryCaregivers.flatMap((resource) => [
      ...resource.capabilityIds,
      ...resource.trainingCapabilityIds,
    ]),
  );
  const missingCaregiverCapabilities =
    need.requirements.caregiverCapabilityIds.filter(
      (capability) => !caregiverCapabilities.has(capability),
    );
  if (missingCaregiverCapabilities.length > 0) {
    addConflict(conflicts, {
      ...context,
      kind: "caregiver_capability_missing",
      resourceIds: primaryCaregivers.map((resource) => resource.resourceId),
      facts: missingCaregiverCapabilities.map(
        (capability) =>
          `No assigned caregiver has required capability ${capability}.`,
      ),
    });
  }

  if (need.requirements.vehicleRequired && assignedVehicles.length === 0) {
    addConflict(conflicts, {
      ...context,
      kind: "vehicle_missing",
      facts: ["The need requires a vehicle, but none is assigned."],
    });
  }
  const passengerCapacity = assignedVehicles.reduce(
    (total, vehicle) => total + vehicle.passengerCapacity,
    0,
  );
  if (
    need.requirements.vehicleRequired &&
    passengerCapacity < need.requirements.passengerCount
  ) {
    addConflict(conflicts, {
      ...context,
      kind: "vehicle_capacity_exceeded",
      resourceIds: assignedVehicles.map((resource) => resource.resourceId),
      facts: [
        "Assigned vehicle passenger capacity is below the explicit requirement.",
      ],
    });
  }
  const vehiclesWithoutDistinctOperators = unmatchedVehicleOperators(
    assignedVehicles,
    primaryCaregivers,
  );
  for (const vehicle of vehiclesWithoutDistinctOperators) {
    addConflict(conflicts, {
      ...context,
      kind: "vehicle_operator_unauthorized",
      resourceIds: [vehicle.resourceId],
      facts: [
        "No distinct assigned primary caregiver is available and authorized to operate the vehicle.",
      ],
    });
  }

  const fullyCompliantSeatMatching = matchCarSeatRequirements(
    need.requirements.carSeats,
    assignedCarSeats,
    (requirement, seat) =>
      carSeatMatchesChild(requirement, seat) &&
      carSeatMatchesVehicle(seat, assignedVehicles) &&
      carSeatInstallationIsFresh(seat, evaluatedAtMs, maximumAgeMs),
  );
  const seatMatching =
    fullyCompliantSeatMatching.size === need.requirements.carSeats.length
      ? fullyCompliantSeatMatching
      : matchCarSeatRequirements(
          need.requirements.carSeats,
          assignedCarSeats,
          carSeatMatchesChild,
        );
  for (const [
    requirementIndex,
    requirement,
  ] of need.requirements.carSeats.entries()) {
    const matching = seatMatching.get(requirementIndex);
    if (!matching) {
      addConflict(conflicts, {
        ...context,
        kind:
          assignedCarSeats.length === 0
            ? "car_seat_missing"
            : "car_seat_incompatible",
        resourceIds: assignedCarSeats.map((resource) => resource.resourceId),
        subjectEntityIds: [requirement.childEntityId],
        facts: [
          `No assigned ${requirement.seatClass} restraint is explicitly compatible with the child.`,
        ],
      });
      continue;
    }
    const assignedVehicleIds = assignedVehicles.map(
      (vehicle) => vehicle.resourceId,
    );
    if (!carSeatMatchesVehicle(matching, assignedVehicles)) {
      addConflict(conflicts, {
        ...context,
        kind: "car_seat_incompatible",
        resourceIds: [matching.resourceId, ...assignedVehicleIds],
        subjectEntityIds: [requirement.childEntityId],
        facts: [
          "The assigned restraint and vehicle do not mutually declare compatibility.",
        ],
      });
    }
    if (matching.installationState !== "confirmed") {
      addConflict(conflicts, {
        ...context,
        kind: "car_seat_installation_unconfirmed",
        resourceIds: [matching.resourceId],
        subjectEntityIds: [requirement.childEntityId],
        sourceRefs:
          matching.installationEvidenceRef === null
            ? []
            : [matching.installationEvidenceRef],
        facts: ["The restraint installation is not confirmed."],
      });
    } else if (
      matching.installationObservedAt === null ||
      !sourceIsFresh(
        matching.installationObservedAt,
        matching.installationExpiresAt,
        evaluatedAtMs,
        maximumAgeMs,
      )
    ) {
      addConflict(conflicts, {
        ...context,
        kind: "source_stale",
        resourceIds: [matching.resourceId],
        subjectEntityIds: [requirement.childEntityId],
        sourceRefs:
          matching.installationEvidenceRef === null
            ? []
            : [matching.installationEvidenceRef],
        facts: ["Restraint installation evidence is stale or expired."],
      });
    }
  }

  const accessibilityCapabilities = new Set(
    assignedResourcesForNeed(need.needId, assignments, resources).flatMap(
      (resource) =>
        resource.kind === "vehicle"
          ? [...resource.capabilityIds, ...resource.accessibilityCapabilityIds]
          : resource.kind === "caregiver"
            ? [...resource.capabilityIds, ...resource.trainingCapabilityIds]
            : resource.capabilityIds,
    ),
  );
  const missingAccessibility =
    need.requirements.accessibilityCapabilityIds.filter(
      (capability) => !accessibilityCapabilities.has(capability),
    );
  if (missingAccessibility.length > 0) {
    addConflict(conflicts, {
      ...context,
      kind: "accessibility_capability_missing",
      resourceIds: assignedResourcesForNeed(
        need.needId,
        assignments,
        resources,
      ).map((resource) => resource.resourceId),
      facts: missingAccessibility.map(
        (capability) =>
          `No assigned resource has accessibility capability ${capability}.`,
      ),
    });
  }
}

function checkHandoffs(
  conflicts: Map<string, ResourceCapacityConflict>,
  need: CapacityNeed,
  assignedCaregivers: readonly (HouseholdResourceRevision &
    CaregiverResourceDefinition)[],
): void {
  const caregiverEntities = new Set(
    assignedCaregivers.map((resource) => resource.caregiverEntityId),
  );
  for (const handoff of need.handoffs) {
    const instant =
      handoff.kind === "pickup"
        ? Date.parse(need.startsAt)
        : Date.parse(need.endsAt);
    const expectedLocation =
      handoff.kind === "pickup"
        ? need.originLocationRef
        : need.destinationLocationRef;
    if (
      instant < Date.parse(handoff.startsAt) ||
      instant > Date.parse(handoff.endsAt) ||
      handoff.locationRef !== expectedLocation
    ) {
      addConflict(conflicts, {
        kind: "handoff_window_missed",
        needIds: [need.needId],
        resourceIds: assignedCaregivers.map((resource) => resource.resourceId),
        subjectEntityIds: need.childEntityIds,
        sourceRefs: need.sourceRefs,
        facts: [
          "The activity instant or location does not fit the structural handoff window.",
        ],
      });
    }
    const missingPrincipals = handoff.requiredPrincipalEntityIds.filter(
      (principal) => !caregiverEntities.has(principal),
    );
    if (missingPrincipals.length > 0) {
      addConflict(conflicts, {
        kind: "handoff_principal_missing",
        needIds: [need.needId],
        resourceIds: assignedCaregivers.map((resource) => resource.resourceId),
        subjectEntityIds: need.childEntityIds,
        sourceRefs: need.sourceRefs,
        facts: missingPrincipals.map(
          (principal) =>
            `Required handoff principal ${principal} is not an assigned primary caregiver.`,
        ),
      });
    }
  }
}

function exactTransitions(
  transitions: readonly ResourceTransitionEvidence[],
  resourceId: string,
  fromNeedId: string,
  toNeedId: string,
): ResourceTransitionEvidence[] {
  return transitions
    .filter(
      (transition) =>
        transition.resourceId === resourceId &&
        transition.fromNeedId === fromNeedId &&
        transition.toNeedId === toNeedId,
    )
    .sort(
      (left, right) =>
        Date.parse(right.observedAt) - Date.parse(left.observedAt) ||
        left.sourceRef.localeCompare(right.sourceRef),
    );
}

function checkSequentialUse(
  conflicts: Map<string, ResourceCapacityConflict>,
  resourceId: string,
  occupancies: readonly Occupancy[],
  transitions: readonly ResourceTransitionEvidence[],
  evaluatedAtMs: number,
  maximumAgeMs: number,
): void {
  const sorted = [...occupancies].sort(
    (left, right) =>
      left.startsAtMs - right.startsAtMs ||
      left.need.needId.localeCompare(right.need.needId),
  );
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const next = sorted[index];
    if (previous.endsAtMs > next.startsAtMs) {
      addConflict(conflicts, {
        kind: "direct_overlap",
        needIds: [previous.need.needId, next.need.needId],
        resourceIds: [resourceId],
        subjectEntityIds: [
          ...previous.need.childEntityIds,
          ...next.need.childEntityIds,
        ],
        sourceRefs: [...previous.need.sourceRefs, ...next.need.sourceRefs],
        facts: [
          "Preparation, activity, or recovery windows overlap for one resource.",
        ],
      });
      continue;
    }
    if (previous.need.destinationLocationRef === next.need.originLocationRef) {
      continue;
    }
    const matchingTransitions = exactTransitions(
      transitions,
      resourceId,
      previous.need.needId,
      next.need.needId,
    );
    if (matchingTransitions.length === 0) {
      addConflict(conflicts, {
        kind: "transition_evidence_missing",
        needIds: [previous.need.needId, next.need.needId],
        resourceIds: [resourceId],
        subjectEntityIds: [
          ...previous.need.childEntityIds,
          ...next.need.childEntityIds,
        ],
        sourceRefs: [...previous.need.sourceRefs, ...next.need.sourceRefs],
        facts: [
          "The shared resource changes locations without exact transition evidence.",
        ],
      });
      continue;
    }
    if (
      new Set(
        matchingTransitions.map((transition) => transition.minimumMinutes),
      ).size > 1
    ) {
      addConflict(conflicts, {
        kind: "contradictory_transition_evidence",
        needIds: [previous.need.needId, next.need.needId],
        resourceIds: [resourceId],
        subjectEntityIds: [
          ...previous.need.childEntityIds,
          ...next.need.childEntityIds,
        ],
        sourceRefs: matchingTransitions.map(
          (transition) => transition.sourceRef,
        ),
        facts: [
          "Exact transition sources disagree on the minimum travel or handoff time.",
        ],
      });
      continue;
    }
    const transition = matchingTransitions[0];
    if (
      !sourceIsFresh(
        transition.observedAt,
        transition.expiresAt,
        evaluatedAtMs,
        maximumAgeMs,
      )
    ) {
      addConflict(conflicts, {
        kind: "source_stale",
        needIds: [previous.need.needId, next.need.needId],
        resourceIds: [resourceId],
        subjectEntityIds: [
          ...previous.need.childEntityIds,
          ...next.need.childEntityIds,
        ],
        sourceRefs: [transition.sourceRef],
        facts: ["Transition-time evidence is stale or expired."],
      });
      continue;
    }
    const availableMinutes =
      (next.startsAtMs - previous.endsAtMs) / (60 * 1000);
    if (availableMinutes < transition.minimumMinutes) {
      addConflict(conflicts, {
        kind: "transition_time_insufficient",
        needIds: [previous.need.needId, next.need.needId],
        resourceIds: [resourceId],
        subjectEntityIds: [
          ...previous.need.childEntityIds,
          ...next.need.childEntityIds,
        ],
        sourceRefs: [transition.sourceRef],
        facts: [
          `The resource has ${availableMinutes} transition minute(s), below the sourced ${transition.minimumMinutes}-minute minimum.`,
        ],
      });
    }
  }
}

function checkPendingReservations(
  conflicts: Map<string, ResourceCapacityConflict>,
  pendingReservations: readonly PendingResourceReservation[],
  assignment: ResourceCapacityAssignment,
  occupied: Occupancy,
  evaluatedAtMs: number,
): void {
  const blocking = pendingReservations.filter(
    (reservation) =>
      reservation.resourceId === assignment.resourceId &&
      Date.parse(reservation.expiresAt) > evaluatedAtMs &&
      intervalsOverlap(
        occupied.startsAtMs,
        occupied.endsAtMs,
        Date.parse(reservation.startsAt),
        Date.parse(reservation.endsAt),
      ),
  );
  for (const reservation of blocking) {
    addConflict(conflicts, {
      kind: "pending_proposal_reservation",
      needIds: [occupied.need.needId, reservation.needId],
      resourceIds: [assignment.resourceId],
      subjectEntityIds: occupied.need.childEntityIds,
      sourceRefs: [`resource-capacity-proposal:${reservation.proposalId}`],
      facts: [
        "Another unexpired proposal already depends on this resource window; it is not treated as confirmed availability.",
      ],
    });
  }
}

export function evaluateResourceCapacity(
  value: SolverInput,
): ResourceCapacityEvaluation {
  const evaluation = normalizeCapacityEvaluationInput(value.evaluation);
  const evaluatedAtMs = Date.parse(value.evaluatedAt);
  const evaluatedAt = new Date(evaluatedAtMs).toISOString();
  const maximumAgeMs = evaluation.maximumSourceAgeMinutes * 60 * 1000;
  const resources = new Map(
    value.resources.map((resource) => [resource.resourceId, resource]),
  );
  const needs = new Map(
    evaluation.plan.needs.map((need) => [need.needId, need]),
  );
  const conflicts = new Map<string, ResourceCapacityConflict>();
  const assignmentsByResource = new Map<string, Occupancy[]>();
  const assignmentKeys = new Set<string>();

  for (const assignment of evaluation.assignments) {
    const key = `${assignment.needId}\0${assignment.resourceId}`;
    if (assignmentKeys.has(key)) {
      addConflict(conflicts, {
        kind: "duplicate_assignment",
        needIds: [assignment.needId],
        resourceIds: [assignment.resourceId],
        facts: ["The exact resource assignment is duplicated."],
      });
      continue;
    }
    assignmentKeys.add(key);
    const need = needs.get(assignment.needId);
    if (!need) continue;
    const resource = resources.get(assignment.resourceId);
    if (!resource) {
      addConflict(conflicts, {
        kind: "resource_not_found",
        needIds: [need.needId],
        resourceIds: [assignment.resourceId],
        subjectEntityIds: need.childEntityIds,
        sourceRefs: need.sourceRefs,
        facts: ["The assigned resource has no current persisted revision."],
      });
      continue;
    }
    if (resource.householdId !== evaluation.plan.householdId) {
      addConflict(conflicts, {
        kind: "resource_not_found",
        needIds: [need.needId],
        resourceIds: [resource.resourceId],
        subjectEntityIds: need.childEntityIds,
        sourceRefs: need.sourceRefs,
        facts: ["The assigned resource belongs to a different household."],
      });
      continue;
    }
    if (!resource.active) {
      addConflict(conflicts, {
        kind: "resource_inactive",
        needIds: [need.needId],
        resourceIds: [resource.resourceId],
        subjectEntityIds: need.childEntityIds,
        sourceRefs: resource.authorization.evidenceRefs,
        facts: ["The assigned resource is inactive."],
      });
    }
    if (!assignmentRoleMatches(assignment, resource)) {
      addConflict(conflicts, {
        kind: "resource_kind_mismatch",
        needIds: [need.needId],
        resourceIds: [resource.resourceId],
        subjectEntityIds: need.childEntityIds,
        sourceRefs: need.sourceRefs,
        facts: [
          `Assignment role ${assignment.role} cannot use resource kind ${resource.kind}.`,
        ],
      });
    }
    const occupied = occupancy(need);
    checkAuthorization(conflicts, resource, occupied);
    checkAvailability(
      conflicts,
      resource,
      occupied,
      evaluatedAtMs,
      maximumAgeMs,
    );
    checkPendingReservations(
      conflicts,
      value.pendingReservations,
      assignment,
      occupied,
      evaluatedAtMs,
    );
    const existing = assignmentsByResource.get(resource.resourceId) ?? [];
    existing.push(occupied);
    assignmentsByResource.set(resource.resourceId, existing);
  }

  for (const need of evaluation.plan.needs) {
    checkNeedRequirements(
      conflicts,
      need,
      evaluation.assignments,
      resources,
      evaluatedAtMs,
      maximumAgeMs,
    );
    checkHandoffs(
      conflicts,
      need,
      caregiverAssignments(need.needId, evaluation.assignments, resources),
    );
  }
  for (const [resourceId, occupancies] of assignmentsByResource.entries()) {
    checkSequentialUse(
      conflicts,
      resourceId,
      occupancies,
      evaluation.transitions,
      evaluatedAtMs,
      maximumAgeMs,
    );
  }

  const conflictList = Array.from(conflicts.values()).sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.conflictId.localeCompare(right.conflictId),
  );
  const resourceSnapshots = unique(
    evaluation.assignments.map((assignment) => assignment.resourceId),
  )
    .map((resourceId) => resources.get(resourceId))
    .filter(
      (resource): resource is HouseholdResourceRevision =>
        resource !== undefined &&
        resource.householdId === evaluation.plan.householdId,
    )
    .map((resource) => ({
      resourceId: resource.resourceId,
      revision: resource.revision,
      contentSha256: resource.contentSha256,
    }));
  const explanationFacts = unique(
    conflictList.length === 0
      ? [
          "Every assigned resource has fresh covering availability and active authorization.",
          "Caregiver, passenger, restraint, accessibility, handoff, and transition constraints are satisfied.",
          "This evaluation creates no reservation, calendar mutation, message, or external effect.",
        ]
      : [
          `${conflictList.length} structural capacity conflict(s) block a confident plan.`,
          "Adult calendar non-overlap does not override shared-resource conflicts.",
          "This evaluation creates no reservation, calendar mutation, message, or external effect.",
        ],
  );
  return {
    feasible: conflictList.length === 0,
    evaluatedAt,
    inputSha256: resourceCapacitySha256(evaluation),
    resourceSnapshots,
    conflicts: conflictList,
    explanationFacts,
    noReservationCreated: true,
  };
}
