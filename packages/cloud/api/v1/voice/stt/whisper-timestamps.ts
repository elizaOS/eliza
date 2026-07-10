/**
 * Parses timestamp spans out of a Whisper `verbose_json` transcription response
 * for the cloud `/api/v1/voice/stt` route (#14806). The route requests
 * `response_format=verbose_json` + word/segment `timestamp_granularities[]`;
 * this module converts the seconds-based OpenAI shapes into the millisecond
 * convention every elizaOS transcript consumer uses (@elizaos/shared
 * transcripts), so a caller can chunk on segment boundaries and map text spans
 * back onto audio time.
 *
 * Untrusted-input rule (J3): the ROUTE validates the response root (an object
 * carrying the required `text` string) and translates violations to a
 * structured 502 — this parser only ever receives that validated record and
 * extracts the OPTIONAL timestamp arrays from it. Each entry is validated
 * structurally — non-empty text, finite non-negative start/end, end >= start.
 * A present malformed array is reported explicitly through `invalidFields`;
 * the route rejects that provider response instead of returning a valid-looking
 * subset that could leave gaps in downstream audio redaction. Absent/empty
 * timestamp arrays yield absent DTO keys because providers may ignore the
 * optional timestamp request.
 */

/** One timed span in ms-from-audio-start (`text` is a word or segment body). */
export interface SttTimedSpan {
  text: string;
  startMs: number;
  endMs: number;
}

export interface WhisperTimestamps {
  /** Segment-level spans, present only when at least one valid entry parsed. */
  segments?: SttTimedSpan[];
  /** Word-level spans, present only when at least one valid entry parsed. */
  words?: SttTimedSpan[];
  /** Present provider fields that cannot be represented without data loss. */
  invalidFields: Array<"segments" | "words">;
}

function toSpan(
  text: unknown,
  start: unknown,
  end: unknown,
): SttTimedSpan | null {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  if (typeof start !== "number" || !Number.isFinite(start) || start < 0) {
    return null;
  }
  if (typeof end !== "number" || !Number.isFinite(end) || end < start) {
    return null;
  }
  return {
    text: text.trim(),
    startMs: Math.round(start * 1000),
    endMs: Math.round(end * 1000),
  };
}

/**
 * Extract ms-based segment/word spans from a ROUTE-VALIDATED `verbose_json`
 * record. Accepts the OpenAI shapes (`segments[]{text,start,end}`,
 * `words[]{word,start,end}`); a plain `{text}` record (server ignored the
 * format request) is the one explicitly valid no-timestamps shape — it parses
 * to no timestamp keys and zero drops. Root-shape violations (non-object body,
 * missing `text`) are the route boundary's job and never reach this function.
 */
export function parseWhisperTimestamps(
  record: Record<string, unknown>,
): WhisperTimestamps {
  const parseArray = (
    value: unknown,
    textKey: "text" | "word",
  ): { spans: SttTimedSpan[]; invalid: boolean } => {
    if (value === undefined) return { spans: [], invalid: false };
    if (!Array.isArray(value)) return { spans: [], invalid: true };
    const spans: SttTimedSpan[] = [];
    let invalid = false;
    for (const entry of value) {
      const row =
        entry && typeof entry === "object"
          ? (entry as Record<string, unknown>)
          : null;
      const span = row ? toSpan(row[textKey], row.start, row.end) : null;
      if (span) {
        spans.push(span);
      } else {
        invalid = true;
      }
    }
    return { spans, invalid };
  };

  const segments = parseArray(record.segments, "text");
  const words = parseArray(record.words, "word");
  const invalidFields: Array<"segments" | "words"> = [];
  if (segments.invalid) invalidFields.push("segments");
  if (words.invalid) invalidFields.push("words");

  return {
    ...(!segments.invalid && segments.spans.length > 0
      ? { segments: segments.spans }
      : {}),
    ...(!words.invalid && words.spans.length > 0 ? { words: words.spans } : {}),
    invalidFields,
  };
}
