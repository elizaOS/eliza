/**
 * Calendar-mutation execution contracts bind one approved payload to one
 * provider source, one claim, and one durable receipt. The receipt is the only
 * success authority after a restart; an unknown provider outcome remains
 * quarantined until a human reconciles it.
 */
import { ElizaError } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import type {
  ApprovalRequest,
  CalendarCancellationMode,
  CalendarMutationRecurrenceScope,
} from "../approval-queue.types.js";

export type CalendarMutationOperation =
  | "schedule_event"
  | "modify_event"
  | "cancel_event";

export type CalendarMutationState =
  | "prepared"
  | "executing"
  | "succeeded"
  | "failed_retryable"
  | "ambiguous"
  | "invalidated";

export interface CalendarMutationReceipt {
  readonly operation: CalendarMutationOperation;
  readonly provider: LifeOpsCalendarEvent["provider"];
  readonly sourceId: string;
  readonly calendarId: string;
  readonly eventId: string | null;
  readonly providerEventId: string | null;
  readonly providerVersion: string | null;
  readonly readBackAvailable: boolean;
  readonly accessLevel: "readable" | "write_only";
  /**
   * Immutable provider-normalized state captured with acceptance. Replays use
   * this snapshot instead of consulting a mutable or evictable event cache.
   */
  readonly eventSnapshot: LifeOpsCalendarEvent | null;
  readonly recurrenceScope: CalendarMutationRecurrenceScope | null;
  readonly cancellationMode: CalendarCancellationMode | null;
  readonly acceptedAt: string;
}

export interface CalendarMutationFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface CalendarMutationAttempt {
  readonly id: string;
  readonly agentId: string;
  readonly approvalRequestId: string;
  readonly approvalSha256: string;
  readonly operationKey: string;
  readonly operation: CalendarMutationOperation;
  readonly state: CalendarMutationState;
  readonly attemptCount: number;
  readonly executorSessionId: string | null;
  readonly claimToken: string | null;
  readonly provider: string | null;
  readonly sourceId: string | null;
  readonly calendarId: string | null;
  readonly eventId: string | null;
  readonly providerEventId: string | null;
  readonly providerVersion: string | null;
  readonly receipt: CalendarMutationReceipt | null;
  readonly lastFailure: CalendarMutationFailure | null;
  readonly firstAttemptedAt: string | null;
  readonly lastAttemptedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CalendarMutationPreflight {
  readonly operation: CalendarMutationOperation;
  readonly provider: LifeOpsCalendarEvent["provider"];
  readonly sourceId: string;
  readonly calendarId: string;
  readonly event: LifeOpsCalendarEvent | null;
  /** Actual provider object the write will target (series master when scoped). */
  readonly providerEventId: string | null;
  /** Provider ETag/version captured immediately before the conditional write. */
  readonly providerVersion: string | null;
  /** Stable provider-create key, including the inserted half of a series split. */
  readonly idempotencyKey: string | null;
  readonly recurrenceScope: CalendarMutationRecurrenceScope | null;
  readonly cancellationMode: CalendarCancellationMode | null;
}

export interface CalendarMutationPort {
  preflight(request: ApprovalRequest): Promise<CalendarMutationPreflight>;
  execute(
    request: ApprovalRequest,
    preflight: CalendarMutationPreflight,
  ): Promise<CalendarMutationReceipt>;
}

export type CalendarMutationExecutionResult =
  | {
      readonly kind: "succeeded";
      readonly duplicateSuppressed: boolean;
      readonly attempt: CalendarMutationAttempt;
      readonly receipt: CalendarMutationReceipt;
    }
  | {
      readonly kind: "blocked";
      readonly reason: "in_flight" | "ambiguous";
      readonly attempt: CalendarMutationAttempt;
    }
  | {
      readonly kind: "retryable";
      readonly phase: "preflight" | "provider";
      readonly attempt: CalendarMutationAttempt;
      readonly failure: CalendarMutationFailure;
    }
  | {
      readonly kind: "invalidated";
      readonly attempt: CalendarMutationAttempt;
      readonly failure: CalendarMutationFailure;
    };

export class CalendarMutationPreflightError extends ElizaError {
  override readonly name = "CalendarMutationPreflightError";
  readonly failure: CalendarMutationFailure;

  constructor(
    code: string,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly details?: Readonly<Record<string, unknown>>;
      readonly cause?: unknown;
    } = {},
  ) {
    const failure: CalendarMutationFailure = {
      code,
      message,
      retryable: options.retryable ?? false,
      ...(options.details ? { details: options.details } : {}),
    };
    super(`[CalendarMutation] ${message}`, {
      code,
      context: options.details,
      cause: options.cause,
      severity: failure.retryable ? "ephemeral" : "fatal",
    });
    this.failure = failure;
  }
}

/**
 * Only this explicit error permits another provider attempt. Generic throws
 * may have happened after acceptance and therefore become ambiguous.
 */
export class CalendarMutationNotAcceptedError extends ElizaError {
  override readonly name = "CalendarMutationNotAcceptedError";
  readonly failure: CalendarMutationFailure;

  constructor(
    code: string,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    cause?: unknown,
  ) {
    const failure: CalendarMutationFailure = {
      code,
      message,
      retryable: true,
      ...(details ? { details } : {}),
    };
    super(`[CalendarMutation] ${message}`, {
      code,
      context: details,
      cause,
      severity: "ephemeral",
    });
    this.failure = failure;
  }
}
