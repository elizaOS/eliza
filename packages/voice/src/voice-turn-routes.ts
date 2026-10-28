/**
 * Clients for the resident agent's two voice-turn routes that the conversation voice controller
 * ({@link "./voice-assistant-session"}) uses:
 *
 *  - `POST /api/asr/local-inference/end-of-turn` scores a partial transcript with the fused
 *    end-of-turn scorer of the agent's active voice bridge. It never starts voice or loads a model
 *    and answers `{ available: false, reason }` when it cannot score, so a caller keeps its own
 *    silence gap. Only the resident on the device serves it (local modes only).
 *  - `POST /api/conversations/:id/messages/:messageId/heard` keeps only the part of an assistant
 *    reply the user heard before interrupting playback. The text must be a prefix of the stored
 *    reply or of its spoken form; anything else is 409. Repeats are idempotent.
 *
 * Both go through the host's owner-bound resident request port. Neither ever carries audio. The
 * transcript goes only to the on-device agent; diagnostics keep enums and numbers only, never
 * transcript or reply text.
 *
 * Pure module (no Capacitor, DOM, storage or logging): hosts supply the request port.
 */
import type { EndpointResult } from "./voice-assistant-session.js";

export const END_OF_TURN_PATH = "/api/asr/local-inference/end-of-turn";
/** The route refuses longer transcripts with 400 (END_OF_TURN_MAX_TRANSCRIPT_CHARS). */
export const END_OF_TURN_MAX_CHARS = 4096;
const unavailableReasons = [
  "voice-not-started",
  "ffi-context-unloaded",
  "scorer-unsupported",
  "ram-pressure",
  "unscored",
  "timeout",
] as const;
export type EndOfTurnUnavailableReason =
  | (typeof unavailableReasons)[number]
  | "too-long"
  | "invalid-response"
  | "unknown";
/** The resident's request port: resolves with the parsed JSON body, rejects with `{ status }` on non-2xx. */
export type ResidentRequest = (
  path: string,
  body: unknown,
  signal: AbortSignal,
) => Promise<unknown>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statusOf = (error: unknown) => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
};

/**
 * Reads one end-of-turn response. Only an explicit `available: true` with a boolean `complete`
 * can finish a turn; every other shape is `unavailable`.
 */
export function readEndOfTurn(value: unknown): EndpointResult {
  const row =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (!row) return { decision: "unavailable", reason: "invalid-response" };
  if (row.available === false) {
    const reason = unavailableReasons.includes(
      row.reason as (typeof unavailableReasons)[number],
    )
      ? (row.reason as string)
      : "unknown";
    return { decision: "unavailable", reason };
  }
  if (row.available !== true || typeof row.complete !== "boolean")
    return { decision: "unavailable", reason: "invalid-response" };
  const latency =
    typeof row.latencyMs === "number" &&
    Number.isFinite(row.latencyMs) &&
    row.latencyMs >= 0
      ? { latencyMs: Math.round(row.latencyMs) }
      : {};
  return { decision: row.complete ? "finished" : "continue", ...latency };
}

/**
 * The voice assistant's `endpoint` port over the resident route. A scoring error (502) or a
 * transport failure rejects, which the assistant treats as an error (the long gap decides).
 */
export function residentEndpoint(request: () => ResidentRequest | null) {
  return async (text: string, signal: AbortSignal): Promise<EndpointResult> => {
    signal.throwIfAborted();
    const transcript = String(text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!transcript)
      return { decision: "unavailable", reason: "invalid-response" };
    // The route refuses a longer transcript rather than truncating it; never send one.
    if (transcript.length > END_OF_TURN_MAX_CHARS)
      return { decision: "unavailable", reason: "too-long" };
    const port = request();
    if (!port) return { decision: "unavailable", reason: "unknown" };
    return readEndOfTurn(await port(END_OF_TURN_PATH, { transcript }, signal));
  };
}

export const heardPath = (conversationId: string, messageId: string) =>
  `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/heard`;

/**
 * - `recorded` / `unchanged`: the agent keeps the heard prefix (unchanged: it already did).
 * - `not-needed`: the reply was fully heard (or not interrupted); nothing is sent.
 * - `nothing-heard`: interrupted before any sentence finished. The route needs a non-empty
 *   prefix, so the agent keeps its full reply; the conversation view is still marked.
 * - `conflict` (409): the played text is not a prefix the agent recognises; the view stays trimmed.
 * - `not-found` (404) / `unavailable` (503 or transport failure): retried once, then dropped.
 * - `rejected` (400 and other 4xx), `stale` (binding changed), `invalid` (not an assistant reply
 *   of the current conversation, or a malformed id).
 */
export type HeardOutcome =
  | "recorded"
  | "unchanged"
  | "not-needed"
  | "nothing-heard"
  | "conflict"
  | "not-found"
  | "unavailable"
  | "rejected"
  | "stale"
  | "invalid";
export interface HeardReport {
  conversationId: string;
  replyId: string;
  heard: string;
  unheard: string;
  interrupted: boolean;
}
export interface HeardReporterPorts {
  /** The owner-bound resident request port, or null when the resident session is gone. */
  request(): ResidentRequest | null;
  /** The voice conversation binding is still the same (connection epoch, owner session, conversation). */
  current(conversationId: string): boolean;
  /** The id is an assistant reply of that conversation as this view knows it. */
  isAssistantReply(conversationId: string, messageId: string): boolean;
  /** Diagnostics: the outcome enum and HTTP status only. */
  onOutcome?(
    outcome: HeardOutcome,
    detail: { attempts: number; status?: number },
  ): void;
  setTimer?(callback: () => void, ms: number): unknown;
  /** Delay before the single retry of a 404/503/transport failure. */
  retryDelayMs?: number;
}

/**
 * Records heard-only content after an interruption. Fire and forget: `report` never throws and
 * the next turn never waits for it. At most one retry per reply.
 */
export function createHeardReporter(ports: HeardReporterPorts) {
  const retryDelayMs = ports.retryDelayMs ?? 1500;
  const setTimer =
    ports.setTimer ??
    ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const settled = new Set<string>();
  const finish = (
    outcome: HeardOutcome,
    attempts: number,
    status?: number,
  ): HeardOutcome => {
    try {
      ports.onOutcome?.(outcome, {
        attempts,
        ...(status !== undefined ? { status } : {}),
      });
    } catch {
      /* Diagnostic only. */
    }
    return outcome;
  };
  const attempt = async (
    input: HeardReport,
    heardText: string,
    attempts: number,
  ): Promise<HeardOutcome> => {
    if (!ports.current(input.conversationId))
      return finish("stale", attempts - 1);
    const request = ports.request();
    if (!request) return finish("stale", attempts - 1);
    try {
      const value = (await request(
        heardPath(input.conversationId, input.replyId),
        { heardText },
        AbortSignal.timeout(10_000),
      )) as { ok?: unknown; messageId?: unknown; changed?: unknown } | null;
      if (value?.ok !== true || value.messageId !== input.replyId)
        return finish("rejected", attempts, 200);
      return finish(
        value.changed === true ? "recorded" : "unchanged",
        attempts,
        200,
      );
    } catch (error) {
      const status = statusOf(error);
      if (status === 409) return finish("conflict", attempts, status);
      const transient =
        status === undefined ||
        status === 404 ||
        status === 503 ||
        status === 429 ||
        status >= 500;
      if (!transient) return finish("rejected", attempts, status);
      if (attempts >= 2)
        return finish(
          status === 404 ? "not-found" : "unavailable",
          attempts,
          status,
        );
      // One later retry: the reply may not be persisted yet, or the agent may be restarting.
      await new Promise<void>((resolve) => {
        setTimer(resolve, retryDelayMs);
      });
      return attempt(input, heardText, attempts + 1);
    }
  };
  return {
    report(input: HeardReport): Promise<HeardOutcome> {
      try {
        if (!input?.interrupted || !String(input.unheard || "").trim())
          return Promise.resolve(finish("not-needed", 0));
        const heardText = String(input.heard || "")
          .replace(/\s+/g, " ")
          .trim();
        if (!heardText) return Promise.resolve(finish("nothing-heard", 0));
        if (
          typeof input.conversationId !== "string" ||
          !input.conversationId.trim() ||
          typeof input.replyId !== "string" ||
          !uuid.test(input.replyId) ||
          !ports.isAssistantReply(input.conversationId, input.replyId)
        )
          return Promise.resolve(finish("invalid", 0));
        const key = `${input.conversationId}\n${input.replyId}`;
        // One report per reply: a reply is interrupted once.
        if (settled.has(key)) return Promise.resolve(finish("unchanged", 0));
        settled.add(key);
        return attempt(input, heardText, 1).catch(() =>
          finish("unavailable", 1),
        );
      } catch {
        return Promise.resolve(finish("invalid", 0));
      }
    },
  };
}
