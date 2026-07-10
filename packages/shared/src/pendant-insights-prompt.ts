/**
 * Pendant insights — the pure prompt/schema builder.
 *
 * Both the agent route (which calls `runtime.useModel`) and the client scheduler
 * import this so the prompt that PRODUCES a rollup and the schema that VALIDATES
 * it are declared exactly once. No runtime/network deps — pure string assembly —
 * so it's trivially unit-testable and reusable from either side.
 */

import {
  makePendantSegmentId,
  PENDANT_INSIGHTS_SCHEMA_VERSION,
  type TranscriptRange,
} from "./pendant-insights.js";

/**
 * The minimal transcript-segment shape the insight generator needs. Structurally
 * compatible with {@link import("./transcripts.js").TranscriptSegment} — the
 * scheduler can pass its own accumulated segments as long as they carry a stable
 * id + text (+ optional speaker + timing).
 */
export interface InsightSourceSegment {
  /** Stable segment id (see {@link makePendantSegmentId}). */
  id: string;
  /** Canonical server-authoritative session owning this segment. */
  sessionId: string;
  /** Ordinal within the session (for range + deterministic id derivation). */
  ordinal: number;
  /** Session-sync revision for late ASR/diarization patches. */
  revision?: number;
  text: string;
  /** Anonymous/session-local speaker cluster id. Null means unknown. */
  speakerId?: string | null;
  speakerLabel?: string;
  /** Epoch ms this segment was captured (0/undefined if unknown). */
  atMs?: number;
}

/** Options that shape the generated prompt. */
export interface BuildInsightsPromptOptions {
  /** Segments in chronological order. Assumed already deduped by the caller. */
  segments: ReadonlyArray<InsightSourceSegment>;
  /**
   * Optional prior summary to give the model continuity across windows (rolling
   * context). Kept short by the caller; never the full history.
   */
  priorSummary?: string;
  /** Max characters of transcript body to include (cost guard). Default 12000. */
  maxTranscriptChars?: number;
  kind?: "rollup" | "digest";
}

/** Default transcript-body character budget fed to the model. */
export const DEFAULT_MAX_TRANSCRIPT_CHARS = 12_000;

/** The result of building a prompt: the prompt text + the audited range/ids. */
export interface BuiltInsightsPrompt {
  prompt: string;
  /** The segment ids actually included (for evidence filtering post-generation). */
  includedSegmentIds: string[];
  transcriptRange: TranscriptRange;
}

/**
 * Render the transcript segments the model will read. Each line is prefixed with
 * its segment id in brackets so the model can cite `sourceSegmentIds` precisely,
 * and (when known) the speaker label. Trailing segments are dropped if the body
 * would exceed `maxTranscriptChars` (KEEP the most RECENT — a rolling window
 * cares most about the tail), and the range reflects only what was included.
 */
export function renderTranscriptForPrompt(
  segments: ReadonlyArray<InsightSourceSegment>,
  maxChars: number = DEFAULT_MAX_TRANSCRIPT_CHARS,
): { body: string; included: InsightSourceSegment[] } {
  const included: InsightSourceSegment[] = [];
  let total = 0;
  // Walk newest → oldest, keep until the budget is hit, then restore order.
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    const text = seg.text.trim();
    if (!text) continue;
    const speaker = seg.speakerLabel ? `${seg.speakerLabel}: ` : "";
    const line = `[${seg.id}] ${speaker}${text}`;
    if (total + line.length > maxChars && included.length > 0) break;
    included.push(seg);
    total += line.length + 1;
  }
  included.reverse();
  const body = included
    .map((seg) => {
      const speaker = seg.speakerLabel ? `${seg.speakerLabel}: ` : "";
      return `[${seg.id}] ${speaker}${seg.text.trim()}`;
    })
    .join("\n");
  return { body, included };
}

/** Compute the {@link TranscriptRange} for a set of included segments. */
export function computeTranscriptRange(
  included: ReadonlyArray<InsightSourceSegment>,
): TranscriptRange {
  if (included.length === 0) {
    return {
      startOrdinal: 0,
      endOrdinal: 0,
      segmentCount: 0,
      startedAtMs: 0,
      endedAtMs: 0,
    };
  }
  let startOrdinal = Number.POSITIVE_INFINITY;
  let endOrdinal = 0;
  let startedAtMs = Number.POSITIVE_INFINITY;
  let endedAtMs = 0;
  for (const seg of included) {
    if (seg.ordinal < startOrdinal) startOrdinal = seg.ordinal;
    if (seg.ordinal > endOrdinal) endOrdinal = seg.ordinal;
    const at = seg.atMs ?? 0;
    if (at > 0 && at < startedAtMs) startedAtMs = at;
    if (at > endedAtMs) endedAtMs = at;
  }
  return {
    startOrdinal: Number.isFinite(startOrdinal) ? startOrdinal : 0,
    endOrdinal,
    segmentCount: included.length,
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : 0,
    endedAtMs,
  };
}

/**
 * The JSON schema description embedded in the prompt. Kept in lockstep with
 * {@link import("./pendant-insights.js").PendantInsightsModelOutputSchema} — if
 * you add a model-owned field there, describe it here.
 */
export const INSIGHTS_OUTPUT_SCHEMA_HINT = `Return ONLY a JSON object (no prose, no code fences) with this exact shape:
{
  "summary": string,                    // 1-2 sentences. "" if nothing substantive was said.
  "actionItems": [                      // tasks/commitments/todos actually stated. [] if none.
    {
      "text": string,                   // the action, imperative and concrete
      "owner": string?,                 // who owns it, ONLY if clearly attributable
      "dueAt": string?,                 // ISO-8601, ONLY if a time was actually stated
      "confidence": number,             // 0..1 — how sure you are this is a real action item
      "sourceSegmentIds": string[]      // the [bracketed] segment ids this came from
    }
  ],
  "topics": [                           // salient themes. [] if the window is chit-chat.
    { "label": string, "salience": number, "sourceSegmentIds": string[] }
  ],
  "peopleMentioned": [                  // named people. [] if none named.
    { "name": string, "sourceSegmentIds": string[] }
  ],
  "notableQuotes": [                    // verbatim, memorable lines. [] if none stand out.
    { "text": string, "speaker": string?, "sourceSegmentIds": string[] }
  ]
}`;

export const DIGEST_OUTPUT_SCHEMA_HINT = `Return ONLY a JSON object (no prose, no code fences) with this exact shape:
{
  "summary": string,
  "summarySourceSegmentIds": string[],
  "actionItems": [
    {
      "text": string,
      "owner": string | null,
      "dueAt": string?,
      "confidence": number,
      "sourceSegmentIds": string[]
    }
  ],
  "digest": {
    "summary": string,
    "summarySourceSegmentIds": string[],
    "actionItems": [
      {
        "text": string,
        "owner": string | null,
        "dueAt": string?,
        "confidence": number,
        "sourceSegmentIds": string[]
      }
    ],
    "commitments": [
      {
        "text": string,
        "owner": string | null,
        "dueAt": string?,
        "confidence": number,
        "sourceSegmentIds": string[]
      }
    ],
    "followUps": [
      {
        "text": string,
        "owner": string | null,
        "dueAt": string?,
        "confidence": number,
        "sourceSegmentIds": string[]
      }
    ],
    "notableMoments": [
      { "text": string, "sourceSegmentIds": string[] }
    ]
  }
}`;

/**
 * The generation guardrails. These are the anti-fabrication + attribution rules
 * that keep the model from inventing action items or citing segments it never saw.
 */
export const INSIGHTS_GENERATION_RULES = [
  "Extract ONLY what is actually present in the transcript. Do NOT invent, infer beyond the text, or pad.",
  'If the window is small talk or has no substantive content, return empty arrays and an empty ("") summary. An empty result is correct and expected.',
  "Every sourceSegmentIds value MUST be a segment id that appears in [brackets] in the transcript above. Never cite an id you did not see.",
  "When returning a non-empty summary, include summarySourceSegmentIds from the transcript lines that ground it.",
  "Only set owner/dueAt when the transcript makes them explicit. Omit them otherwise — do not guess.",
  "Calibrate confidence honestly: a clearly-stated commitment is ~0.9; an ambiguous aside is ~0.3.",
  "notableQuotes must be VERBATIM substrings of the transcript, not paraphrases.",
]
  .map((r, i) => `${i + 1}. ${r}`)
  .join("\n");

/**
 * Build the full insight-generation prompt for a window of transcript segments.
 * Pure: returns the prompt text plus the audit trail (included ids + range) the
 * caller needs to stamp + evidence-filter the result. Feeds the model only the
 * segments that fit the char budget, newest-biased.
 */
export function buildInsightsPrompt(
  options: BuildInsightsPromptOptions,
): BuiltInsightsPrompt {
  const maxChars = options.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS;
  const { body, included } = renderTranscriptForPrompt(
    options.segments,
    maxChars,
  );
  const transcriptRange = computeTranscriptRange(included);
  const priorBlock = options.priorSummary?.trim()
    ? `Context from earlier in this session (for continuity only, do NOT re-report it):\n${options.priorSummary.trim()}\n\n`
    : "";

  const isDigest = options.kind === "digest";
  const schemaHint = isDigest
    ? DIGEST_OUTPUT_SCHEMA_HINT
    : INSIGHTS_OUTPUT_SCHEMA_HINT;
  const task = isDigest
    ? "You produce the end-of-day digest for one ambient session-day."
    : "You produce a structured rollup of what was discussed.";

  const prompt = `You are an ambient note-taker summarizing a wearable-pendant voice transcript. \
${task} You are precise and never fabricate.

${priorBlock}Transcript (each line is prefixed with its [segment-id]):
${body || "(no transcript content)"}

Rules:
${INSIGHTS_GENERATION_RULES}

${schemaHint}`;

  return {
    prompt,
    includedSegmentIds: included.map((s) => s.id),
    transcriptRange,
  };
}

/**
 * Convenience: derive an {@link InsightSourceSegment} from raw utterance text
 * using the deterministic id scheme. The scheduler uses this when it hasn't been
 * handed pre-built {@link import("./transcripts.js").TranscriptSegment}s.
 */
export function makeSourceSegment(args: {
  sessionId: string;
  ordinal: number;
  text: string;
  speakerId?: string | null;
  speakerLabel?: string;
  atMs?: number;
}): InsightSourceSegment {
  return {
    id: makePendantSegmentId(args.sessionId, args.ordinal, args.text),
    sessionId: args.sessionId,
    ordinal: args.ordinal,
    revision: 0,
    text: args.text,
    ...(args.speakerId !== undefined ? { speakerId: args.speakerId } : {}),
    ...(args.speakerLabel ? { speakerLabel: args.speakerLabel } : {}),
    ...(args.atMs ? { atMs: args.atMs } : {}),
  };
}

/** Re-export so callers get the version constant from the prompt module too. */
export { PENDANT_INSIGHTS_SCHEMA_VERSION };
