/**
 * Boundary decoder for `eliza.native-transcript/v1`. Every field of an untrusted
 * event is validated here before it reaches the reducer, so `reduce.ts` can trust
 * its input completely and never re-checks shapes.
 *
 * A malformed frame yields an explicit typed failure (`{ ok: false, error }`),
 * never a fabricated-valid default and never a throw — a single bad frame from
 * one bridge must not tear down a live session (error-policy J3: untrusted-input
 * sanitizing produces an explicit "invalid" result). `decodeTranscriptStream`
 * applies the same rule per event: valid events accumulate, malformed ones are
 * collected with their index and reason.
 */

import {
  NATIVE_TRANSCRIPT_SCHEMA,
  type TranscriptEvent,
  type TranscriptEventWord,
} from "./contract";

/** Machine-readable reason a raw value failed to decode. */
export type TranscriptDecodeErrorCode =
  | "not-an-object"
  | "unknown-type"
  | "invalid-seq"
  | "missing-field"
  | "invalid-field";

export interface TranscriptDecodeError {
  code: TranscriptDecodeErrorCode;
  /** The offending field, when the failure is field-specific. */
  field?: string;
  message: string;
}

export type TranscriptDecodeResult =
  | { ok: true; event: TranscriptEvent }
  | { ok: false; error: TranscriptDecodeError };

function fail(
  code: TranscriptDecodeErrorCode,
  message: string,
  field?: string,
): { ok: false; error: TranscriptDecodeError } {
  return { ok: false, error: { code, field, message } };
}

/** `seq` must be a finite, non-negative, safe integer (the ordering key). */
function isValidSeq(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    Number.isSafeInteger(value)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** `at` is optional display metadata; when present it must be a finite number. */
function optionalTimestampInvalid(record: Record<string, unknown>): boolean {
  return "at" in record && !isFiniteNumber(record.at);
}

function decodeWords(
  value: unknown,
): { ok: true; words: TranscriptEventWord[] } | { ok: false } {
  if (!Array.isArray(value)) return { ok: false };
  const words: TranscriptEventWord[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return { ok: false };
    const w = raw as Record<string, unknown>;
    if (
      typeof w.text !== "string" ||
      !isFiniteNumber(w.startMs) ||
      !isFiniteNumber(w.endMs)
    ) {
      return { ok: false };
    }
    words.push({ text: w.text, startMs: w.startMs, endMs: w.endMs });
  }
  return { ok: true, words };
}

/**
 * Validate one raw value into a typed {@link TranscriptEvent}. Unknown keys are
 * ignored (forward compatibility); every KNOWN field is type-checked, and an
 * enum-valued field (`phase`, `scope`) must be one of its allowed members.
 */
export function decodeTranscriptEvent(raw: unknown): TranscriptDecodeResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("not-an-object", "event must be a non-null object");
  }
  const r = raw as Record<string, unknown>;
  const type = r.type;
  if (typeof type !== "string") {
    return fail("missing-field", "event is missing a string `type`", "type");
  }
  if (!isValidSeq(r.seq)) {
    return fail("invalid-seq", "`seq` must be a non-negative integer", "seq");
  }
  if (optionalTimestampInvalid(r)) {
    return fail("invalid-field", "`at` must be a finite number", "at");
  }
  const seq = r.seq;

  switch (type) {
    case "stt.partial": {
      if (!isNonEmptyString(r.turnId))
        return fail("missing-field", "`turnId` is required", "turnId");
      if (typeof r.text !== "string")
        return fail("invalid-field", "`text` must be a string", "text");
      return { ok: true, event: { type, seq, turnId: r.turnId, text: r.text } };
    }
    case "stt.final": {
      if (!isNonEmptyString(r.turnId))
        return fail("missing-field", "`turnId` is required", "turnId");
      if (typeof r.text !== "string")
        return fail("invalid-field", "`text` must be a string", "text");
      let words: TranscriptEventWord[] | undefined;
      if ("words" in r && r.words !== undefined) {
        const decoded = decodeWords(r.words);
        if (!decoded.ok)
          return fail("invalid-field", "`words` is malformed", "words");
        words = decoded.words;
      }
      return {
        ok: true,
        event: words
          ? { type, seq, turnId: r.turnId, text: r.text, words }
          : { type, seq, turnId: r.turnId, text: r.text },
      };
    }
    case "agent.text": {
      if (!isNonEmptyString(r.messageId))
        return fail("missing-field", "`messageId` is required", "messageId");
      if (typeof r.text !== "string")
        return fail("invalid-field", "`text` must be a string", "text");
      if (typeof r.final !== "boolean")
        return fail("invalid-field", "`final` must be a boolean", "final");
      if ("turnId" in r && r.turnId !== undefined && !isNonEmptyString(r.turnId))
        return fail("invalid-field", "`turnId` must be a string", "turnId");
      return {
        ok: true,
        event: {
          type,
          seq,
          messageId: r.messageId,
          text: r.text,
          final: r.final,
          ...(isNonEmptyString(r.turnId) ? { turnId: r.turnId } : {}),
        },
      };
    }
    case "tool.state": {
      if (!isNonEmptyString(r.callId))
        return fail("missing-field", "`callId` is required", "callId");
      if (!isNonEmptyString(r.name))
        return fail("missing-field", "`name` is required", "name");
      if (
        r.phase !== "started" &&
        r.phase !== "succeeded" &&
        r.phase !== "failed"
      )
        return fail("invalid-field", "`phase` is not a tool phase", "phase");
      if ("detail" in r && r.detail !== undefined && typeof r.detail !== "string")
        return fail("invalid-field", "`detail` must be a string", "detail");
      if ("turnId" in r && r.turnId !== undefined && !isNonEmptyString(r.turnId))
        return fail("invalid-field", "`turnId` must be a string", "turnId");
      return {
        ok: true,
        event: {
          type,
          seq,
          callId: r.callId,
          name: r.name,
          phase: r.phase,
          ...(typeof r.detail === "string" ? { detail: r.detail } : {}),
          ...(isNonEmptyString(r.turnId) ? { turnId: r.turnId } : {}),
        },
      };
    }
    case "tts.audio": {
      if (!isNonEmptyString(r.utteranceId))
        return fail("missing-field", "`utteranceId` is required", "utteranceId");
      if (r.phase !== "started" && r.phase !== "ended")
        return fail("invalid-field", "`phase` is not an audio phase", "phase");
      if (
        "messageId" in r &&
        r.messageId !== undefined &&
        !isNonEmptyString(r.messageId)
      )
        return fail("invalid-field", "`messageId` must be a string", "messageId");
      return {
        ok: true,
        event: {
          type,
          seq,
          utteranceId: r.utteranceId,
          phase: r.phase,
          ...(isNonEmptyString(r.messageId) ? { messageId: r.messageId } : {}),
        },
      };
    }
    case "cancel": {
      if (r.scope !== "turn" && r.scope !== "all")
        return fail("invalid-field", "`scope` must be turn|all", "scope");
      if (r.scope === "turn" && !isNonEmptyString(r.turnId))
        return fail("missing-field", "turn cancel requires `turnId`", "turnId");
      if ("reason" in r && r.reason !== undefined && typeof r.reason !== "string")
        return fail("invalid-field", "`reason` must be a string", "reason");
      return {
        ok: true,
        event: {
          type,
          seq,
          scope: r.scope,
          ...(isNonEmptyString(r.turnId) ? { turnId: r.turnId } : {}),
          ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
        },
      };
    }
    case "error": {
      if (!isNonEmptyString(r.code))
        return fail("missing-field", "`code` is required", "code");
      if (typeof r.retryable !== "boolean")
        return fail("invalid-field", "`retryable` must be a boolean", "retryable");
      if (
        "message" in r &&
        r.message !== undefined &&
        typeof r.message !== "string"
      )
        return fail("invalid-field", "`message` must be a string", "message");
      return {
        ok: true,
        event: {
          type,
          seq,
          code: r.code,
          retryable: r.retryable,
          ...(typeof r.message === "string" ? { message: r.message } : {}),
        },
      };
    }
    case "reconnect": {
      if (r.phase !== "lost" && r.phase !== "restored")
        return fail("invalid-field", "`phase` is not a reconnect phase", "phase");
      if (typeof r.attempt !== "number" || !Number.isInteger(r.attempt) || r.attempt < 0)
        return fail("invalid-field", "`attempt` must be a non-negative integer", "attempt");
      return { ok: true, event: { type, seq, phase: r.phase, attempt: r.attempt } };
    }
    default:
      return fail("unknown-type", `unknown event type: ${type}`, "type");
  }
}

export interface TranscriptStreamDecodeResult {
  /** Events that passed validation, in the order they appeared. */
  events: TranscriptEvent[];
  /** Malformed events with their source index and reason (never silently lost). */
  rejected: { index: number; error: TranscriptDecodeError }[];
}

/**
 * Decode a stream envelope `{ schema, events }`. Throws only when the envelope
 * itself is unusable (not an object, wrong/absent schema tag) — that is a
 * programming/version error, not untrusted per-event input. Per-event failures
 * are returned in `rejected`, never thrown, so a mixed batch still yields its
 * good events.
 */
export function decodeTranscriptStream(
  raw: unknown,
): TranscriptStreamDecodeResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(
      "[decodeTranscriptStream] stream must be a { schema, events } object",
    );
  }
  const env = raw as Record<string, unknown>;
  if (env.schema !== NATIVE_TRANSCRIPT_SCHEMA) {
    throw new TypeError(
      `[decodeTranscriptStream] unsupported schema: ${String(env.schema)}`,
    );
  }
  if (!Array.isArray(env.events)) {
    throw new TypeError("[decodeTranscriptStream] `events` must be an array");
  }
  const events: TranscriptEvent[] = [];
  const rejected: { index: number; error: TranscriptDecodeError }[] = [];
  env.events.forEach((rawEvent, index) => {
    const decoded = decodeTranscriptEvent(rawEvent);
    if (decoded.ok) events.push(decoded.event);
    else rejected.push({ index, error: decoded.error });
  });
  return { events, rejected };
}
