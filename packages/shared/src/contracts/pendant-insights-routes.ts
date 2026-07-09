/**
 * Wire contract for `POST /api/pendant/insights`.
 *
 * The request carries an explicit per-call opt-in assertion. The route never
 * accepts transcript text without it. The response is also schema-validated on
 * the client, so a malformed or newer server payload fails closed.
 */

import { z } from "zod";
import {
  makePendantSegmentId,
  PENDANT_SAFE_SESSION_ID_PATTERN,
  PendantInsightsSchema,
} from "../pendant-insights.js";

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
  })
  .strict();
export type PendantInsightSegmentInput = z.infer<
  typeof PendantInsightSegmentInputSchema
>;

/** Hard ceiling on one request, independent of the prompt character budget. */
export const MAX_INSIGHT_SEGMENTS_PER_REQUEST = 200;
/** Server and default scheduler threshold. */
export const MIN_INSIGHT_SEGMENTS = 3;

export const PostPendantInsightsRequestSchema = z
  .object({
    /** Explicit privacy assertion. Missing/false requests are rejected. */
    enabled: z.literal(true),
    /** Canonical server-authoritative session owning every source segment. */
    sessionId: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .regex(PENDANT_SAFE_SESSION_ID_PATTERN, "sessionId must be prompt-safe"),
    segments: z
      .array(PendantInsightSegmentInputSchema)
      .min(1)
      .max(MAX_INSIGHT_SEGMENTS_PER_REQUEST),
    priorSummary: z.string().trim().max(4000).optional(),
    maxTranscriptChars: z.number().int().min(500).max(40_000).optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
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
    sourceSegments: z.array(PendantInsightSourceRefSchema).min(1),
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
