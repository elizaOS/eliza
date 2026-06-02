/**
 * Pure helpers for the WebSocket event-buffer replay on (re)connect.
 *
 * Extracted from server.ts so the cursor-replay slice logic can be unit-tested
 * in isolation. See loadperf research report 05 (Network & Data Sync),
 * Finding 4: on every (re)connect the server replays the tail of
 * `state.eventBuffer`, re-flooding the client with up to `DEFAULT_REPLAY_LIMIT`
 * historical envelopes even after a brief reconnect. A client that tracks the
 * highest event sequence it has applied can pass it back as a cursor so the
 * server replays only the envelopes the client is actually missing.
 *
 * @module
 */

/**
 * Maximum number of buffered envelopes replayed when the client provides no
 * (or an invalid) cursor. This is the historical, backward-compatible default:
 * a fresh connection with no cursor receives `buffer.slice(-DEFAULT_REPLAY_LIMIT)`.
 */
export const DEFAULT_REPLAY_LIMIT = 120;

/**
 * Minimal shape the replay logic needs from a buffered event envelope. The real
 * envelope (`StreamEventEnvelope` from `@elizaos/shared`) carries more fields;
 * the cursor only cares about the monotonic sequence, which is the integer
 * portion of `eventId` (`evt-<n>`) and is mirrored on `bufferSeq` for envelopes
 * pushed through the primary `pushEvent` path.
 */
export interface ReplayableEvent {
  eventId: string;
  bufferSeq?: number;
}

/**
 * Resolve the monotonic sequence of a buffered envelope.
 *
 * Prefers the explicit numeric `bufferSeq` (stamped by `pushEvent`); falls back
 * to parsing the trailing integer of `eventId` (`evt-<n>`) so envelopes pushed
 * by other code paths (e.g. the `/api/agent-event` REST mirror) still sort and
 * filter correctly. Returns `null` when no sequence can be derived.
 */
export function eventSequence(event: ReplayableEvent): number | null {
  if (
    typeof event.bufferSeq === "number" &&
    Number.isSafeInteger(event.bufferSeq) &&
    event.bufferSeq >= 0
  ) {
    return event.bufferSeq;
  }
  const match = /(\d+)\s*$/.exec(event.eventId);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Parse a client-supplied reconnect cursor (the `lastEventId` WS query param).
 *
 * Accepts either a bare integer (`"42"`) or the full envelope id (`"evt-42"`),
 * since a client may track whichever form it received. Returns the numeric
 * sequence the client has already applied, or `null` when the cursor is absent
 * or not a valid non-negative integer — in which case the caller falls back to
 * the default tail replay (backward-compatible: no cursor => prior behavior).
 */
export function parseEventCursor(
  raw: string | null | undefined,
): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = /(\d+)\s*$/.exec(trimmed);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Select the envelopes to replay to a (re)connecting client.
 *
 * - With a valid `cursor`, returns only envelopes whose sequence is strictly
 *   greater than the cursor (the events the client is missing), preserving
 *   buffer order and capped to the `limit` most recent so a stale cursor can
 *   never replay an unbounded burst.
 * - With `cursor === null` (absent/invalid), returns `buffer.slice(-limit)` —
 *   the exact historical behavior, so clients that send no cursor are
 *   unaffected.
 *
 * Does not mutate the input buffer and does not reorder events.
 */
export function selectReplayEvents<T extends ReplayableEvent>(
  buffer: readonly T[],
  cursor: number | null,
  limit: number = DEFAULT_REPLAY_LIMIT,
): T[] {
  const cap = limit > 0 ? limit : 0;
  if (cursor === null) {
    return cap >= buffer.length ? buffer.slice() : buffer.slice(-cap);
  }
  const missing = buffer.filter((event) => {
    const seq = eventSequence(event);
    return seq !== null && seq > cursor;
  });
  return missing.length > cap ? missing.slice(-cap) : missing;
}
