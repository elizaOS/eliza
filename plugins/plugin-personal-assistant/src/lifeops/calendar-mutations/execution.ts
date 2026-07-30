/**
 * Approval-to-provider calendar mutation boundary. It performs read-only
 * preflight before claiming, delegates one external mutation, and translates
 * only explicit non-acceptance into a retry; every other uncertain outcome is
 * durably quarantined.
 */
import type { IAgentRuntime } from "@elizaos/core";
import type { ApprovalRequest } from "../approval-queue.types.js";
import { safeFormatError } from "../connectors/_helpers.js";
import { CalendarMutationLedger } from "./ledger.js";
import {
  type CalendarMutationAttempt,
  type CalendarMutationExecutionResult,
  type CalendarMutationFailure,
  CalendarMutationNotAcceptedError,
  type CalendarMutationPort,
  CalendarMutationPreflightError,
  type CalendarMutationReceipt,
} from "./types.js";

function failureFromUnknown(
  code: string,
  message: string,
  error: unknown,
  retryable: boolean,
): CalendarMutationFailure {
  return {
    code,
    message,
    retryable,
    details: { error: safeFormatError(error) },
  };
}

function receiptForSucceeded(
  attempt: CalendarMutationAttempt,
): CalendarMutationReceipt {
  if (!attempt.receipt) {
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_PERSISTED_RECEIPT_MISSING",
      `Succeeded calendar mutation ${attempt.id} has no receipt.`,
      { details: { attemptId: attempt.id } },
    );
  }
  return attempt.receipt;
}

function mapStoredAttempt(
  attempt: CalendarMutationAttempt,
): CalendarMutationExecutionResult {
  if (attempt.state === "succeeded") {
    return {
      kind: "succeeded",
      duplicateSuppressed: true,
      attempt,
      receipt: receiptForSucceeded(attempt),
    };
  }
  if (attempt.state === "ambiguous" || attempt.state === "executing") {
    return {
      kind: "blocked",
      reason: attempt.state === "ambiguous" ? "ambiguous" : "in_flight",
      attempt,
    };
  }
  if (attempt.state === "invalidated") {
    if (!attempt.lastFailure) {
      throw new CalendarMutationPreflightError(
        "CALENDAR_MUTATION_PERSISTED_FAILURE_MISSING",
        `Invalidated calendar mutation ${attempt.id} has no failure evidence.`,
        { details: { attemptId: attempt.id } },
      );
    }
    return {
      kind: "invalidated",
      attempt,
      failure: attempt.lastFailure,
    };
  }
  if (attempt.state === "failed_retryable") {
    if (!attempt.lastFailure) {
      throw new CalendarMutationPreflightError(
        "CALENDAR_MUTATION_PERSISTED_FAILURE_MISSING",
        `Retryable calendar mutation ${attempt.id} has no failure evidence.`,
        { details: { attemptId: attempt.id } },
      );
    }
    return {
      kind: "retryable",
      phase: attempt.attemptCount > 0 ? "provider" : "preflight",
      attempt,
      failure: attempt.lastFailure,
    };
  }
  throw new CalendarMutationPreflightError(
    "CALENDAR_MUTATION_STATE_UNEXPECTED",
    `Prepared calendar mutation ${attempt.id} has no execution result.`,
    { details: { attemptId: attempt.id } },
  );
}

function validateReceipt(
  request: ApprovalRequest,
  preflight: Awaited<ReturnType<CalendarMutationPort["preflight"]>>,
  receipt: CalendarMutationReceipt,
  agentId: string,
): CalendarMutationFailure | null {
  const calendarPayload =
    request.payload.action === "schedule_event" ||
    request.payload.action === "modify_event" ||
    request.payload.action === "cancel_event"
      ? request.payload
      : null;
  const calendarId = calendarPayload?.calendarId ?? "";
  const approvedSide = calendarPayload?.side ?? "owner";
  const approvedCalendarMatches =
    receipt.calendarId === calendarId ||
    (request.action === "schedule_event" &&
      receipt.provider === "apple_calendar" &&
      (calendarId === "primary" || calendarId === "default") &&
      receipt.calendarId === preflight.calendarId);
  const readableReceipt =
    receipt.accessLevel === "readable" &&
    receipt.readBackAvailable &&
    Boolean(receipt.eventId?.trim()) &&
    Boolean(receipt.providerEventId?.trim()) &&
    receipt.eventSnapshot !== null &&
    receipt.eventSnapshot.id === receipt.eventId &&
    receipt.eventSnapshot.externalId === receipt.providerEventId &&
    receipt.eventSnapshot.agentId === agentId &&
    receipt.eventSnapshot.provider === receipt.provider &&
    receipt.eventSnapshot.side === approvedSide &&
    receipt.eventSnapshot.grantId === receipt.sourceId &&
    receipt.eventSnapshot.calendarId === receipt.calendarId;
  const writeOnlyReceipt =
    receipt.accessLevel === "write_only" &&
    !receipt.readBackAvailable &&
    receipt.provider === "apple_calendar" &&
    receipt.eventId === null &&
    receipt.providerEventId === null &&
    receipt.eventSnapshot === null;
  if (
    receipt.operation !== request.action ||
    !receipt.provider.trim() ||
    receipt.provider !== preflight.provider ||
    !receipt.sourceId.trim() ||
    receipt.sourceId !== preflight.sourceId ||
    !receipt.calendarId.trim() ||
    !approvedCalendarMatches ||
    receipt.calendarId !== preflight.calendarId ||
    (!readableReceipt && !writeOnlyReceipt) ||
    receipt.recurrenceScope !== preflight.recurrenceScope ||
    receipt.cancellationMode !== preflight.cancellationMode ||
    !Number.isFinite(Date.parse(receipt.acceptedAt))
  ) {
    return {
      code: "CALENDAR_MUTATION_PROVIDER_RECEIPT_INVALID",
      message:
        "The calendar provider returned without a complete source-bound receipt.",
      retryable: false,
    };
  }
  return null;
}

export async function executeCalendarMutationApproval(args: {
  readonly runtime: IAgentRuntime;
  readonly request: ApprovalRequest;
  readonly port: CalendarMutationPort;
}): Promise<CalendarMutationExecutionResult> {
  const ledger = new CalendarMutationLedger(args.runtime);
  const stored = await ledger.inspect(args.request);
  if (stored) {
    if (stored.kind === "already_succeeded") {
      return {
        kind: "succeeded",
        duplicateSuppressed: true,
        attempt: stored.attempt,
        receipt: receiptForSucceeded(stored.attempt),
      };
    }
    if (stored.kind === "blocked") {
      return stored;
    }
    if (stored.kind === "invalidated") {
      return mapStoredAttempt(stored.attempt);
    }
  }

  let preflight: Awaited<ReturnType<CalendarMutationPort["preflight"]>>;
  try {
    preflight = await args.port.preflight(args.request);
  } catch (error) {
    const failure =
      error instanceof CalendarMutationPreflightError
        ? error.failure
        : failureFromUnknown(
            "CALENDAR_MUTATION_PREFLIGHT_UNAVAILABLE",
            "Calendar source preflight failed before any provider mutation.",
            error,
            true,
          );
    if (failure.retryable) {
      const attempt = await ledger.recordPreflightRetryable(
        args.request,
        failure,
      );
      return mapStoredAttempt(attempt);
    }
    const invalidated = await ledger.invalidate(args.request, failure);
    if (invalidated.kind === "invalidated") {
      return {
        kind: "invalidated",
        attempt: invalidated.attempt,
        failure,
      };
    }
    if (invalidated.kind === "already_succeeded") {
      return {
        kind: "succeeded",
        duplicateSuppressed: true,
        attempt: invalidated.attempt,
        receipt: receiptForSucceeded(invalidated.attempt),
      };
    }
    if (invalidated.kind === "blocked") return invalidated;
    throw new CalendarMutationPreflightError(
      "CALENDAR_MUTATION_INVALIDATION_STATE_INVALID",
      "Invalidation unexpectedly returned an executable claim.",
      { details: { requestId: args.request.id } },
    );
  }

  const claim = await ledger.claim(args.request);
  if (claim.kind === "already_succeeded") {
    return {
      kind: "succeeded",
      duplicateSuppressed: true,
      attempt: claim.attempt,
      receipt: receiptForSucceeded(claim.attempt),
    };
  }
  if (claim.kind === "blocked") return claim;
  if (claim.kind === "invalidated") return mapStoredAttempt(claim.attempt);

  let receipt: CalendarMutationReceipt;
  try {
    receipt = await args.port.execute(args.request, preflight);
  } catch (error) {
    if (
      error instanceof CalendarMutationPreflightError &&
      !error.failure.retryable
    ) {
      const attempt = await ledger.recordInvalidatedAfterClaim(
        claim.attempt,
        error.failure,
      );
      return {
        kind: "invalidated",
        attempt,
        failure: error.failure,
      };
    }
    if (error instanceof CalendarMutationNotAcceptedError) {
      const attempt = await ledger.recordNotAccepted(
        claim.attempt,
        error.failure,
      );
      return mapStoredAttempt(attempt);
    }
    // error-policy:J1 The provider side-effect boundary cannot know whether a
    // generic throw happened before or after acceptance. It is quarantined and
    // never retried automatically.
    const attempt = await ledger.recordAmbiguous(
      claim.attempt,
      failureFromUnknown(
        "CALENDAR_MUTATION_PROVIDER_OUTCOME_UNKNOWN",
        "The calendar provider outcome is unknown; automatic retry is disabled.",
        error,
        false,
      ),
    );
    return mapStoredAttempt(attempt);
  }

  const receiptFailure = validateReceipt(
    args.request,
    preflight,
    receipt,
    String(args.runtime.agentId),
  );
  if (receiptFailure) {
    const attempt = await ledger.recordAmbiguous(claim.attempt, receiptFailure);
    return mapStoredAttempt(attempt);
  }
  try {
    const completed = await ledger.recordSuccess(claim.attempt, receipt);
    if (completed.state === "ambiguous") return mapStoredAttempt(completed);
    return {
      kind: "succeeded",
      duplicateSuppressed: false,
      attempt: completed,
      receipt: receiptForSucceeded(completed),
    };
  } catch (error) {
    // error-policy:J1 A provider already returned acceptance. Failure to commit
    // its receipt is itself an unknown outcome and must disable retries.
    const quarantined = await ledger.recordAmbiguous(
      claim.attempt,
      failureFromUnknown(
        "CALENDAR_MUTATION_RECEIPT_PERSISTENCE_UNKNOWN",
        "The provider accepted the mutation but its receipt could not be committed.",
        error,
        false,
      ),
    );
    return mapStoredAttempt(quarantined);
  }
}
