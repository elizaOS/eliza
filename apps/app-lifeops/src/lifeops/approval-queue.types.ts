/**
 * Approval queue types for LifeOps executive-assistant capability closure (WS6).
 *
 * The approval queue is the single canonical pipeline for any agent action that
 * requires human-in-the-loop confirmation before execution. It is shared by:
 *  - WS5 (UI surface that lists and resolves pending requests)
 *  - WS8 (action runners that enqueue requests and consume their resolution)
 *
 * State machine (strict — no fallback transitions, no implicit re-entry):
 *
 *   pending  ──approve──▶ approved ──markExecuting──▶ executing ──markDone──▶ done
 *      │                       │                            │
 *      │                       └────────reject──────────────┤
 *      │                                                    │
 *      └──reject──▶ rejected                                │
 *      │                                                    │
 *      └──markExpired/purgeExpired──▶ expired               │
 *                                                           │
 *                            (executing may also fail; surface as a
 *                             dedicated error path — never silently
 *                             revert to pending)
 *
 * Invalid transitions throw a typed `ApprovalStateTransitionError`. Callers
 * MUST handle that explicitly — there is no defensive fallback.
 */

/** Lifecycle states an approval request can occupy. */
export type ApprovalRequestState =
  | "pending"
  | "approved"
  | "executing"
  | "done"
  | "rejected"
  | "expired";

/**
 * Closed enum of action kinds that can be queued for approval.
 *
 * Keep this list small and explicit. Adding a new kind is a deliberate
 * cross-cutting change: the action runner (WS8), the UI (WS5), and the
 * test matrix all need to be updated together.
 */
export type ApprovalAction =
  | "send_message"
  | "send_email"
  | "schedule_event"
  | "modify_event"
  | "cancel_event"
  | "book_travel"
  | "make_call"
  | "execute_workflow"
  | "spend_money";

/** Channel through which the underlying action will be carried out. */
export type ApprovalChannel =
  | "telegram"
  | "discord"
  | "slack"
  | "imessage"
  | "sms"
  | "email"
  | "google_calendar"
  | "browser"
  | "phone"
  | "internal";

/**
 * Action-specific payload. Discriminated by `ApprovalAction`.
 *
 * The shape is intentionally constrained per action so consumers can
 * exhaustively switch on `action` and get a fully-typed payload without
 * casts.
 */
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
      kind: "flight" | "hotel" | "ground";
      provider: string;
      itineraryRef: string;
      totalCents: number;
      currency: string;
    }
  | {
      action: "make_call";
      to: string;
      script: string;
      maxDurationSeconds: number;
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

/**
 * Persisted approval request.
 *
 * Field nullability reflects real domain semantics (Commandment 8):
 *  - `resolvedAt`, `resolvedBy`, `resolutionReason` are `null` until
 *    the request leaves `pending`, then non-null forever after.
 *  - `expiresAt` is non-null: every request has an expiry.
 *  - `reason` is non-null: the agent must always justify the request.
 */
export interface ApprovalRequest {
  readonly id: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly state: ApprovalRequestState;
  /** Agent or service that enqueued the request. */
  readonly requestedBy: string;
  /** Owner whose approval is required. */
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

/**
 * Thrown when a state transition is invalid.
 *
 * This is the only error type the queue raises for transition logic.
 * Callers MUST handle it explicitly — the queue does not silently coerce
 * or retry.
 */
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
 * Queue interface. Implementations MUST:
 *  - Reject invalid state transitions by throwing `ApprovalStateTransitionError`.
 *  - Reject unknown ids by throwing `ApprovalNotFoundError`.
 *  - Use the structured logger only (no `console.*`).
 *  - Treat `purgeExpired` as idempotent: it transitions any `pending` rows
 *    whose `expiresAt <= now` to `expired` and returns the affected ids.
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
