import type { TravelBookingPayloadFields } from "./travel-booking.types.js";

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
  | "slack"
  | "imessage"
  | "sms"
  | "x_dm"
  | "email"
  | "google_calendar"
  | "browser"
  | "phone"
  | "internal";

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
  list(filter: ApprovalListFilter): Promise<ReadonlyArray<ApprovalRequest>>;
  byId(id: string): Promise<ApprovalRequest | null>;
  approve(id: string, resolution: ApprovalResolution): Promise<ApprovalRequest>;
  reject(id: string, resolution: ApprovalResolution): Promise<ApprovalRequest>;
  markExecuting(id: string): Promise<ApprovalRequest>;
  markDone(id: string): Promise<ApprovalRequest>;
  markExpired(id: string): Promise<ApprovalRequest>;
  purgeExpired(now: Date): Promise<ReadonlyArray<string>>;
}
