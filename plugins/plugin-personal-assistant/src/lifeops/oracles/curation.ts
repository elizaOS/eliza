/**
 * Deterministic household constraints for local-activity recommendations.
 *
 * The curation pass excludes conflicts and protected family capacity before
 * ranking. Unknown eligibility, access, capacity, custody, headcount, or travel
 * facts produce verification questions and can never become selected coverage.
 */

import type { LocalActivity, RouteCell } from "./contracts.js";
import { oracleError } from "./contracts.js";
import { isRfc3339Instant } from "./http.js";

export interface CurationChild {
  childId: string;
  ageYears: number;
  accessibilityNeeds: string[];
  scheduledLoad: number;
  maxScheduledLoad: number;
}

export interface TimeWindow {
  startAt: string;
  endAt: string;
}

export interface CustodyWindow extends TimeWindow {
  childId: string;
}

export interface BusyWindow extends TimeWindow {
  participantIds: string[];
}

export interface ProtectedUnstructuredWindow extends TimeWindow {
  windowId: string;
  childIds: string[];
}

export interface ActivityTravelFact {
  sourceEventId: string;
  outbound: RouteCell;
  inbound: RouteCell;
}

export interface ActivityCurationCandidate {
  activity: LocalActivity;
  intendedChildIds: string[];
  caregiverParticipantIds: string[];
  eligibleAgeRange: { minimum: number; maximum: number } | null;
  requiredCaregiverHeadcount: number | null;
}

export interface ActivityCurationContext {
  children: CurationChild[];
  custodyWindows: CustodyWindow[];
  custodyHealth: "complete" | "partial" | "unavailable";
  busyWindows: BusyWindow[];
  protectedUnstructuredWindows: ProtectedUnstructuredWindow[];
  travelFacts: ActivityTravelFact[];
  availableCaregiverHeadcount: number | null;
  maxSuggestions: number;
}

export type ActivityCurationReason =
  | "source-not-bookable"
  | "waitlist-not-coverage"
  | "capacity-unavailable"
  | "eligibility-failed"
  | "accessibility-unsupported"
  | "calendar-conflict"
  | "custody-conflict"
  | "scheduled-load-limit"
  | "caregiver-headcount"
  | "protected-unstructured-time"
  | "verification-required"
  | "suggestion-budget";

export interface ActivityCurationDecision {
  sourceEventId: string;
  intendedChildIds: string[];
  participantIds: string[];
  requiredCaregiverHeadcount: number | null;
  status: "selected" | "eligible" | "needs-verification" | "excluded";
  reasons: ActivityCurationReason[];
  verificationQuestions: string[];
  occupiedWindow: TimeWindow | null;
  childcareCoverage: "not-counted";
}

export interface ActivityCurationResult {
  decisions: ActivityCurationDecision[];
  selectedSourceEventIds: string[];
  verificationQuestions: string[];
}

export function curateLocalActivities(
  candidates: ActivityCurationCandidate[],
  context: ActivityCurationContext,
): ActivityCurationResult {
  validateContext(context);
  validateCandidates(candidates);
  const children = new Map(
    context.children.map((child) => [child.childId, child]),
  );
  const travel = new Map(
    context.travelFacts.map((fact) => [fact.sourceEventId, fact]),
  );
  const decisions = candidates
    .map((candidate) => evaluateCandidate(candidate, context, children, travel))
    .sort(compareDecision);

  let selectionsRemaining = context.maxSuggestions;
  const selected: ActivityCurationDecision[] = [];
  const selectedLoadByChild = new Map<string, number>();
  for (const decision of decisions) {
    if (decision.status !== "eligible") continue;
    if (selectionsRemaining === 0) {
      decision.reasons.push("suggestion-budget");
      continue;
    }
    if (
      decision.intendedChildIds.some((childId) => {
        const child = children.get(childId);
        if (!child) {
          throw oracleError(
            "Selected activity references an unknown child.",
            "ACTIVITY_CHILD_UNKNOWN",
            { childId, sourceEventId: decision.sourceEventId },
          );
        }
        const selectedLoad = selectedLoadByChild.get(childId);
        return (
          child.scheduledLoad +
            (selectedLoad === undefined ? 0 : selectedLoad) +
            1 >
          child.maxScheduledLoad
        );
      })
    ) {
      decision.status = "excluded";
      decision.reasons.push("scheduled-load-limit");
      continue;
    }
    const occupiedWindow = decision.occupiedWindow;
    if (
      occupiedWindow &&
      selected.some(
        (selectedDecision) =>
          selectedDecision.occupiedWindow &&
          selectedDecision.participantIds.some((participantId) =>
            decision.participantIds.includes(participantId),
          ) &&
          overlaps(occupiedWindow, selectedDecision.occupiedWindow),
      )
    ) {
      decision.status = "excluded";
      decision.reasons.push("calendar-conflict");
      continue;
    }
    decision.status = "selected";
    selectionsRemaining -= 1;
    selected.push(decision);
    for (const childId of decision.intendedChildIds) {
      const selectedLoad = selectedLoadByChild.get(childId);
      selectedLoadByChild.set(
        childId,
        (selectedLoad === undefined ? 0 : selectedLoad) + 1,
      );
    }
  }

  return {
    decisions,
    selectedSourceEventIds: decisions
      .filter((decision) => decision.status === "selected")
      .map((decision) => decision.sourceEventId),
    verificationQuestions: [
      ...new Set(
        decisions.flatMap((decision) => decision.verificationQuestions),
      ),
    ],
  };
}

function evaluateCandidate(
  candidate: ActivityCurationCandidate,
  context: ActivityCurationContext,
  children: Map<string, CurationChild>,
  travel: Map<string, ActivityTravelFact>,
): ActivityCurationDecision {
  const excluded: ActivityCurationReason[] = [];
  const questions: string[] = [];
  const activity = candidate.activity;
  const eventWindow = parseOptionalWindow(activity.startAt, activity.endAt);
  if (candidate.intendedChildIds.length === 0) {
    throw oracleError(
      "Curation candidates require at least one intended child.",
      "ACTIVITY_CHILD_REQUIRED",
      { sourceEventId: activity.sourceEventId },
    );
  }
  const intendedChildren = candidate.intendedChildIds.map((childId) => {
    const child = children.get(childId);
    if (!child) {
      throw oracleError(
        "Curation candidate references an unknown child.",
        "ACTIVITY_CHILD_UNKNOWN",
        { childId, sourceEventId: activity.sourceEventId },
      );
    }
    return child;
  });
  const participantIds = [
    ...new Set([
      ...candidate.intendedChildIds,
      ...candidate.caregiverParticipantIds,
    ]),
  ];

  if (
    activity.sourceStatus === "offsale" ||
    activity.sourceStatus === "canceled"
  ) {
    excluded.push("source-not-bookable");
  } else if (
    activity.sourceStatus === "unknown" ||
    activity.sourceStatus === "postponed" ||
    activity.sourceStatus === "rescheduled"
  ) {
    questions.push(
      question(activity.sourceEventId, "source status and schedule"),
    );
  }
  if (
    activity.capacity.state === "known" &&
    activity.capacity.value === "waitlist"
  ) {
    excluded.push("waitlist-not-coverage");
  } else if (
    activity.capacity.state === "known" &&
    activity.capacity.value === "full"
  ) {
    excluded.push("capacity-unavailable");
  } else if (activity.capacity.state === "unknown") {
    questions.push(question(activity.sourceEventId, "capacity"));
  }

  if (activity.eligibility.state === "known") {
    if (activity.eligibility.value === "ineligible") {
      excluded.push("eligibility-failed");
    }
  } else {
    questions.push(question(activity.sourceEventId, "provider eligibility"));
  }
  if (!candidate.eligibleAgeRange) {
    questions.push(question(activity.sourceEventId, "age eligibility"));
  }

  if (activity.accessibility.state === "known") {
    if (activity.accessibility.value === "not-supported") {
      const anyNeeds = intendedChildren.some(
        (child) => child.accessibilityNeeds.length > 0,
      );
      if (anyNeeds) excluded.push("accessibility-unsupported");
    }
  } else if (
    intendedChildren.some((child) => child.accessibilityNeeds.length > 0)
  ) {
    questions.push(question(activity.sourceEventId, "accessibility support"));
  }

  for (const child of intendedChildren) {
    if (
      candidate.eligibleAgeRange &&
      (child.ageYears < candidate.eligibleAgeRange.minimum ||
        child.ageYears > candidate.eligibleAgeRange.maximum)
    ) {
      excluded.push("eligibility-failed");
    }
    if (child.scheduledLoad + 1 > child.maxScheduledLoad) {
      excluded.push("scheduled-load-limit");
    }
  }

  if (
    candidate.requiredCaregiverHeadcount === null ||
    context.availableCaregiverHeadcount === null
  ) {
    questions.push(question(activity.sourceEventId, "caregiver headcount"));
  } else if (
    candidate.requiredCaregiverHeadcount > context.availableCaregiverHeadcount
  ) {
    excluded.push("caregiver-headcount");
  }
  if (
    candidate.requiredCaregiverHeadcount !== null &&
    candidate.requiredCaregiverHeadcount >
      candidate.caregiverParticipantIds.length
  ) {
    questions.push(question(activity.sourceEventId, "caregiver assignment"));
  }

  const travelFact = travel.get(activity.sourceEventId);
  let occupiedWindow: TimeWindow | null = null;
  if (!eventWindow) {
    questions.push(question(activity.sourceEventId, "start and end time"));
  } else if (
    !travelFact ||
    travelFact.outbound.status === "unknown" ||
    travelFact.inbound.status === "unknown"
  ) {
    questions.push(question(activity.sourceEventId, "travel time"));
  } else {
    occupiedWindow = {
      startAt: new Date(
        Date.parse(eventWindow.startAt) -
          travelFact.outbound.durationSeconds * 1_000,
      ).toISOString(),
      endAt: new Date(
        Date.parse(eventWindow.endAt) +
          travelFact.inbound.durationSeconds * 1_000,
      ).toISOString(),
    };
  }

  if (occupiedWindow) {
    if (
      context.busyWindows.some(
        (window) =>
          window.participantIds.some((id) => participantIds.includes(id)) &&
          overlaps(occupiedWindow, window),
      )
    ) {
      excluded.push("calendar-conflict");
    }
    if (
      context.protectedUnstructuredWindows.some(
        (window) =>
          window.childIds.some((id) =>
            candidate.intendedChildIds.includes(id),
          ) && overlaps(occupiedWindow, window),
      )
    ) {
      excluded.push("protected-unstructured-time");
    }

    if (context.custodyHealth === "complete") {
      const missingCustody = candidate.intendedChildIds.some(
        (childId) =>
          !context.custodyWindows.some(
            (window) =>
              window.childId === childId && contains(window, occupiedWindow),
          ),
      );
      if (missingCustody) excluded.push("custody-conflict");
    } else {
      questions.push(question(activity.sourceEventId, "custody coverage"));
    }
  }

  const reasons = [...new Set(excluded)];
  if (reasons.length > 0) {
    return {
      sourceEventId: activity.sourceEventId,
      intendedChildIds: [...candidate.intendedChildIds],
      participantIds,
      requiredCaregiverHeadcount: candidate.requiredCaregiverHeadcount,
      status: "excluded",
      reasons,
      verificationQuestions: questions,
      occupiedWindow,
      childcareCoverage: "not-counted",
    };
  }
  if (questions.length > 0) {
    return {
      sourceEventId: activity.sourceEventId,
      intendedChildIds: [...candidate.intendedChildIds],
      participantIds,
      requiredCaregiverHeadcount: candidate.requiredCaregiverHeadcount,
      status: "needs-verification",
      reasons: ["verification-required"],
      verificationQuestions: [...new Set(questions)],
      occupiedWindow,
      childcareCoverage: "not-counted",
    };
  }
  return {
    sourceEventId: activity.sourceEventId,
    intendedChildIds: [...candidate.intendedChildIds],
    participantIds,
    requiredCaregiverHeadcount: candidate.requiredCaregiverHeadcount,
    status: "eligible",
    reasons: [],
    verificationQuestions: [],
    occupiedWindow,
    childcareCoverage: "not-counted",
  };
}

function validateContext(context: ActivityCurationContext): void {
  if (
    !Number.isSafeInteger(context.maxSuggestions) ||
    context.maxSuggestions < 0
  ) {
    throw oracleError(
      "Activity suggestion budget must be a non-negative integer.",
      "ACTIVITY_SUGGESTION_BUDGET_INVALID",
    );
  }
  for (const child of context.children) {
    if (
      !Number.isFinite(child.ageYears) ||
      child.ageYears < 0 ||
      !Number.isSafeInteger(child.scheduledLoad) ||
      child.scheduledLoad < 0 ||
      !Number.isSafeInteger(child.maxScheduledLoad) ||
      child.maxScheduledLoad < 0
    ) {
      throw oracleError(
        "Activity curation child state is invalid.",
        "ACTIVITY_CHILD_INVALID",
        { childId: child.childId },
      );
    }
  }
  if (
    context.availableCaregiverHeadcount !== null &&
    (!Number.isSafeInteger(context.availableCaregiverHeadcount) ||
      context.availableCaregiverHeadcount < 0)
  ) {
    throw oracleError(
      "Available caregiver headcount must be a non-negative integer or unknown.",
      "ACTIVITY_HEADCOUNT_INVALID",
    );
  }
  [
    ...context.custodyWindows,
    ...context.busyWindows,
    ...context.protectedUnstructuredWindows,
  ].forEach(assertWindow);
}

function validateCandidates(candidates: ActivityCurationCandidate[]): void {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    const id = candidate.activity.sourceEventId;
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(id) || ids.has(id)) {
      throw oracleError(
        "Activity source IDs must be safe and unique within a curation pass.",
        "ACTIVITY_SOURCE_ID_INVALID",
      );
    }
    ids.add(id);
    if (
      candidate.eligibleAgeRange &&
      (!Number.isFinite(candidate.eligibleAgeRange.minimum) ||
        candidate.eligibleAgeRange.minimum < 0 ||
        !Number.isFinite(candidate.eligibleAgeRange.maximum) ||
        candidate.eligibleAgeRange.maximum < candidate.eligibleAgeRange.minimum)
    ) {
      throw oracleError(
        "Activity age eligibility range is invalid.",
        "ACTIVITY_AGE_RANGE_INVALID",
        { sourceEventId: id },
      );
    }
    if (
      candidate.requiredCaregiverHeadcount !== null &&
      (!Number.isSafeInteger(candidate.requiredCaregiverHeadcount) ||
        candidate.requiredCaregiverHeadcount < 0)
    ) {
      throw oracleError(
        "Required caregiver headcount must be a non-negative integer or unknown.",
        "ACTIVITY_HEADCOUNT_INVALID",
        { sourceEventId: id },
      );
    }
    if (
      candidate.caregiverParticipantIds.some(
        (participantId) => !/^[A-Za-z0-9._:-]{1,256}$/.test(participantId),
      )
    ) {
      throw oracleError(
        "Activity caregiver participant IDs are invalid.",
        "ACTIVITY_PARTICIPANT_INVALID",
        { sourceEventId: id },
      );
    }
  }
}

function parseOptionalWindow(
  startAt: string | null,
  endAt: string | null,
): TimeWindow | null {
  if (!startAt || !endAt) return null;
  const window = { startAt, endAt };
  assertWindow(window);
  return window;
}

function assertWindow(window: TimeWindow): void {
  const start = Date.parse(window.startAt);
  const end = Date.parse(window.endAt);
  if (
    !isRfc3339Instant(window.startAt) ||
    !isRfc3339Instant(window.endAt) ||
    end <= start
  ) {
    throw oracleError(
      "Activity curation received an invalid time window.",
      "ACTIVITY_WINDOW_INVALID",
    );
  }
}

function overlaps(left: TimeWindow, right: TimeWindow): boolean {
  return (
    Date.parse(left.startAt) < Date.parse(right.endAt) &&
    Date.parse(right.startAt) < Date.parse(left.endAt)
  );
}

function contains(container: TimeWindow, contained: TimeWindow): boolean {
  return (
    Date.parse(container.startAt) <= Date.parse(contained.startAt) &&
    Date.parse(container.endAt) >= Date.parse(contained.endAt)
  );
}

function question(sourceEventId: string, fact: string): string {
  return `Verify ${fact} for source event ${sourceEventId}.`;
}

function compareDecision(
  left: ActivityCurationDecision,
  right: ActivityCurationDecision,
): number {
  const leftStart = left.occupiedWindow
    ? Date.parse(left.occupiedWindow.startAt)
    : Number.POSITIVE_INFINITY;
  const rightStart = right.occupiedWindow
    ? Date.parse(right.occupiedWindow.startAt)
    : Number.POSITIVE_INFINITY;
  return (
    leftStart - rightStart ||
    left.sourceEventId.localeCompare(right.sourceEventId)
  );
}

export interface ChildcareCoverageSlot extends TimeWindow {
  state: "confirmed" | "waitlisted" | "full" | "canceled" | "unknown";
}

export function computeChildcareCoverageGaps(
  required: TimeWindow[],
  slots: ChildcareCoverageSlot[],
): TimeWindow[] {
  required.forEach(assertWindow);
  slots.forEach(assertWindow);
  const confirmed = slots.filter((slot) => slot.state === "confirmed");
  return required.flatMap((window) => subtractCoverage(window, confirmed));
}

function subtractCoverage(
  required: TimeWindow,
  confirmed: TimeWindow[],
): TimeWindow[] {
  let remaining = [required];
  for (const coverage of confirmed) {
    remaining = remaining.flatMap((window) => subtractWindow(window, coverage));
  }
  return remaining;
}

function subtractWindow(
  window: TimeWindow,
  coverage: TimeWindow,
): TimeWindow[] {
  if (!overlaps(window, coverage)) return [window];
  const pieces: TimeWindow[] = [];
  if (Date.parse(coverage.startAt) > Date.parse(window.startAt)) {
    pieces.push({ startAt: window.startAt, endAt: coverage.startAt });
  }
  if (Date.parse(coverage.endAt) < Date.parse(window.endAt)) {
    pieces.push({ startAt: coverage.endAt, endAt: window.endAt });
  }
  return pieces;
}
