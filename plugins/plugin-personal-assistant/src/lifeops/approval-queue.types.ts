/** Types for the owner-approval queue: request states, action kinds, and payload shapes. */
import type { TravelBookingPayloadFields } from "./travel-booking.types.js";

export const SCHEDULING_APPROVAL_MESSAGE_KINDS = [
  "opening",
  "proposal",
  "confirmation",
  "cancellation",
] as const;
export type SchedulingApprovalMessageKind =
  (typeof SCHEDULING_APPROVAL_MESSAGE_KINDS)[number];

export const SCHEDULING_APPROVAL_TRANSPORT_CHANNELS = [
  "email",
  "telegram",
  "discord",
  "signal",
  "whatsapp",
  "imessage",
  "sms",
] as const;
export type SchedulingApprovalTransportChannel =
  (typeof SCHEDULING_APPROVAL_TRANSPORT_CHANNELS)[number];

/**
 * Binds an approval row to one immutable scheduling draft. The hash covers
 * the transport envelope and exact message bytes, so a later executor can
 * refuse altered content rather than treating approval as open-ended consent.
 */
export interface SchedulingApprovalCorrelation {
  readonly kind: "scheduling_message";
  readonly negotiationId: string;
  readonly proposalId: string | null;
  readonly messageKind: SchedulingApprovalMessageKind;
  readonly transportChannel: SchedulingApprovalTransportChannel;
  readonly sourceUpdatedAt: string;
  readonly counterpartyEntityId: string;
  readonly counterpartyEntityUpdatedAt: string;
  readonly draftVersion: 1;
  readonly contentSha256: string;
}

export type ApprovalRequestState =
  | "pending"
  | "approved"
  | "executing"
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
  | "signal"
  | "whatsapp"
  | "slack"
  | "imessage"
  | "sms"
  | "x_dm"
  | "email"
  | "google_calendar"
  | "microsoft_calendar"
  | "apple_calendar"
  | "ics_calendar"
  | "browser"
  | "phone"
  | "internal";

export type CalendarMutationRecurrenceScope =
  | "instance"
  | "this_and_following"
  | "series";

export type CalendarCancellationMode =
  | "organizer_cancel"
  | "decline_invitation"
  | "remove_private_copy";

export interface CalendarApprovalAttendee {
  readonly email: string;
  readonly displayName?: string | null;
  readonly optional?: boolean;
}

/** String entries remain readable for approvals persisted before attendee metadata was retained. */
export type CalendarApprovalAttendeeInput = string | CalendarApprovalAttendee;

export interface CalendarSeriesMasterBinding {
  readonly externalId: string;
  readonly startAtMs: number;
  readonly updatedAt: string;
  readonly etag: string;
}

/**
 * A mutable calendar source must be named explicitly once more than one
 * account can expose the same provider calendar id. Optionality preserves
 * persisted single-account create approvals; update/delete execution requires
 * all target-version fields and fails closed for older unbound approvals.
 */
export type CalendarMutationSourceBinding = {
  readonly grantId?: string | null;
  readonly side?: "owner" | "agent" | null;
};

export type ApprovalPayload =
  | {
      action: "send_message";
      recipient: string;
      body: string;
      replyToMessageId: string | null;
      scheduling?: SchedulingApprovalCorrelation;
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
      scheduling?: SchedulingApprovalCorrelation;
    }
  | ({
      action: "schedule_event";
      calendarId: string;
      title: string;
      startsAtMs: number;
      endsAtMs: number;
      timeZone?: string | null;
      durationMinutes?: number | null;
      windowPreset?:
        | "tomorrow_morning"
        | "tomorrow_afternoon"
        | "tomorrow_evening"
        | null;
      attendees: ReadonlyArray<CalendarApprovalAttendeeInput>;
      location: string | null;
      description: string | null;
      recurrence?: ReadonlyArray<string> | null;
      notifyAttendees?: boolean;
      editorRequestSha256?: string;
      travelBuffer?: {
        readonly bufferMinutes: number;
        readonly method: string;
        readonly originAddress: string | null;
        readonly destinationAddress: string | null;
      } | null;
    } & CalendarMutationSourceBinding)
  | ({
      action: "modify_event";
      calendarId: string;
      eventId: string;
      expectedProvider?:
        | "google"
        | "microsoft"
        | "apple_calendar"
        | "ics"
        | null;
      expectedEventUpdatedAt?: string | null;
      expectedEventStartAtMs?: number | null;
      expectedProviderVersion?: string | null;
      recurrenceScope?: CalendarMutationRecurrenceScope | null;
      seriesMaster?: CalendarSeriesMasterBinding | null;
      notifyAttendees?: boolean;
      editorRequestSha256?: string;
      patch: {
        title: string | null;
        startsAtMs: number | null;
        endsAtMs: number | null;
        timeZone?: string | null;
        attendees: ReadonlyArray<CalendarApprovalAttendeeInput> | null;
        location: string | null;
        description: string | null;
        recurrence?: ReadonlyArray<string> | null;
      };
    } & CalendarMutationSourceBinding)
  | ({
      action: "cancel_event";
      calendarId: string;
      eventId: string;
      notifyAttendees: boolean;
      expectedProvider?:
        | "google"
        | "microsoft"
        | "apple_calendar"
        | "ics"
        | null;
      expectedEventUpdatedAt?: string | null;
      expectedEventStartAtMs?: number | null;
      expectedProviderVersion?: string | null;
      recurrenceScope?: CalendarMutationRecurrenceScope | null;
      seriesMaster?: CalendarSeriesMasterBinding | null;
      cancellationMode?: CalendarCancellationMode | null;
      editorRequestSha256?: string;
    } & CalendarMutationSourceBinding)
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
  readonly idempotencyKey: string | null;
  readonly expiresAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly resolutionReason: string | null;
}

/**
 * Atomic enqueue outcome. `reused` comes from the idempotency-constrained
 * insert itself; consumers must not reconstruct it from row state or time.
 */
export interface ApprovalEnqueueResult {
  readonly request: ApprovalRequest;
  readonly reused: boolean;
}

/** Input to `enqueue` — server fills in id, timestamps, and initial state. */
export interface ApprovalEnqueueInput {
  readonly requestedBy: string;
  readonly subjectUserId: string;
  readonly action: ApprovalAction;
  readonly payload: ApprovalPayload;
  readonly channel: ApprovalChannel;
  readonly reason: string;
  /**
   * Permanently binds one caller-defined intent to its immutable request,
   * including terminal rejection. Reconsideration requires an explicit fresh
   * revision/nonce key; implementations never resurrect a rejected row.
   */
  readonly idempotencyKey?: string | null;
  readonly expiresAt: Date;
}

/** A reused idempotency key must describe the same immutable approval. */
export class ApprovalIdempotencyConflictError extends Error {
  public readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super(
      `[ApprovalQueue] idempotency key ${idempotencyKey} already identifies a different approval request`,
    );
    this.name = "ApprovalIdempotencyConflictError";
    this.idempotencyKey = idempotencyKey;
  }
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

/** Thrown when a state transition is invalid. */
export class ApprovalStateTransitionError extends Error {
  public readonly requestId: string;
  public readonly from: ApprovalRequestState;
  public readonly to: ApprovalRequestState;

  constructor(
    requestId: string,
    from: ApprovalRequestState,
    to: ApprovalRequestState,
  ) {
    super(
      `[ApprovalQueue] invalid transition for request ${requestId}: ${from} -> ${to}`,
    );
    this.name = "ApprovalStateTransitionError";
    this.requestId = requestId;
    this.from = from;
    this.to = to;
  }
}

/**
 * Thrown when a compare-and-swap state transition loses a concurrent race:
 * the row's state changed between the read and the guarded write (e.g. an
 * in-flight `approve` racing `purgeExpired`). `from` is the state the row
 * actually holds after the lost race. Subclasses
 * `ApprovalStateTransitionError` so existing invalid-transition handling
 * still applies; callers may match this class first to surface the conflict
 * distinctly.
 */
export class ApprovalTransitionConflictError extends ApprovalStateTransitionError {
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
export class ApprovalNotFoundError extends Error {
  public readonly requestId: string;

  constructor(requestId: string) {
    super(`[ApprovalQueue] request not found: ${requestId}`);
    this.name = "ApprovalNotFoundError";
    this.requestId = requestId;
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
  enqueue(input: ApprovalEnqueueInput): Promise<ApprovalRequest>;
  enqueueWithResult(
    input: ApprovalEnqueueInput,
  ): Promise<ApprovalEnqueueResult>;
  /**
   * Persist an already-confirmed owner gesture without emitting a second
   * approval prompt. The same immutable queue and transition rules apply.
   */
  enqueueConfirmed(
    input: ApprovalEnqueueInput,
    resolution: ApprovalResolution,
  ): Promise<ApprovalRequest>;
  list(filter: ApprovalListFilter): Promise<ReadonlyArray<ApprovalRequest>>;
  byId(id: string): Promise<ApprovalRequest | null>;
  byIdempotencyKey(idempotencyKey: string): Promise<ApprovalRequest | null>;
  approve(id: string, resolution: ApprovalResolution): Promise<ApprovalRequest>;
  reject(id: string, resolution: ApprovalResolution): Promise<ApprovalRequest>;
  markExecuting(id: string): Promise<ApprovalRequest>;
  markDone(id: string): Promise<ApprovalRequest>;
  /** Terminally invalidate a pending or approved request without dispatch. */
  markExpired(id: string): Promise<ApprovalRequest>;
  purgeExpired(now: Date): Promise<ReadonlyArray<string>>;
}
