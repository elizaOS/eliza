/**
 * Wire contract for `POST /api/pendant/insights`.
 *
 * The request carries an explicit per-call opt-in assertion. The route never
 * accepts transcript text without it. The response is also schema-validated on
 * the client, so a malformed or newer server payload fails closed.
 */

import { z } from "zod";
import { PendantInsightsSchema } from "../pendant-insights.js";

/** One segment of the rolling window the client asks the agent to summarize. */
export const PendantInsightSegmentInputSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    ordinal: z.number().int().min(0),
    text: z.string().trim().min(1).max(3_000),
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
    segments: z
      .array(PendantInsightSegmentInputSchema)
      .min(1)
      .max(MAX_INSIGHT_SEGMENTS_PER_REQUEST),
    priorSummary: z.string().trim().max(4000).optional(),
    maxTranscriptChars: z.number().int().min(500).max(40_000).optional(),
  })
  .strict();
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

export const PostPendantInsightsSuccessSchema = z
  .object({ ok: z.literal(true), insights: PendantInsightsSchema })
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
