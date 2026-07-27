/**
 * Deterministic household-operation projections over durable source records.
 *
 * These functions resolve uncertainty, calculate structural opportunity
 * windows, preserve family capacity, and propose review or approval-gated
 * drafts. They never send a message, buy an item, register a child, schedule a
 * vendor, or reassign another adult's responsibility.
 */
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
  getZonedDateParts,
} from "../time.js";
import {
  type AlmanacEntryDefinition,
  type AlmanacWindowResolution,
  contentSha,
  type HouseholdObservation,
  type HouseholdObservationResolution,
  HouseholdOperationsError,
  type HouseholdServiceEvent,
  householdAuthorityRank,
  type ItemReplacementRecommendation,
  type ItemReplacementThresholdDefinition,
  type OpportunityDefinition,
  type OpportunityEvaluation,
  type ResponsibilityAssignmentDefinition,
  type ResponsibilityOwners,
  type ResponsibilityReviewProposal,
  type ResponsibilitySignal,
  stableOperationsId,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MINIMUM_KNOWN_CONFIDENCE = 0.65;

function activeObservations(
  observations: readonly HouseholdObservation[],
): HouseholdObservation[] {
  const superseded = new Set<string>();
  for (const observation of observations) {
    if (observation.supersedesObservationId) {
      superseded.add(observation.supersedesObservationId);
    }
    if (observation.correctsObservationId) {
      superseded.add(observation.correctsObservationId);
    }
  }
  return observations.filter(
    (observation) => !superseded.has(observation.observationId),
  );
}

function observationOrder(
  left: HouseholdObservation,
  right: HouseholdObservation,
): number {
  const authority =
    householdAuthorityRank(right.provenance.authority) -
    householdAuthorityRank(left.provenance.authority);
  if (authority !== 0) return authority;
  const observed =
    Date.parse(right.provenance.observedAt) -
    Date.parse(left.provenance.observedAt);
  if (observed !== 0) return observed;
  const confidence = right.provenance.confidence - left.provenance.confidence;
  if (confidence !== 0) return confidence;
  return left.observationId.localeCompare(right.observationId);
}

export function resolveHouseholdObservation(
  observations: readonly HouseholdObservation[],
): HouseholdObservationResolution {
  if (observations.length === 0) {
    return { state: "unknown", reason: "no_observation" };
  }
  const active = activeObservations(observations).sort(observationOrder);
  const winner = active[0];
  if (!winner || winner.provenance.confidence < MINIMUM_KNOWN_CONFIDENCE) {
    return { state: "unknown", reason: "low_confidence" };
  }
  const topRank = householdAuthorityRank(winner.provenance.authority);
  const topObservedAt = winner.provenance.observedAt;
  const topConfidence = winner.provenance.confidence;
  const equallyAuthoritative = active.filter(
    (observation) =>
      householdAuthorityRank(observation.provenance.authority) === topRank &&
      observation.provenance.observedAt === topObservedAt &&
      observation.provenance.confidence === topConfidence,
  );
  const distinctValues = new Set(
    equallyAuthoritative.map((observation) => contentSha(observation.value)),
  );
  if (distinctValues.size > 1) {
    return {
      state: "ambiguous",
      observationIds: equallyAuthoritative
        .map((observation) => observation.observationId)
        .sort(),
      reason: "equal_authority_conflict",
    };
  }
  return { state: "known", observation: winner };
}

export function evaluateOpportunity(
  opportunity: OpportunityDefinition,
): OpportunityEvaluation {
  if (opportunity.state === "confirmed") {
    return {
      state: "complete",
      countsAsCoverage: true,
      reasons: ["The opportunity has provider- or user-confirmed evidence."],
      effectDraft: null,
    };
  }
  if (
    opportunity.state === "waitlisted" ||
    opportunity.state === "full" ||
    opportunity.state === "closed" ||
    opportunity.state === "declined"
  ) {
    return {
      state: "do_not_recommend",
      countsAsCoverage: false,
      reasons: [
        opportunity.state === "waitlisted"
          ? "A waitlist is not confirmed coverage."
          : `The opportunity is ${opportunity.state}.`,
      ],
      effectDraft: null,
    };
  }
  if (opportunity.state === "unknown" || opportunity.state === "not_open") {
    return {
      state: "needs_information",
      countsAsCoverage: false,
      reasons: [
        opportunity.state === "unknown"
          ? "Availability is unknown."
          : "Registration is not open.",
      ],
      effectDraft: null,
    };
  }
  const capacity = opportunity.capacityPolicy;
  if (capacity.preserveUnstructuredTime) {
    if (
      capacity.maximumStructuredHoursPerWeek === null ||
      capacity.existingStructuredHoursPerWeek === null ||
      opportunity.plannedStructuredHoursPerWeek === null
    ) {
      return {
        state: "needs_information",
        countsAsCoverage: false,
        reasons: [
          "The family capacity policy requires structured-hours evidence before another activity is recommended.",
        ],
        effectDraft: null,
      };
    }
    const projected =
      capacity.existingStructuredHoursPerWeek +
      opportunity.plannedStructuredHoursPerWeek;
    if (projected > capacity.maximumStructuredHoursPerWeek) {
      return {
        state: "do_not_recommend",
        countsAsCoverage: false,
        reasons: [
          `The projected ${projected} structured hours exceed the family's ${capacity.maximumStructuredHoursPerWeek}-hour limit and would consume protected unstructured time.`,
        ],
        effectDraft: null,
      };
    }
  }
  return {
    state: "recommend",
    countsAsCoverage: false,
    reasons: [
      "The opportunity is available and fits the recorded family capacity policy.",
    ],
    effectDraft: {
      effect: opportunity.proposedEffect,
      idempotencyKey: opportunity.effectIdempotencyKey,
      approvalRequirement: opportunity.approvalRequirement,
    },
  };
}

export function evaluateItemReplacement(input: {
  threshold: ItemReplacementThresholdDefinition;
  sizeObservations: readonly HouseholdObservation[];
  inventoryObservations: readonly HouseholdObservation[];
}): ItemReplacementRecommendation {
  const sizeResolution = resolveHouseholdObservation(input.sizeObservations);
  const inventoryResolution = resolveHouseholdObservation(
    input.inventoryObservations,
  );
  const sourceObservationIds: string[] = [];
  const reasons: string[] = [];
  let replacementNeeded = false;
  let verificationNeeded = false;

  if (sizeResolution.state === "known") {
    sourceObservationIds.push(sizeResolution.observation.observationId);
    const value = sizeResolution.observation.value;
    if (value.kind !== "child_item_size") {
      throw new HouseholdOperationsError(
        "Item replacement received a non-size observation",
        "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
        { observationId: sizeResolution.observation.observationId },
      );
    }
    const replacementFitState =
      value.fitState === "too_small" || value.fitState === "damaged"
        ? value.fitState
        : null;
    if (
      replacementFitState !== null &&
      input.threshold.replacementFitStates.includes(replacementFitState)
    ) {
      replacementNeeded = true;
      reasons.push(`The current fit state is ${value.fitState}.`);
    } else if (value.fitState === "unknown") {
      verificationNeeded = true;
      reasons.push("The current fit state is unknown.");
    }
  } else {
    verificationNeeded = true;
    reasons.push(
      sizeResolution.state === "ambiguous"
        ? "Current size observations conflict."
        : "Current size information is unavailable or low confidence.",
    );
    if (sizeResolution.state === "ambiguous") {
      sourceObservationIds.push(...sizeResolution.observationIds);
    }
  }

  if (
    input.threshold.inventorySubjectKey !== null &&
    input.threshold.minimumUsableCount !== null
  ) {
    if (inventoryResolution.state === "known") {
      sourceObservationIds.push(inventoryResolution.observation.observationId);
      const value = inventoryResolution.observation.value;
      if (value.kind !== "inventory_level") {
        throw new HouseholdOperationsError(
          "Item replacement received a non-inventory observation",
          "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
          { observationId: inventoryResolution.observation.observationId },
        );
      }
      if (
        value.state === "confirmed" &&
        value.quantity !== null &&
        value.quantity < input.threshold.minimumUsableCount
      ) {
        replacementNeeded = true;
        reasons.push(
          `Confirmed usable count ${value.quantity} is below the threshold ${input.threshold.minimumUsableCount}.`,
        );
      } else if (value.state !== "confirmed" || value.quantity === null) {
        verificationNeeded = true;
        reasons.push("Usable item count is not confirmed.");
      }
    } else {
      verificationNeeded = true;
      reasons.push(
        inventoryResolution.state === "ambiguous"
          ? "Usable item-count observations conflict."
          : "Usable item count is unknown.",
      );
      if (inventoryResolution.state === "ambiguous") {
        sourceObservationIds.push(...inventoryResolution.observationIds);
      }
    }
  }

  if (replacementNeeded) {
    return {
      state: "replacement_draft",
      reasons,
      purchaseAllowed: false,
      approvalRequirement: input.threshold.approvalRequirement,
      sourceObservationIds: Array.from(new Set(sourceObservationIds)).sort(),
    };
  }
  if (verificationNeeded) {
    return {
      state: "verify",
      reasons,
      purchaseAllowed: false,
      approvalRequirement: null,
      sourceObservationIds: Array.from(new Set(sourceObservationIds)).sort(),
    };
  }
  return {
    state: "no_action",
    reasons: ["Current size and usable count remain within policy."],
    purchaseAllowed: false,
    approvalRequirement: null,
    sourceObservationIds: Array.from(new Set(sourceObservationIds)).sort(),
  };
}

function localMidnight(
  year: number,
  month: number,
  day: number,
  timezone: string,
): Date {
  return buildUtcDateFromLocalParts(timezone, {
    year,
    month,
    day,
    hour: 0,
    minute: 0,
    second: 0,
  });
}

function annualCandidates(
  entry: AlmanacEntryDefinition,
  asOf: Date,
): Array<{ startsAt: Date; endsAt: Date }> {
  if (entry.trigger.kind !== "annual_window") return [];
  const trigger = entry.trigger;
  const localYear = getZonedDateParts(asOf, trigger.timezone).year;
  const crossesYear =
    trigger.closes.month < trigger.opens.month ||
    (trigger.closes.month === trigger.opens.month &&
      trigger.closes.day <= trigger.opens.day);
  return [localYear - 1, localYear, localYear + 1].map((openingYear) => ({
    startsAt: localMidnight(
      openingYear,
      trigger.opens.month,
      trigger.opens.day,
      trigger.timezone,
    ),
    endsAt: localMidnight(
      openingYear + (crossesYear ? 1 : 0),
      trigger.closes.month,
      trigger.closes.day,
      trigger.timezone,
    ),
  }));
}

function addLocalDays(instant: Date, timezone: string, days: number): Date {
  const parts = getZonedDateParts(instant, timezone);
  const target = addDaysToLocalDate(parts, days);
  return localMidnight(target.year, target.month, target.day, timezone);
}

function moveInstantByLocalDays(
  instant: Date,
  timezone: string,
  days: number,
): Date {
  const parts = getZonedDateParts(instant, timezone);
  const target = addDaysToLocalDate(parts, days);
  return buildUtcDateFromLocalParts(timezone, {
    ...target,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  });
}

export function expandAlmanacWindowForPreparation(
  entry: AlmanacEntryDefinition,
  dueWindow: { startsAt: string; endsAt: string },
): { startsAt: string; endsAt: string } {
  return {
    startsAt: moveInstantByLocalDays(
      new Date(dueWindow.startsAt),
      entry.trigger.timezone,
      -entry.preparationLeadDays,
    ).toISOString(),
    endsAt: dueWindow.endsAt,
  };
}

export function resolveAlmanacWindow(input: {
  entry: AlmanacEntryDefinition;
  serviceEvents: readonly HouseholdServiceEvent[];
  asOf: Date;
}): AlmanacWindowResolution {
  const { entry, serviceEvents, asOf } = input;
  if (entry.trigger.kind === "source_window") {
    return {
      state: "known",
      startsAt: entry.trigger.opensAt,
      endsAt: entry.trigger.closesAt,
      reason: null,
      sourceEventId: null,
    };
  }
  if (entry.trigger.kind === "annual_window") {
    const candidate = annualCandidates(entry, asOf)
      .filter((window) => window.endsAt.getTime() > asOf.getTime())
      .sort((left, right) => {
        const leftDistance = Math.abs(left.startsAt.getTime() - asOf.getTime());
        const rightDistance = Math.abs(
          right.startsAt.getTime() - asOf.getTime(),
        );
        return leftDistance - rightDistance;
      })[0];
    if (!candidate) {
      return {
        state: "unknown",
        startsAt: null,
        endsAt: null,
        reason: "No valid annual opportunity window could be resolved.",
        sourceEventId: null,
      };
    }
    return {
      state: "known",
      startsAt: candidate.startsAt.toISOString(),
      endsAt: candidate.endsAt.toISOString(),
      reason: null,
      sourceEventId: null,
    };
  }
  const intervalTrigger = entry.trigger;
  const completed = serviceEvents
    .filter(
      (event) =>
        event.subjectKey === entry.subjectKey &&
        event.serviceKind === intervalTrigger.serviceKind &&
        event.eventKind === "completed" &&
        event.completionEvidenceReference !== null,
    )
    .sort(
      (left, right) =>
        Date.parse(right.provenance.observedAt) -
        Date.parse(left.provenance.observedAt),
    )[0];
  if (!completed) {
    return {
      state: "unknown",
      startsAt: null,
      endsAt: null,
      reason:
        "No evidenced completed service exists from which to calculate the next interval.",
      sourceEventId: null,
    };
  }
  const completedInstant = new Date(
    completed.serviceWindow?.endsAt ?? completed.provenance.observedAt,
  );
  const startsAt = addLocalDays(
    completedInstant,
    intervalTrigger.timezone,
    intervalTrigger.afterDays,
  );
  const endsAt = addLocalDays(
    startsAt,
    intervalTrigger.timezone,
    intervalTrigger.windowDays,
  );
  return {
    state: "known",
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    reason: null,
    sourceEventId: completed.eventId,
  };
}

function ownersForSignalPhase(
  owners: ResponsibilityOwners,
  signal: ResponsibilitySignal,
): string {
  if (signal.phase === "conception") return owners.conceptionOwnerId;
  if (signal.phase === "planning") return owners.planningOwnerId;
  if (signal.phase === "execution") return owners.executionOwnerId;
  return owners.monitoringOwnerId;
}

export function proposeResponsibilityReview(input: {
  assignment: ResponsibilityAssignmentDefinition & { revision: number };
  signals: readonly ResponsibilitySignal[];
  now: Date;
}): ResponsibilityReviewProposal | null {
  const windowStart =
    input.now.getTime() -
    input.assignment.nonUsePolicy.evaluationWindowDays * DAY_MS;
  const relevant = input.signals
    .filter(
      (signal) =>
        signal.assignmentRecordId === input.assignment.recordId &&
        signal.assignmentRevision === input.assignment.revision &&
        Date.parse(signal.provenance.observedAt) >= windowStart &&
        signal.ownerEntityId ===
          ownersForSignalPhase(input.assignment.owners, signal),
    )
    .sort(
      (left, right) =>
        Date.parse(left.provenance.observedAt) -
          Date.parse(right.provenance.observedAt) ||
        left.signalId.localeCompare(right.signalId),
    );
  const lastCompletionIndex = relevant.reduce(
    (last, signal, index) => (signal.signalKind === "completed" ? index : last),
    -1,
  );
  const unresolved = relevant.slice(lastCompletionIndex + 1);
  const dismissalCount = unresolved.filter(
    (signal) =>
      signal.signalKind === "dismissed" || signal.signalKind === "declined",
  ).length;
  const overdueCount = unresolved.filter(
    (signal) => signal.signalKind === "overdue",
  ).length;
  const dismissalTriggered =
    dismissalCount >= input.assignment.nonUsePolicy.dismissalThreshold;
  const overdueTriggered =
    overdueCount >= input.assignment.nonUsePolicy.overdueThreshold;
  if (!dismissalTriggered && !overdueTriggered) return null;

  const trigger =
    dismissalTriggered && overdueTriggered
      ? "dismissal_and_overdue"
      : dismissalTriggered
        ? "repeated_dismissal"
        : "repeated_overdue";
  const snapshotSha256 = contentSha({
    assignmentRecordId: input.assignment.recordId,
    assignmentRevision: input.assignment.revision,
    signalIds: unresolved.map((signal) => signal.signalId),
    trigger,
  });
  const affectedEntityIds = Array.from(
    new Set(Object.values(input.assignment.owners)),
  ).sort();
  const requiredApproverEntityIds = Array.from(
    new Set([...input.assignment.acceptedByEntityIds, ...affectedEntityIds]),
  ).sort();
  const createdAt = input.now.toISOString();
  return {
    reviewId: stableOperationsId("hhreview", {
      assignmentRecordId: input.assignment.recordId,
      assignmentRevision: input.assignment.revision,
      snapshotSha256,
    }),
    householdId: input.assignment.householdId,
    assignmentRecordId: input.assignment.recordId,
    assignmentRevision: input.assignment.revision,
    snapshotSha256,
    trigger,
    currentOwners: input.assignment.owners,
    ownerChanges: [],
    affectedEntityIds,
    requiredApproverEntityIds,
    proposedMode: input.assignment.nonUsePolicy.escalationMode,
    state: "proposed",
    createdAt,
  };
}
