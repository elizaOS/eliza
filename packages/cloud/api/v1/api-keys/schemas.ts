// Handles v1 cloud API v1 api keys schemas route traffic with route-local auth expectations.
import { z } from "zod";

const MIN_API_KEY_RATE_LIMIT = 1;
const MAX_API_KEY_RATE_LIMIT = 100000;
const DEFAULT_API_KEY_RATE_LIMIT = 1000;

/**
 * POST/PATCH /api/v1/api-keys `rate_limit` is key-quota identity, leftover
 * tax after earnings-history / mcps list `limit`. Stock develop used
 * z.coerce.number(), which treated string `1e2` / `007` / `0x10` as a
 * quota instead of a 400. name / description / expires_at / is_active
 * stay untouched. Missing on create still means 1000. Exact integers
 * above 100000 stay 400.
 */
function parseApiKeyRateLimit(raw: unknown): number {
  if (typeof raw === "number") {
    if (
      !Number.isSafeInteger(raw) ||
      raw < MIN_API_KEY_RATE_LIMIT ||
      raw > MAX_API_KEY_RATE_LIMIT
    ) {
      throw new Error("Invalid rate_limit");
    }
    return raw;
  }
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) {
    throw new Error("Invalid rate_limit");
  }
  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_API_KEY_RATE_LIMIT ||
    parsed > MAX_API_KEY_RATE_LIMIT
  ) {
    throw new Error("Invalid rate_limit");
  }
  return parsed;
}

const rateLimitSchema = z.custom<number>((value) => {
  try {
    parseApiKeyRateLimit(value);
    return true;
  } catch {
    return false;
  }
}, "Invalid rate_limit").transform((value) => parseApiKeyRateLimit(value));

const optionalExpiresAtSchema = z
  .union([z.string().trim().min(1), z.null()])
  .optional()
  .refine(
    (value) =>
      value === undefined || value === null || !Number.isNaN(Date.parse(value)),
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
  rate_limit: rateLimitSchema.optional().default(DEFAULT_API_KEY_RATE_LIMIT),
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
    rate_limit: rateLimitSchema.optional(),
    is_active: z.boolean().optional(),
    expires_at: optionalExpiresAtSchema,
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    {
      message: "At least one field is required",
    },
  );
