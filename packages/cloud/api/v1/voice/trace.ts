/**
 * Shared response-header helpers for cloud voice tracing.
 *
 * The PWA shared-runtime voice path sends a per-turn trace id to the v1 voice
 * routes. These helpers keep trace echo and Server-Timing formatting identical
 * across STT and TTS without coupling either route to the other's provider
 * branches.
 */

export const VOICE_TRACE_HEADER = "X-Eliza-Voice-Trace-Id";

export interface VoiceTimingComponent {
  name: "admission" | "provider" | "transcribe" | "synth" | "cache" | "error";
  durationMs: number;
}

/**
 * Canonical voice trace-id format (boundary validation, #15931 re-land).
 *
 * The client mints ids with `createSharedRuntimeVoiceTraceId()`, which returns
 * either a `crypto.randomUUID()` (RFC-4122, lowercase hex + hyphens, 36 chars)
 * or the deterministic fallback `voice-<base36-time>-<base36-random>`. Both
 * shapes are lowercase, hyphen-delimited, ASCII, and comfortably under 200
 * chars. Rather than couple this parser to one minting scheme, we accept the
 * union of "looks like a client-minted id" as a bounded, charset-restricted,
 * length-capped token:
 *
 *   - charset: ASCII lowercase letters, digits, and hyphen only
 *   - length:  1..MAX (rejects oversized ids that could bloat logs/headers)
 *   - shape:   no leading/trailing/doubled hyphen (rejects `--`, `-x`, `x-`),
 *              which also rules out header-injection filler and empty segments
 *
 * This is deliberately STRICTER than "any non-empty string": control characters
 * (CR/LF for header injection), whitespace, uppercase, unicode, and separators
 * used by log parsers (spaces, quotes, `=`, `;`, `,`) are all rejected. An
 * invalid id is treated as ABSENT (see {@link readVoiceTraceId}) so the route
 * still runs and still emits Server-Timing, but never logs or echoes attacker
 * controlled bytes. "Observably ignored", per the reviewer's framing: the
 * request is served, the trace id simply does not appear in logs or the
 * response header.
 */
export const MAX_VOICE_TRACE_ID_LENGTH = 200;

// Single line, ASCII lowercase alphanumerics grouped by single hyphens.
// Anchored; no `s` flag, so any CR/LF/other control char fails to match.
const VOICE_TRACE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface VoiceTraceIdParse {
  /** The canonical id when the raw header is valid; otherwise `null`. */
  traceId: string | null;
  /** True only when a header was present AND rejected as malformed. */
  invalid: boolean;
}

/**
 * Explicit valid/invalid parse of a raw trace-id header value.
 *
 * @param raw - the raw `X-Eliza-Voice-Trace-Id` value (or null when absent).
 * @returns `{ traceId, invalid }`. Absent header -> `{ null, false }`.
 *          Present + valid -> `{ <id>, false }`. Present + malformed ->
 *          `{ null, true }` so callers can count/observe rejections.
 */
export function parseVoiceTraceId(
  raw: string | null | undefined,
): VoiceTraceIdParse {
  if (raw == null) return { traceId: null, invalid: false };
  // Do NOT trim: a value that is only valid after trimming (e.g. embedded
  // whitespace, leading tab) is not canonical and must be rejected, not
  // silently normalized. An all-whitespace or empty header is "absent".
  if (raw.length === 0) return { traceId: null, invalid: false };
  if (
    raw.length > MAX_VOICE_TRACE_ID_LENGTH ||
    !VOICE_TRACE_ID_PATTERN.test(raw)
  ) {
    return { traceId: null, invalid: true };
  }
  return { traceId: raw, invalid: false };
}

/**
 * Read the canonical voice trace id from a request, or `null` when absent OR
 * malformed. Invalid ids are observably ignored (the route proceeds untraced);
 * the raw attacker-controlled bytes never reach logs or the response header.
 */
export function readVoiceTraceId(request: Request): string | null {
  return parseVoiceTraceId(request.headers.get(VOICE_TRACE_HEADER)).traceId;
}

export function elapsedMs(startMs: number): number {
  return Math.max(0, Date.now() - startMs);
}

export function voiceTraceHeaders(
  traceId: string | null,
  timings: ReadonlyArray<VoiceTimingComponent>,
  extra?: HeadersInit,
): Headers {
  const headers = new Headers(extra);
  // Defense in depth: only echo a canonical id. Every route path derives
  // `traceId` from `readVoiceTraceId` (already validated), but re-validating
  // here guarantees the echo boundary can never emit an un-parsed value even
  // if a future caller forgets to validate.
  if (traceId && parseVoiceTraceId(traceId).traceId === traceId) {
    headers.set(VOICE_TRACE_HEADER, traceId);
  }
  const serverTiming = timings
    .map(
      ({ name, durationMs }) =>
        `${name};dur=${Math.max(0, Math.round(durationMs))}`,
    )
    .join(", ");
  if (serverTiming) headers.set("Server-Timing", serverTiming);
  return headers;
}

export function voiceJsonResponse(
  body: unknown,
  init: {
    status?: number;
    traceId: string | null;
    timings: ReadonlyArray<VoiceTimingComponent>;
  },
): Response {
  return Response.json(body, {
    status: init.status,
    headers: voiceTraceHeaders(init.traceId, init.timings),
  });
}
