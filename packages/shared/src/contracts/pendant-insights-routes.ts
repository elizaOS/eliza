/**
 * Wire contract for `POST /api/pendant/insights`.
 *
 * The request carries an explicit per-call opt-in assertion. The route never
 * accepts transcript text without it. The response is also schema-validated on
 * the client, so a malformed or newer server payload fails closed.
 */

import { z } from "zod";
import {
  AMBIENT_INSIGHT_DEFAULT_DAILY_CALL_CAP,
  AMBIENT_INSIGHT_DEFAULT_MIN_INTERVAL_MS,
  AMBIENT_INSIGHT_DEFAULT_MIN_SEGMENTS,
  makePendantSegmentId,
  PENDANT_SAFE_SESSION_ID_PATTERN,
  PendantInsightsSchema,
} from "../pendant-insights.js";

export const PendantInsightsModeSchema = z.enum(["conversation", "ambient"]);
export type PendantInsightsMode = z.infer<typeof PendantInsightsModeSchema>;

export const PendantInsightsKindSchema = z.enum(["rollup", "digest"]);
export type PendantInsightsKind = z.infer<typeof PendantInsightsKindSchema>;

export const PendantInsightSegmentStatusSchema = z.enum([
  "eager",
  "pending",
  "partial",
  "finalized",
]);
export type PendantInsightSegmentStatus = z.infer<
  typeof PendantInsightSegmentStatusSchema
>;

/** One segment of the rolling window the client asks the agent to summarize. */
export const PendantInsightSegmentInputSchema = z
  .object({
    id: z.string().trim().min(1).max(400),
    sessionId: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .regex(PENDANT_SAFE_SESSION_ID_PATTERN, "sessionId must be prompt-safe"),
    ordinal: z.number().int().min(0),
    /** Session-sync revision for late ASR/diarization patches. */
    revision: z.number().int().min(0).optional(),
    text: z.string().trim().min(1).max(3_000),
    /** Anonymous/session-local speaker cluster id. Null means unknown. */
    speakerId: z.string().trim().min(1).max(200).nullable().optional(),
    speakerLabel: z.string().trim().min(1).max(200).optional(),
    atMs: z.number().int().min(0).optional(),
    /**
     * Ambient mode consumes only finalized canonical segments. This is optional
     * so the existing conversation pendant scheduler keeps its current request
     * shape and behavior.
     */
    status: PendantInsightSegmentStatusSchema.optional(),
  })
  .strict();
export type PendantInsightSegmentInput = z.infer<
  typeof PendantInsightSegmentInputSchema
>;

/** Conversation/rolling-window ceiling, independent of prompt character budget. */
export const MAX_INSIGHT_SEGMENTS_PER_REQUEST = 200;
/** Bounded all-day input ceiling. The server chunks this before model calls. */
export const MAX_AMBIENT_DIGEST_SEGMENTS_PER_REQUEST = 2_000;
/** Server and default scheduler threshold. */
export const MIN_INSIGHT_SEGMENTS = 3;

export const AmbientInsightsConfigSchema = z
  .object({
    minSegments: z
      .number()
      .int()
      .min(1)
      .max(MAX_INSIGHT_SEGMENTS_PER_REQUEST)
      .default(AMBIENT_INSIGHT_DEFAULT_MIN_SEGMENTS),
    minIntervalMs: z
      .number()
      .int()
      .min(0)
      .max(24 * 60 * 60 * 1000)
      .default(AMBIENT_INSIGHT_DEFAULT_MIN_INTERVAL_MS),
    dailyCallCap: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(AMBIENT_INSIGHT_DEFAULT_DAILY_CALL_CAP),
    contextTailSegments: z
      .number()
      .int()
      .min(0)
      .max(MAX_INSIGHT_SEGMENTS_PER_REQUEST)
      .default(24),
  })
  .strict()
  .prefault({});
export type AmbientInsightsConfig = z.infer<typeof AmbientInsightsConfigSchema>;

export const PostPendantInsightsRequestSchema = z
  .object({
    /** Explicit privacy assertion. Missing/false requests are rejected. */
    enabled: z.literal(true),
    /**
     * Ambient is strictly opt-in. Missing mode preserves the original pendant
     * behavior, including the lower conversation threshold.
     */
    mode: PendantInsightsModeSchema.default("conversation"),
    /** `digest` reuses this route/store but stamps one end-of-day record. */
    kind: PendantInsightsKindSchema.default("rollup"),
    /** Canonical server-authoritative session owning every source segment. */
    sessionId: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .regex(PENDANT_SAFE_SESSION_ID_PATTERN, "sessionId must be prompt-safe"),
    segments: z
      .array(PendantInsightSegmentInputSchema)
      .min(0)
      .max(MAX_AMBIENT_DIGEST_SEGMENTS_PER_REQUEST),
    priorSummary: z.string().trim().max(4000).optional(),
    maxTranscriptChars: z.number().int().min(500).max(40_000).optional(),
    ambient: AmbientInsightsConfigSchema.optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (
      (request.mode === "conversation" || request.kind === "rollup") &&
      request.segments.length > MAX_INSIGHT_SEGMENTS_PER_REQUEST
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["segments"],
        message: `rollup insight requests accept at most ${MAX_INSIGHT_SEGMENTS_PER_REQUEST} segments`,
      });
    }
    if (request.mode === "conversation" && request.segments.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["segments"],
        message: "conversation insight requests require at least one segment",
      });
    }
    if (request.kind === "digest" && request.mode !== "ambient") {
      ctx.addIssue({
        code: "custom",
        path: ["kind"],
        message: "digest generation is only available in ambient mode",
      });
    }
    const ids = new Set<string>();
    for (let index = 0; index < request.segments.length; index++) {
      const segment = request.segments[index];
      if (segment.sessionId !== request.sessionId) {
        ctx.addIssue({
          code: "custom",
          path: ["segments", index, "sessionId"],
          message: "segment sessionId must match request sessionId",
        });
      }
      if (
        PENDANT_SAFE_SESSION_ID_PATTERN.test(request.sessionId) &&
        segment.id !== makePendantSegmentId(request.sessionId, segment.ordinal)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["segments", index, "id"],
          message: "segment id must match the canonical session-sync id",
        });
      }
      if (ids.has(segment.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["segments", index, "id"],
          message: "duplicate segment id",
        });
      }
      ids.add(segment.id);
    }
  });
export type PostPendantInsightsRequest = z.infer<
  typeof PostPendantInsightsRequestSchema
>;

export const PendantInsightsSkipReasonSchema = z.enum([
  "too-few-segments",
  "empty-transcript",
  "runtime-unavailable",
  "cancelled",
  "no-new-finalized-segments",
  "budget-exhausted",
  "digest-already-generated",
]);
export type PendantInsightsSkipReason = z.infer<
  typeof PendantInsightsSkipReasonSchema
>;

export const PendantInsightSourceRefSchema = z
  .object({
    id: z.string().trim().min(1),
    ordinal: z.number().int().min(0),
    revision: z.number().int().min(0),
  })
  .strict();
export type PendantInsightSourceRef = z.infer<
  typeof PendantInsightSourceRefSchema
>;

/** Server-stamped lineage for the generated rollup and persisted memory. */
export const PendantInsightsProvenanceSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    agentId: z.string().trim().min(1),
    memoryId: z.string().trim().min(1).nullable(),
    sourceSegments: z.array(PendantInsightSourceRefSchema),
  })
  .strict();
export type PendantInsightsProvenance = z.infer<
  typeof PendantInsightsProvenanceSchema
>;

export const PostPendantInsightsSuccessSchema = z
  .object({
    ok: z.literal(true),
    insights: PendantInsightsSchema,
    provenance: PendantInsightsProvenanceSchema,
  })
  .strict();
export const PostPendantInsightsSkipSchema = z
  .object({
    ok: z.literal(false),
    reason: PendantInsightsSkipReasonSchema,
  })
  .strict();
export const PostPendantInsightsResponseSchema = z.discriminatedUnion("ok", [
  PostPendantInsightsSuccessSchema,
  PostPendantInsightsSkipSchema,
]);
export type PostPendantInsightsResponse = z.infer<
  typeof PostPendantInsightsResponseSchema
>;
