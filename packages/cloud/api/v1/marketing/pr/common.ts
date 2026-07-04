import { z } from "zod";

export const PressReleaseAssetSchema = z.object({
  url: z.string().min(1).max(2048),
  mimeType: z.string().min(1).max(120).optional(),
  label: z.string().min(1).max(160).optional(),
});

export const PressReleaseTargetAudienceSchema = z
  .object({
    niches: z.array(z.string().min(1).max(120)).max(50).optional(),
    regions: z.array(z.string().min(1).max(80)).max(50).optional(),
    languages: z.array(z.string().min(1).max(40)).max(50).optional(),
    outletTypes: z.array(z.string().min(1).max(80)).max(50).optional(),
  })
  .strict();

const MetadataSchema = z.record(z.string(), z.unknown());

export const CreatePressReleaseSchema = z.object({
  title: z.string().min(1).max(240),
  body: z.string().min(1).max(50_000),
  summary: z.string().max(2000).optional(),
  boilerplate: z.string().max(5000).optional(),
  targetAudience: PressReleaseTargetAudienceSchema.optional(),
  targetRegions: z.array(z.string().min(1).max(80)).max(100).optional(),
  assets: z.array(PressReleaseAssetSchema).max(50).optional(),
  embargoAt: z.string().min(1).max(80).nullable().optional(),
  idempotencyKey: z.string().min(1).max(160).optional(),
  metadata: MetadataSchema.optional(),
});

export const UpdatePressReleaseSchema = CreatePressReleaseSchema.omit({
  idempotencyKey: true,
})
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });

export type CreatePressReleasePayload = z.infer<
  typeof CreatePressReleaseSchema
>;
export type UpdatePressReleasePayload = z.infer<
  typeof UpdatePressReleaseSchema
>;

export function dateFromPayload(
  value: string | null | undefined,
): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return new Date(value);
}

export function statusForPressReleaseError(
  error: string | undefined,
): 400 | 404 | 409 {
  if (error === "Idempotency key already used") return 409;
  if (error?.toLowerCase().includes("not found")) return 404;
  return 400;
}

export function invalidRequestBody(details: unknown) {
  return {
    success: false,
    error: "Invalid request",
    details,
  };
}

export const providerNotConfiguredResponse = {
  success: false,
  error: "Press distribution provider is not configured",
  code: "PR_PROVIDER_NOT_CONFIGURED",
};
