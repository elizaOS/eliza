import { z } from "zod";

const permissionsSchema = z.array(z.string().trim().min(1)).max(50);

const optionalExpiresAtSchema = z
  .union([z.string().trim().min(1), z.null()])
  .optional()
  .refine(
    (value) => value === undefined || value === null || !Number.isNaN(Date.parse(value)),
    "expires_at must be a valid ISO date",
  )
  .transform((value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return new Date(value);
  });

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  description: z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => {
      if (value == null) return null;
      const trimmed = value.trim();
      return trimmed.length ? trimmed : null;
    }),
  permissions: permissionsSchema.default([]),
  rate_limit: z.coerce.number().int().min(1).max(100000).default(1000),
  expires_at: optionalExpiresAtSchema,
});

export const updateApiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z
      .union([z.string(), z.null()])
      .optional()
      .transform((value) => {
        if (value === undefined) return undefined;
        if (value === null) return null;
        const trimmed = value.trim();
        return trimmed.length ? trimmed : null;
      }),
    permissions: permissionsSchema.optional(),
    rate_limit: z.coerce.number().int().min(1).max(100000).optional(),
    is_active: z.boolean().optional(),
    expires_at: optionalExpiresAtSchema,
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "At least one field is required",
  });
