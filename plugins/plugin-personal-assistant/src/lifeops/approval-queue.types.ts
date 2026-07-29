/** Types for the owner-approval queue: request states, action kinds, and payload shapes. */
import {
  APPROVAL_EXECUTION_CAPABILITY,
  APPROVAL_EXECUTION_PROTOCOL_VERSION,
  ApprovalNotFoundError as RuntimeApprovalNotFoundError,
  ApprovalStateTransitionError as RuntimeApprovalStateTransitionError,
} from "@elizaos/agent";
import type { TravelBookingPayloadFields } from "./travel-booking.types.js";

export type ApprovalRequestState =
  | "pending"
  | "approved"
  | "executing"
  | "retryable"
  | "reconciliation_required"
  | "done"
  | "rejected"
  | "expired";

export type ApprovalAction =
  | "send_message"
  | "send_email"
  | "schedule_event"
  | "modify_event"
  | "cancel_event"
  | "book_travel"
  | "make_call"
  | "sign_document"
  | "execute_workflow"
  | "spend_money";

export type ApprovalChannel =
  | "telegram"
  | "discord"
  | "slack"
  | "imessage"
  | "sms"
  | "x_dm"
  | "email"
  | "google_calendar"
  | "browser"
  | "phone"
  | "internal";

export interface ApprovalExecution {
  readonly attemptId: string;
  readonly provider: string;
  readonly providerIdempotencyKey: string;
  readonly claimedAt: Date;
  readonly dispatchStartedAt: Date | null;
  readonly providerReceipt: Readonly<Record<string, unknown>> | null;
  readonly error: string | null;
  readonly reconciledAt: Date | null;
  readonly reconciledBy: string | null;
  readonly reconciliationReason: string | null;
}

export type ApprovalPayload =
  | {
      action: "send_message";
      recipient: string;
      body: string;
      replyToMessageId: string | null;
    }
  | {
      action: "send_email";
      to: ReadonlyArray<string>;
      cc: ReadonlyArray<string>;
      bcc: ReadonlyArray<string>;
      subject: string;
      body: string;
      threadId: string | null;
      replyToMessageId?: string | null;
    }
  | {
      action: "schedule_event";
      calendarId: string;
      title: string;
      startsAtMs: number;
      endsAtMs: number;
      attendees: ReadonlyArray<string>;
      location: string | null;
      description: string | null;
    }
  | {
      action: "modify_event";
      calendarId: string;
      eventId: string;
      patch: {
        title: string | null;
        startsAtMs: number | null;
        endsAtMs: number | null;
        attendees: ReadonlyArray<string> | null;
        location: string | null;
        description: string | null;
      };
    }
  | {
      action: "cancel_event";
      calendarId: string;
      eventId: string;
      notifyAttendees: boolean;
    }
  | {
      action: "book_travel";
      kind: TravelBookingPayloadFields["kind"];
      provider: string;
      itineraryRef: string;
      totalCents: number;
      currency: string;
      offerId?: string | null;
      offerRequestId?: string | null;
      orderType?: "hold" | "instant" | null;
      search?: TravelBookingPayloadFields["search"];
      passengers?: TravelBookingPayloadFields["passengers"];
      calendarSync?: TravelBookingPayloadFields["calendarSync"];
      summary?: string | null;
      /** Server-side cost breakdown surfaced to the user alongside any
       *  payment-required prompt. Mirrors `DuffelCallCost`; held as a
       *  loose record here so the approval-queue type doesn't have to
       *  depend on the travel-adapter package. */
      cost?: {
        readonly totalUsd: number;
        readonly creatorMarkupUsd: number;
        readonly platformFeeUsd: number;
        readonly markupPercent: number | null;
      } | null;
      /** Set when an x402 PaymentRequiredError fired before the booking
       *  could be quoted. The user sees both the booking intent and the
       *  top-up prompt in a single approval entry. */
      paymentRequired?: {
        readonly amount: string;
        readonly asset: string;
        readonly network: string;
        readonly payTo: string;
        readonly scheme: string;
        readonly expiresAt: string | null;
        readonly description: string | null;
      } | null;
    }
  | {
      action: "make_call";
      to: string;
      script: string;
      maxDurationSeconds: number;
    }
  | {
      action: "sign_document";
      documentId: string;
      documentName: string;
      signatureUrl: string;
      deadline: string;
    }
  | {
      action: "execute_workflow";
      workflowId: string;
      input: Readonly<Record<string, string | number | boolean>>;
    }
  | {
      action: "spend_money";
      vendor: string;
      amountCents: number;
      currency: string;
      memo: string;
    };

/** Persisted approval request. */
export interface ApprovalRequest {
  readonly id: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly state: ApprovalRequestState;
  readonly requestedBy: string;
  readonly subjectUserId: string;
  readonly action: ApprovalAction;
  readonly payload: ApprovalPayload;
  readonly channel: ApprovalChannel;
  readonly reason: string;
  readonly expiresAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly resolutionReason: string | null;
  readonly execution: ApprovalExecution | null;
}

/** Input to `enqueue` — server fills in id, timestamps, and initial state. */
export interface ApprovalEnqueueInput {
  readonly requestedBy: string;
  readonly subjectUserId: string;
  readonly action: ApprovalAction;
  readonly payload: ApprovalPayload;
  readonly channel: ApprovalChannel;
  readonly reason: string;
  readonly expiresAt: Date;
}

/** Filter for `list`. All fields combine with AND. */
export interface ApprovalListFilter {
  readonly subjectUserId: string | null;
  readonly state: ApprovalRequestState | null;
  readonly action: ApprovalAction | null;
  readonly limit: number;
}

/** Resolution input for `approve` / `reject`. */
export interface ApprovalResolution {
  readonly resolvedBy: string;
  readonly resolutionReason: string;
}

export interface ApprovalExecutionClaim {
  readonly requestId: string;
  readonly subjectUserId: string;
  readonly provider: string;
  readonly providerIdempotencyKey: string;
}

export interface ApprovalExecutionMutation {
  readonly requestId: string;
  readonly subjectUserId: string;
  readonly attemptId: string;
}

export interface ApprovalExecutionFailure extends ApprovalExecutionMutation {
  readonly error: string;
  readonly providerReceipt?: Readonly<Record<string, unknown>>;
}

export interface ApprovalExecutionCompletion extends ApprovalExecutionMutation {
  readonly providerReceipt: Readonly<Record<string, unknown>>;
}

export interface ApprovalExecutionReconciliation
  extends ApprovalExecutionMutation {
  readonly outcome: "delivered" | "not_delivered";
  readonly reconciledBy: string;
  readonly reconciliationReason: string;
  readonly providerReceipt?: Readonly<Record<string, unknown>>;
}

/** Thrown when a state transition is invalid. */
export {
  RuntimeApprovalNotFoundError as ApprovalNotFoundError,
  RuntimeApprovalStateTransitionError as ApprovalStateTransitionError,
};

/**
 * Thrown when a compare-and-swap state transition loses a concurrent race:
 * the row's state changed between the read and the guarded write (e.g. an
 * in-flight `approve` racing `purgeExpired`). `from` is the state the row
 * actually holds after the lost race. Subclasses
 * `ApprovalStateTransitionError` so existing invalid-transition handling
 * still applies; callers may match this class first to surface the conflict
 * distinctly.
 */
export class ApprovalTransitionConflictError extends RuntimeApprovalStateTransitionError {
  constructor(
    requestId: string,
    actualState: ApprovalRequestState,
    to: ApprovalRequestState,
  ) {
    super(requestId, actualState, to);
    this.name = "ApprovalTransitionConflictError";
    this.message = `[ApprovalQueue] transition conflict for request ${requestId}: state is now ${actualState}, refusing ${actualState} -> ${to}`;
  }
}

/** Thrown when an operation references an unknown request id. */
/** Thrown before resolution when a registered queue predates required methods. */
export class ApprovalQueueCompatibilityError extends Error {
  public readonly actualCapability: unknown;
  public readonly actualVersion: unknown;

  constructor(actualCapability: unknown, actualVersion: unknown) {
    super(
      `[ApprovalQueue] registered capability is incompatible; expected ${APPROVAL_EXECUTION_CAPABILITY}@${APPROVAL_EXECUTION_PROTOCOL_VERSION}`,
    );
    this.name = "ApprovalQueueCompatibilityError";
    this.actualCapability = actualCapability;
    this.actualVersion = actualVersion;
  }
}

/**
 * Queue interface. Implementations must:
 *  - Reject invalid state transitions by throwing `ApprovalStateTransitionError`.
 *  - Reject unknown ids by throwing `ApprovalNotFoundError`.
 *  - Use the structured logger only (no `console.*`).
 *  - Treat `purgeExpired` as idempotent.
 */
export interface ApprovalQueue {
  readonly capability: typeof APPROVAL_EXECUTION_CAPABILITY;
  readonly protocolVersion: typeof APPROVAL_EXECUTION_PROTOCOL_VERSION;
  enqueue(input: ApprovalEnqueueInput): Promise<ApprovalRequest>;
  list(filter: ApprovalListFilter): Promise<ReadonlyArray<ApprovalRequest>>;
  byId(id: string, subjectUserId: string): Promise<ApprovalRequest | null>;
  approve(
    id: string,
    subjectUserId: string,
    resolution: ApprovalResolution,
  ): Promise<ApprovalRequest>;
  reject(
    id: string,
    subjectUserId: string,
    resolution: ApprovalResolution,
  ): Promise<ApprovalRequest>;
  claimExecution(claim: ApprovalExecutionClaim): Promise<ApprovalRequest>;
  markDispatchStarted(
    mutation: ApprovalExecutionMutation,
  ): Promise<ApprovalRequest>;
  markDone(completion: ApprovalExecutionCompletion): Promise<ApprovalRequest>;
  markRetryableFailure(
    failure: ApprovalExecutionFailure,
  ): Promise<ApprovalRequest>;
  markReconciliationRequired(
    failure: ApprovalExecutionFailure,
  ): Promise<ApprovalRequest>;
  recoverUnstartedExecution(
    mutation: ApprovalExecutionMutation,
  ): Promise<ApprovalRequest>;
  reconcileExecution(
    reconciliation: ApprovalExecutionReconciliation,
  ): Promise<ApprovalRequest>;
  markExpired(id: string, subjectUserId: string): Promise<ApprovalRequest>;
  removePending(id: string, subjectUserId: string): Promise<void>;
  purgeExpired(now: Date): Promise<ReadonlyArray<string>>;
}
