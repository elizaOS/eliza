/**
 * Defines the host seams used by the moved calendar action runner. LifeOps
 * still owns model execution, recent-conversation grounding, and optional
 * travel-buffer computation, so the calendar handler receives those capabilities
 * through this typed dependency object instead of importing LifeOps internals.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import type {
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  LifeOpsCalendarAllDayRange,
  LifeOpsCalendarEvent,
  LifeOpsCalendarRecurrenceScope,
} from "@elizaos/shared";

/**
 * Arguments for a single LLM call routed through the host's model runner.
 * Mirrors the LifeOps `runLifeOpsTextModel` / `runLifeOpsJsonModel` call
 * contract so the calendar handler stays decoupled from the host's
 * trajectory-context + logger plumbing.
 */
export interface CalendarModelCallArgs {
  runtime: IAgentRuntime;
  prompt: string;
  actionType: string;
  failureMessage: string;
  source: string;
  purpose?: string;
}

export interface CalendarJsonModelResult<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  rawResponse: string;
  parsed: T | null;
}

export interface CalendarGroundedReplyArgs {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  scenario: string;
  fallback: string;
  context?: Record<string, unknown>;
  additionalRules: string[];
}

/**
 * Result of resolving a travel buffer for a freshly created event. Shape
 * mirrors the LifeOps `TravelBufferResult` fields the calendar handler reads.
 */
export interface CalendarTravelBufferResult {
  originAddress: string | null;
  destinationAddress: string | null;
  bufferMinutes: number;
  method: string;
}

/**
 * Travel intent resolved from create-event details. The handler only needs the
 * origin address; the host owns the travel domain and computes the buffer.
 */
export interface CalendarTravelIntent {
  originAddress: string;
}

/**
 * Optional travel-buffer integration. Supplied by the LifeOps wrapper, which
 * owns the travel-time domain. When absent, the calendar handler skips all
 * travel-buffer logic (create_event still works, just without a buffer).
 */
export interface CalendarTravelBufferDep {
  /**
   * Resolve a travel intent from explicit/extracted create-event details, or
   * `null` when no origin address was provided.
   */
  resolveTravelIntent(args: {
    details: Record<string, unknown> | undefined;
    extractedDetails: Record<string, unknown>;
  }): CalendarTravelIntent | null;
  /**
   * Compute the travel buffer for a created event. Throws
   * `TravelTimeUnavailable` (see `isTravelTimeUnavailable`) when the buffer
   * cannot be resolved (no maps key, unroutable, etc.).
   */
  computeTravelBuffer(args: {
    runtime: IAgentRuntime;
    event: Pick<LifeOpsCalendarEvent, "id" | "location">;
    travelIntent: CalendarTravelIntent;
  }): Promise<CalendarTravelBufferResult>;
  /**
   * Persist the computed interval through CalendarService before the action
   * claims that travel time was added.
   */
  reserveTravelBuffer(args: {
    runtime: IAgentRuntime;
    eventId: string;
    travelBuffer: CalendarTravelBufferResult;
  }): Promise<void>;
  /** Narrow an unknown error to the travel-time-unavailable case. */
  isTravelTimeUnavailable(
    error: unknown,
  ): error is { code: string; message: string };
}

export interface CalendarMutationApprovalResult {
  readonly requestId: string;
  readonly action: "schedule_event" | "modify_event" | "cancel_event";
  /**
   * Mirrors the host approval queue's state, including the execution-protocol
   * states a dispatch can settle into. A calendar mutation that failed
   * retryably, or whose provider outcome is unknown and needs reconciliation,
   * is a real row state — narrowing it here would report a row as something it
   * is not.
   */
  readonly state:
    | "pending"
    | "approved"
    | "executing"
    | "retryable"
    | "reconciliation_required"
    | "done"
    | "rejected"
    | "expired";
  /** Timestamp read back from the durable approval row after enqueue/replay. */
  readonly acceptedAt: string;
  /** Stable queue-level intent key which made duplicate enqueue safe. */
  readonly idempotencyKey: string;
  /** True only when the queue verified and returned an existing request. */
  readonly replayed: boolean;
  readonly text: string;
}

type PreparedCalendarCreateRequest = CreateLifeOpsCalendarEventRequest & {
  readonly side: "owner" | "agent";
  readonly grantId: string;
  readonly calendarId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly timeZone: string;
};

export interface CalendarMutationUpdateRequest {
  readonly side: "owner" | "agent";
  readonly grantId: string;
  readonly calendarId: string;
  readonly eventId: string;
  readonly title?: string;
  readonly description?: string;
  readonly location?: string;
  readonly startAt?: string;
  readonly endAt?: string;
  readonly allDay?: LifeOpsCalendarAllDayRange;
  readonly timeZone?: string;
  readonly attendees?: CreateLifeOpsCalendarEventAttendee[];
  readonly recurrence?: string[];
  readonly recurrenceScope?: LifeOpsCalendarRecurrenceScope;
  readonly notifyAttendees: boolean;
}

export interface CalendarMutationCancelRequest {
  readonly side: "owner" | "agent";
  readonly grantId: string;
  readonly calendarId: string;
  readonly eventId: string;
  readonly recurrenceScope?: LifeOpsCalendarRecurrenceScope;
  readonly notifyAttendees: boolean;
}

/**
 * Approval boundary for consequential connected-provider writes. The built-in
 * Eliza calendar is local and reversible, so its conversational CRUD executes
 * directly against CalendarService with optimistic concurrency.
 */
export interface CalendarMutationGatewayDep {
  schedule(args: {
    runtime: IAgentRuntime;
    message: Memory;
    request: PreparedCalendarCreateRequest;
    travelBuffer?: CalendarTravelBufferResult;
  }): Promise<CalendarMutationApprovalResult>;
  modify(args: {
    runtime: IAgentRuntime;
    message: Memory;
    targetEvent: LifeOpsCalendarEvent;
    request: CalendarMutationUpdateRequest;
  }): Promise<CalendarMutationApprovalResult>;
  cancel(args: {
    runtime: IAgentRuntime;
    message: Memory;
    targetEvent: LifeOpsCalendarEvent;
    request: CalendarMutationCancelRequest;
  }): Promise<CalendarMutationApprovalResult>;
}

/**
 * Host-supplied dependencies the moved calendar action/handler relies on.
 *
 * The owner-access gate is intentionally NOT part of this interface: the
 * LifeOps wrapper checks owner access before delegating, so the moved handler
 * trusts it has been called for an authorized owner.
 */
export interface CalendarActionDeps {
  /** Run a text-model call; returns the raw string or `null` on failure. */
  runTextModel(args: CalendarModelCallArgs): Promise<string | null>;
  /** Run a model call and parse the response as a JSON record. */
  runJsonModel<T extends Record<string, unknown> = Record<string, unknown>>(
    args: CalendarModelCallArgs,
  ): Promise<CalendarJsonModelResult<T> | null>;
  /** Collect recent conversation lines for grounding the LLM planner. */
  recentConversationTexts(args: {
    runtime: IAgentRuntime;
    message?: Memory;
    state: State | undefined;
    /** @deprecated Complete conversation context is always returned. */
    limit?: number;
  }): Promise<string[]>;
  /**
   * Render the final human-facing reply through the host's model boundary.
   * Hosts that omit this optional presentation seam receive the canonical,
   * already-grounded action reply without changing action settlement.
   */
  renderGroundedReply?(args: CalendarGroundedReplyArgs): Promise<string>;
  /** Optional travel-buffer integration (LifeOps travel domain). */
  travelBuffer?: CalendarTravelBufferDep;
  /**
   * Immutable owner-approval boundary for connected-provider calendar writes.
   * The built-in Eliza calendar remains usable without this dependency.
   */
  mutationGateway?: CalendarMutationGatewayDep;
}
