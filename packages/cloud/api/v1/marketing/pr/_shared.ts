/**
 * Shared validation + helpers for the `/api/v1/marketing/pr/*` route group
 * (#11819). Not a route leaf (no `hono` import), so the router codegen skips it.
 *
 * These routes are the real API entry points for the press-release workflow
 * whose domain model + service live in `@elizaos/cloud-shared` (#11818). The
 * routes only validate input, enforce org scoping via the authed user, and
 * delegate every state transition to `pressReleaseService` — no business logic
 * lives here.
 */

import { z } from "zod";
import type {
  PressReleaseAsset,
  PressReleaseTargetAudience,
} from "@/db/schemas/press-releases";

const assetSchema = z.object({
  url: z.string().trim().url(),
  mimeType: z.string().trim().max(128).optional(),
  label: z.string().trim().max(200).optional(),
});

const targetAudienceSchema = z.object({
  niches: z.array(z.string().trim().min(1)).max(100).optional(),
  regions: z.array(z.string().trim().min(1)).max(100).optional(),
  languages: z.array(z.string().trim().min(1)).max(100).optional(),
  outletTypes: z.array(z.string().trim().min(1)).max(100).optional(),
});

export const createReleaseSchema = z.object({
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(50_000),
  summary: z.string().trim().max(2_000).optional(),
  boilerplate: z.string().trim().max(8_000).optional(),
  targetAudience: targetAudienceSchema.optional(),
  targetRegions: z.array(z.string().trim().min(1)).max(200).optional(),
  assets: z.array(assetSchema).max(50).optional(),
  embargoAt: z.string().datetime().optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const updateReleaseSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(50_000),
    summary: z.string().trim().max(2_000).nullable(),
    boilerplate: z.string().trim().max(8_000).nullable(),
    targetAudience: targetAudienceSchema,
    targetRegions: z.array(z.string().trim().min(1)).max(200),
    assets: z.array(assetSchema).max(50),
    embargoAt: z.string().datetime().nullable(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .partial();

export type CreateReleaseInput = z.infer<typeof createReleaseSchema>;
export type UpdateReleaseInput = z.infer<typeof updateReleaseSchema>;

/**
 * Map a domain-service failure string to an HTTP status. The service returns a
 * small, stable set of failure strings; keeping the mapping here makes every
 * route answer consistently (validation → 400, missing → 404, state/idempotency
 * conflict → 409).
 */
export function pressReleaseErrorStatus(error: string): 400 | 404 | 409 {
  const lowered = error.toLowerCase();
  if (lowered.includes("not found")) return 404;
  if (
    lowered.includes("already used") ||
    lowered.includes("not editable") ||
    lowered.includes("not ready") ||
    lowered.includes("changed state") ||
    lowered.includes("cannot be cancelled")
  ) {
    return 409;
  }
  return 400;
}

/**
 * Resolve the configured newswire provider. No provider binding is declared yet
 * (choosing one is the #11362 human dependency), so this is always `null` today
 * and the submit route fails closed with a 503 rather than fake a distribution.
 * When a provider is wired, it sets `NEWSWIRE_PROVIDER` and submit unlocks.
 */
export function resolveNewswireProvider(env: unknown): string | null {
  if (!env || typeof env !== "object") return null;
  const raw = (env as Record<string, unknown>).NEWSWIRE_PROVIDER;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export type { PressReleaseAsset, PressReleaseTargetAudience };
