/**
 * Browser-safe contract for the server-authoritative pendant session log.
 *
 * The server owns identity, ordering, leases, and revision convergence. Clients
 * may cache these shapes, but every mutation round-trips through the route
 * schemas here so follower, capturer, and export paths agree on one wire format.
 */

import z from "zod";

export const PENDANT_SESSION_SYNC_API_PREFIX = "/api/pendant/sessions";
export const PENDANT_SESSION_SYNC_SCHEMA_VERSION = 1 as const;

export const PendantSessionStateSchema = z.enum(["active", "paused", "ended"]);
export type PendantSessionState = z.infer<typeof PendantSessionStateSchema>;

export const PendantProcessingLocationSchema = z.enum(["on-device", "cloud"]);
export type PendantProcessingLocation = z.infer<
  typeof PendantProcessingLocationSchema
>;

export const PendantSegmentStatusSchema = z.enum([
  "pending",
  "resolved",
  "asr-error",
]);
export type PendantSegmentStatus = z.infer<typeof PendantSegmentStatusSchema>;

export const PendantSessionErrorCodeSchema = z.enum([
  "auth",
  "lease_conflict",
  "revision_conflict",
  "validation",
  "store_unavailable",
  "not_found",
]);
export type PendantSessionErrorCode = z.infer<
  typeof PendantSessionErrorCodeSchema
>;

export const PendantCaptureLeasePublicSchema = z
  .object({
    holder: z.string().min(1),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type PendantCaptureLeasePublic = z.infer<
  typeof PendantCaptureLeasePublicSchema
>;

export const PendantWordTimingSchema = z
  .object({
    word: z.string().min(1),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    confidence: z.number().min(0).max(1).nullable().optional(),
  })
  .strict()
  .refine((value) => value.endMs >= value.startMs, {
    message: "endMs must be greater than or equal to startMs",
    path: ["endMs"],
  });
export type PendantWordTiming = z.infer<typeof PendantWordTimingSchema>;

export const PendantSegmentSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    status: PendantSegmentStatusSchema,
    text: z.string(),
    words: z.array(PendantWordTimingSchema),
    speakerCluster: z.string().min(1).nullable(),
    speakerAlias: z.string().min(1).nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    error: z.string().min(1).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().nullable(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type PendantSegment = z.infer<typeof PendantSegmentSchema>;

export const PendantInsightRefSchema = z
  .object({
    id: z.string().min(1),
    segmentIds: z.array(z.string().min(1)).min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type PendantInsightRef = z.infer<typeof PendantInsightRefSchema>;

export const PendantSessionSchema = z
  .object({
    id: z.string().min(1),
    ownerId: z.string().min(1),
    agentId: z.string().min(1),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().nullable(),
    state: PendantSessionStateSchema,
    captureLease: PendantCaptureLeasePublicSchema.nullable(),
    processingLocation: PendantProcessingLocationSchema,
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type PendantSession = z.infer<typeof PendantSessionSchema>;

export const PendantSessionSnapshotSchema = z
  .object({
    schemaVersion: z.literal(PENDANT_SESSION_SYNC_SCHEMA_VERSION),
    session: PendantSessionSchema,
    segments: z.array(PendantSegmentSchema),
    insightRefs: z.array(PendantInsightRefSchema),
  })
  .strict();
export type PendantSessionSnapshot = z.infer<
  typeof PendantSessionSnapshotSchema
>;

export const PendantSessionErrorResponseSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: PendantSessionErrorCodeSchema,
        message: z.string().min(1),
        currentRevision: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();
export type PendantSessionErrorResponse = z.infer<
  typeof PendantSessionErrorResponseSchema
>;

export const CreatePendantSessionRequestSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    processingLocation: PendantProcessingLocationSchema.default("on-device"),
  })
  .strict();
export type CreatePendantSessionRequest = z.infer<
  typeof CreatePendantSessionRequestSchema
>;

export const AcquirePendantLeaseRequestSchema = z
  .object({
    holder: z.string().min(1),
    leaseToken: z.string().min(1).optional(),
    leaseMs: z
      .number()
      .int()
      .positive()
      .max(5 * 60_000)
      .default(30_000),
  })
  .strict();
export type AcquirePendantLeaseRequest = z.infer<
  typeof AcquirePendantLeaseRequestSchema
>;

export const PendantLeaseResponseSchema = z
  .object({
    ok: z.literal(true),
    session: PendantSessionSchema,
    leaseToken: z.string().min(1),
  })
  .strict();
export type PendantLeaseResponse = z.infer<typeof PendantLeaseResponseSchema>;

export const UpsertPendantSegmentRequestSchema = z
  .object({
    leaseToken: z.string().min(1),
    segment: PendantSegmentSchema.omit({
      id: true,
      sessionId: true,
      createdAt: true,
      updatedAt: true,
    }),
  })
  .strict();
export type UpsertPendantSegmentRequest = z.infer<
  typeof UpsertPendantSegmentRequestSchema
>;

export const PatchPendantSegmentRequestSchema = z
  .object({
    leaseToken: z.string().min(1),
    revision: z.number().int().nonnegative(),
    status: PendantSegmentStatusSchema.optional(),
    text: z.string().optional(),
    words: z.array(PendantWordTimingSchema).optional(),
    speakerCluster: z.string().min(1).nullable().optional(),
    speakerAlias: z.string().min(1).nullable().optional(),
    confidence: z.number().min(0).max(1).nullable().optional(),
    error: z.string().min(1).nullable().optional(),
    startedAt: z.string().datetime().optional(),
    endedAt: z.string().datetime().nullable().optional(),
  })
  .strict();
export type PatchPendantSegmentRequest = z.infer<
  typeof PatchPendantSegmentRequestSchema
>;

export const PendantControlRequestSchema = z
  .object({
    revision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type PendantControlRequest = z.infer<typeof PendantControlRequestSchema>;

export const UpsertPendantInsightRefsRequestSchema = z
  .object({
    revision: z.number().int().nonnegative().optional(),
    insightRefs: z.array(PendantInsightRefSchema),
  })
  .strict();
export type UpsertPendantInsightRefsRequest = z.infer<
  typeof UpsertPendantInsightRefsRequestSchema
>;

export const PollPendantSessionResponseSchema = z.discriminatedUnion(
  "changed",
  [
    z.object({ ok: z.literal(true), changed: z.literal(false) }).strict(),
    z
      .object({
        ok: z.literal(true),
        changed: z.literal(true),
        snapshot: PendantSessionSnapshotSchema,
      })
      .strict(),
  ],
);
export type PollPendantSessionResponse = z.infer<
  typeof PollPendantSessionResponseSchema
>;

export const PendantSnapshotResponseSchema = z
  .object({
    ok: z.literal(true),
    snapshot: PendantSessionSnapshotSchema,
  })
  .strict();
export type PendantSnapshotResponse = z.infer<
  typeof PendantSnapshotResponseSchema
>;

export const PendantMutationResponseSchema = z
  .object({
    ok: z.literal(true),
    snapshot: PendantSessionSnapshotSchema,
  })
  .strict();
export type PendantMutationResponse = z.infer<
  typeof PendantMutationResponseSchema
>;

export const PendantDeleteResponseSchema = z
  .object({
    ok: z.literal(true),
    deleted: z.literal(true),
  })
  .strict();
export type PendantDeleteResponse = z.infer<typeof PendantDeleteResponseSchema>;

export const PendantExportResponseSchema = z
  .object({
    ok: z.literal(true),
    export: PendantSessionSnapshotSchema,
  })
  .strict();
export type PendantExportResponse = z.infer<typeof PendantExportResponseSchema>;

export function pendantSegmentId(sessionId: string, ordinal: number): string {
  return `${sessionId}:segment:${ordinal}`;
}
