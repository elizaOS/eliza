/**
 * Pendant insights — the canonical, versioned contract for a periodic structured
 * rollup computed over accumulated pendant transcript segments (Phase 2 of the
 * eliza ambient-memory pendant).
 *
 * ONE shape, shared across every layer: the client scheduler that batches
 * transcript segments and requests a rollup, the agent route that generates it
 * via `runtime.useModel`, and the (Phase 1) UI that renders it later. Keeping the
 * shape here (pure, browser- + node-safe, zod-validated) means the insight model
 * is defined exactly once and the producer/consumer cannot drift.
 *
 * Design notes:
 * - Insights REFERENCE transcript segments by their stable {@link
 *   import("./transcripts.js").TranscriptSegment.id}, never by index, so a rollup
 *   stays valid as new segments append. `sourceSegmentIds` on each item is the
 *   evidence link back into the transcript.
 * - The wire schema is VERSIONED (`schemaVersion`). Parsers accept current v1
 *   records plus unversioned v1 records written before the discriminator was
 *   added, and fail closed (drop, not crash) on unknown explicit versions.
 * - Nothing here fabricates insights: an empty rollup (no action items, no
 *   topics) is a valid, first-class result. The generator is instructed to emit
 *   empties rather than speculate, and the schema permits them.
 */

import { z } from "zod";

/**
 * Current insight contract version. Bump when a field's meaning changes in a
 * backward-INCOMPATIBLE way; additive optional fields do NOT require a bump.
 */
export const PENDANT_INSIGHTS_SCHEMA_VERSION = 1 as const;

/** Confidence bounds shared by action items + topics (0 = guess, 1 = certain). */
export const INSIGHT_CONFIDENCE_MIN = 0;
export const INSIGHT_CONFIDENCE_MAX = 1;

// ---------------------------------------------------------------------------
// Deterministic segment IDs
// ---------------------------------------------------------------------------

/**
 * Prefix for pendant-derived segment IDs. Segment IDs are the join key between a
 * transcript segment and every insight that cites it, so they MUST be stable and
 * deterministic for a given (session, ordinal, text) — a re-run over the same
 * accumulated audio yields identical IDs, which makes dedupe + backward-compatible
 * merges possible.
 */
export const PENDANT_SEGMENT_ID_PREFIX = "pseg";

/**
 * Deterministic FNV-1a 32-bit hash (browser- + node-safe, no crypto dep). Used to
 * fold segment text into the segment id so two segments with the same ordinal but
 * different text never collide, while identical content re-hashes identically.
 */
export function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619, kept in 32-bit via Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  // >>> 0 coerces to unsigned; pad to 8 hex chars for a stable width.
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Build a deterministic, collision-resistant segment id from a session id, the
 * segment's ordinal within that session, and its text. Same inputs → same id, so
 * insight `sourceSegmentIds` stay valid across regenerations over the same window.
 *
 * Shape: `pseg_<session-label>_<session-hash>_<ordinal>_<text-hash>`.
 * The session hash prevents sanitized/truncated labels from colliding.
 */
export function makePendantSegmentId(
  sessionId: string,
  ordinal: number,
  text: string,
): string {
  const safeSession =
    sessionId.replace(/[^A-Za-z0-9]+/g, "").slice(0, 24) || "session";
  const safeOrdinal = Math.max(0, Math.floor(ordinal));
  return `${PENDANT_SEGMENT_ID_PREFIX}_${safeSession}_${fnv1a32(sessionId)}_${safeOrdinal}_${fnv1a32(text)}`;
}

/** True only for the deterministic pendant segment-id wire shape. */
export function isPendantSegmentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^pseg_[A-Za-z0-9]{1,24}_[0-9a-f]{8}_\d+_[0-9a-f]{8}$/.test(value)
  );
}

// ---------------------------------------------------------------------------
// Zod schemas (the wire contract)
// ---------------------------------------------------------------------------

/** A non-empty, trimmed string helper (drops whitespace-only values). */
const NonEmptyText = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1));

const Confidence = z
  .number()
  .min(INSIGHT_CONFIDENCE_MIN)
  .max(INSIGHT_CONFIDENCE_MAX);

/**
 * Segment ids evidencing an extracted item. Every item must cite at least one
 * segment; unknown citations are removed later and leave the item dropped.
 */
const SourceSegmentIds = z
  .array(NonEmptyText)
  .min(1)
  .transform((ids) => Array.from(new Set(ids)));

const IsoDateOrDateTime = NonEmptyText.refine(
  (value) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) ||
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ),
  "dueAt must be an ISO-8601 date or timezone-qualified date-time",
);

/** A single extracted action item / task / commitment heard in the transcript. */
export const ActionItemSchema = z
  .object({
    text: NonEmptyText,
    /** Who owns it, when attributable to a speaker/person; omitted if unknown. */
    owner: NonEmptyText.optional(),
    /** ISO-8601 due date/time when the transcript implies one; omitted otherwise. */
    dueAt: IsoDateOrDateTime.optional(),
    confidence: Confidence,
    sourceSegmentIds: SourceSegmentIds,
  })
  .strict();
export type ActionItem = z.infer<typeof ActionItemSchema>;

/** A salient topic/theme spanning one or more segments. */
export const InsightTopicSchema = z
  .object({
    label: NonEmptyText,
    /** How central this topic is to the window (0 = incidental, 1 = dominant). */
    salience: Confidence,
    sourceSegmentIds: SourceSegmentIds,
  })
  .strict();
export type InsightTopic = z.infer<typeof InsightTopicSchema>;

/** A person named/referenced in the window, with the segments that mention them. */
export const PersonMentionSchema = z
  .object({
    name: NonEmptyText,
    sourceSegmentIds: SourceSegmentIds,
  })
  .strict();
export type PersonMention = z.infer<typeof PersonMentionSchema>;

/** A verbatim, notable quote worth surfacing, attributed when possible. */
export const NotableQuoteSchema = z
  .object({
    text: NonEmptyText,
    speaker: NonEmptyText.optional(),
    sourceSegmentIds: SourceSegmentIds,
  })
  .strict();
export type NotableQuote = z.infer<typeof NotableQuoteSchema>;

/** The half-open segment range (by ordinal) this rollup was computed over. */
export const TranscriptRangeSchema = z
  .object({
    /** First segment ordinal included (inclusive). */
    startOrdinal: z.number().int().min(0),
    /** Last segment ordinal included (inclusive). */
    endOrdinal: z.number().int().min(0),
    /** Count of segments actually fed to the generator. */
    segmentCount: z.number().int().min(0),
    /** Epoch ms of the earliest included segment (0 if unknown). */
    startedAtMs: z.number().int().min(0).default(0),
    /** Epoch ms of the latest included segment (0 if unknown). */
    endedAtMs: z.number().int().min(0).default(0),
  })
  .strict()
  .superRefine((range, ctx) => {
    if (range.segmentCount > 0 && range.endOrdinal < range.startOrdinal) {
      ctx.addIssue({
        code: "custom",
        path: ["endOrdinal"],
        message: "endOrdinal must be >= startOrdinal for a non-empty range",
      });
    }
    if (
      range.startedAtMs > 0 &&
      range.endedAtMs > 0 &&
      range.endedAtMs < range.startedAtMs
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["endedAtMs"],
        message: "endedAtMs must be >= startedAtMs",
      });
    }
  });
export type TranscriptRange = z.infer<typeof TranscriptRangeSchema>;

/**
 * A full insight rollup. `schemaVersion` is pinned to the CURRENT version by the
 * schema (via a default + refinement) so a parsed rollup is always self-describing
 * and a future reader can branch on it. All list fields default to `[]` so a
 * minimal `{ summary }` model output still parses into a well-formed rollup.
 */
export const PendantInsightsSchema = z
  .object({
    schemaVersion: z
      .literal(PENDANT_INSIGHTS_SCHEMA_VERSION)
      .default(PENDANT_INSIGHTS_SCHEMA_VERSION),
    /** One or two sentence gist of the window. May be empty for a quiet window. */
    summary: z
      .string()
      .transform((s) => s.trim())
      .default(""),
    actionItems: z.array(ActionItemSchema).default([]),
    topics: z.array(InsightTopicSchema).default([]),
    peopleMentioned: z.array(PersonMentionSchema).default([]),
    notableQuotes: z.array(NotableQuoteSchema).default([]),
    /** Epoch ms when this rollup was generated. */
    generatedAt: z.number().int().min(0),
    transcriptRange: TranscriptRangeSchema,
  })
  .strict();
export type PendantInsights = z.infer<typeof PendantInsightsSchema>;

/**
 * The portion of a rollup the MODEL is responsible for producing. `generatedAt`,
 * `transcriptRange`, and `schemaVersion` are filled by the server (trusted
 * fields), so the model output schema omits them and defaults the versioned +
 * list fields. Parsing model output through THIS schema (not the full one) means
 * a model that forgets `generatedAt` isn't an error — the server owns that.
 */
export const PendantInsightsModelOutputSchema = z
  .object({
    summary: z
      .string()
      .transform((s) => s.trim())
      .default(""),
    actionItems: z.array(ActionItemSchema).default([]),
    topics: z.array(InsightTopicSchema).default([]),
    peopleMentioned: z.array(PersonMentionSchema).default([]),
    notableQuotes: z.array(NotableQuoteSchema).default([]),
  })
  // Non-strict: tolerate extra keys a chatty model appends, drop them silently.
  .passthrough()
  .transform((v) => ({
    summary: v.summary,
    actionItems: v.actionItems,
    topics: v.topics,
    peopleMentioned: v.peopleMentioned,
    notableQuotes: v.notableQuotes,
  }));
export type PendantInsightsModelOutput = z.infer<
  typeof PendantInsightsModelOutputSchema
>;

// ---------------------------------------------------------------------------
// Backward-compatible parsing
// ---------------------------------------------------------------------------

/** Discriminated parse result — never throws, always inspectable. */
export type ParseInsightsResult =
  | { ok: true; value: PendantInsights }
  | { ok: false; error: string };

/**
 * Parse an UNTRUSTED full rollup (e.g. a stored/transported record) fail-closed.
 * Unknown explicit `schemaVersion` values are rejected with a readable reason;
 * an absent version is treated as legacy v1 and stamped by the schema default.
 * Returns a
 * discriminated result so there's no try/catch at every call site.
 */
export function parsePendantInsights(input: unknown): ParseInsightsResult {
  if (
    input &&
    typeof input === "object" &&
    "schemaVersion" in input &&
    (input as { schemaVersion?: unknown }).schemaVersion !==
      PENDANT_INSIGHTS_SCHEMA_VERSION
  ) {
    return {
      ok: false,
      error: `unsupported pendant-insights schemaVersion: ${String(
        (input as { schemaVersion?: unknown }).schemaVersion,
      )} (expected ${PENDANT_INSIGHTS_SCHEMA_VERSION})`,
    };
  }
  const parsed = PendantInsightsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "invalid pendant insights",
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Parse raw MODEL output (a JSON string OR an already-parsed object) into the
 * model-owned slice, fail-closed. Handles the common "model wrapped JSON in prose
 * / code fences" case by extracting the first balanced `{...}` block. Returns a
 * discriminated result; the server then stamps `generatedAt` + `transcriptRange`.
 */
export function parsePendantInsightsModelOutput(
  raw: unknown,
):
  | { ok: true; value: PendantInsightsModelOutput }
  | { ok: false; error: string } {
  let candidate: unknown = raw;
  if (typeof raw === "string") {
    const extracted = extractFirstJsonObject(raw);
    if (extracted === null) {
      return { ok: false, error: "no JSON object found in model output" };
    }
    try {
      candidate = JSON.parse(extracted);
    } catch (err) {
      return {
        ok: false,
        error: `model output was not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }
  const parsed = PendantInsightsModelOutputSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "invalid model output shape",
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Extract the first balanced top-level `{...}` JSON object from a string that may
 * contain surrounding prose or markdown code fences. Returns null when none is
 * found. String-literal aware so a `}` inside a quoted value doesn't close early.
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Compose a full {@link PendantInsights} from validated model output + the
 * server-owned trusted fields. Filters `sourceSegmentIds` down to the ids that
 * were actually in the window (a model can't cite a segment it wasn't shown), so
 * evidence links are guaranteed resolvable. Pure — the server calls this.
 */
export function composePendantInsights(args: {
  model: PendantInsightsModelOutput;
  generatedAt: number;
  transcriptRange: z.input<typeof TranscriptRangeSchema>;
  /** The set of segment ids the model was shown (for evidence filtering). */
  knownSegmentIds: ReadonlySet<string>;
}): PendantInsights {
  const filterIds = (ids: string[]): string[] =>
    ids.filter((id) => args.knownSegmentIds.has(id));
  const grounded = <T extends { sourceSegmentIds: string[] }>(
    items: T[],
  ): T[] =>
    items
      .map((item) => ({
        ...item,
        sourceSegmentIds: filterIds(item.sourceSegmentIds),
      }))
      .filter((item) => item.sourceSegmentIds.length > 0) as T[];
  return {
    schemaVersion: PENDANT_INSIGHTS_SCHEMA_VERSION,
    summary: args.model.summary,
    actionItems: grounded(args.model.actionItems),
    topics: grounded(args.model.topics),
    peopleMentioned: grounded(args.model.peopleMentioned),
    notableQuotes: grounded(args.model.notableQuotes),
    generatedAt: args.generatedAt,
    transcriptRange: TranscriptRangeSchema.parse(args.transcriptRange),
  };
}

/** True when a rollup carries no substantive content (a legitimately quiet window). */
export function isEmptyInsights(insights: PendantInsights): boolean {
  return (
    insights.summary.length === 0 &&
    insights.actionItems.length === 0 &&
    insights.topics.length === 0 &&
    insights.peopleMentioned.length === 0 &&
    insights.notableQuotes.length === 0
  );
}
