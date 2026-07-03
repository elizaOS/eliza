import { z } from "zod";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { pressReleaseService } from "@/lib/services/press-releases";
import type { AppContext } from "@/types/cloud-worker-env";

export const PressReleaseAssetSchema = z.object({
  url: z.string().url(),
  mimeType: z.string().min(1).max(200).optional(),
  label: z.string().min(1).max(120).optional(),
});

export const PressReleaseAudienceSchema = z
  .object({
    niches: z.array(z.string().min(1).max(80)).max(50).optional(),
    regions: z.array(z.string().min(1).max(80)).max(50).optional(),
    languages: z.array(z.string().min(1).max(40)).max(50).optional(),
    outletTypes: z.array(z.string().min(1).max(80)).max(50).optional(),
  })
  .strict();

export const PressReleaseDraftSchema = z.object({
  title: z.string().min(1).max(240),
  body: z.string().min(1).max(50_000),
  summary: z.string().max(2000).optional(),
  boilerplate: z.string().max(4000).optional(),
  targetAudience: PressReleaseAudienceSchema.optional(),
  targetRegions: z.array(z.string().min(1).max(80)).max(50).optional(),
  assets: z.array(PressReleaseAssetSchema).max(50).optional(),
  embargoAt: z.string().datetime().nullable().optional(),
  idempotencyKey: z.string().min(8).max(255).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const PressReleaseUpdateSchema = PressReleaseDraftSchema.omit({
  idempotencyKey: true,
})
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });

export function invalidRequest(c: AppContext, details: unknown) {
  return c.json(
    {
      success: false,
      error: "Invalid request",
      details,
    },
    400,
  );
}

export function parseOptionalDate(
  value: string | null | undefined,
): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return new Date(value);
}

export async function authenticatedOrg(c: AppContext) {
  const user = await requireUserOrApiKeyWithOrg(c);
  return {
    userId: user.id,
    organizationId: user.organization_id,
  };
}

export async function loadPressReleaseForOrg(c: AppContext) {
  const auth = await authenticatedOrg(c);
  const releaseId = c.req.param("releaseId");
  if (!releaseId) {
    return {
      auth,
      error: c.json({ success: false, error: "Missing release id" }, 400),
    };
  }
  if (!z.string().uuid().safeParse(releaseId).success) {
    return {
      auth,
      releaseId,
      error: c.json({ success: false, error: "Invalid release id" }, 400),
    };
  }
  const release = await pressReleaseService.getRelease(
    releaseId,
    auth.organizationId,
  );
  if (!release) {
    return {
      auth,
      releaseId,
      error: c.json({ success: false, error: "Press release not found" }, 404),
    };
  }
  return { auth, releaseId, release };
}

export function configuredPressProvider(c: AppContext): string | null {
  const env = c.env as Record<string, unknown>;
  for (const key of [
    "ELIZA_PR_DISTRIBUTION_PROVIDER",
    "ELIZA_NEWSWIRE_PROVIDER",
  ]) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}
