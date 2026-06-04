import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";

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

/**
 * Result of resolving a travel buffer for a freshly created event. Shape
 * mirrors the LifeOps `TravelBufferResult` fields the calendar handler reads.
 */
export interface CalendarTravelBufferResult {
  originAddress: string;
  destinationAddress: string;
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
  /** Narrow an unknown error to the travel-time-unavailable case. */
  isTravelTimeUnavailable(error: unknown): error is { code: string; message: string };
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
    limit: number;
  }): Promise<string[]>;
  /** Optional travel-buffer integration (LifeOps travel domain). */
  travelBuffer?: CalendarTravelBufferDep;
}
