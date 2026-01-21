/**
 * Game and utility validation schemas
 */

import { z } from "zod";
import { UserIdSchema } from "./common";

/**
 * Game tick cron authentication schema
 */
export const GameTickCronSchema = z.object({
  authorization: z
    .string()
    .regex(/^Bearer .+$/, "Authorization must be Bearer token"),
});

/**
 * Image upload schema (for multipart form data)
 */
export const ImageUploadSchema = z.object({
  file: z
    .object({
      size: z
        .number()
        .positive()
        .max(10 * 1024 * 1024), // 10MB max
      type: z
        .string()
        .refine(
          (type) =>
            [
              "image/jpeg",
              "image/png",
              "image/webp",
              "image/gif",
              "image/jpg",
            ].includes(type),
          { message: "Invalid file type. Allowed: jpeg, png, webp, gif" },
        ),
    })
    .nullable(),
  type: z.enum(["profile", "cover", "post"]).optional(),
});

/**
 * Image upload body schema (for base64)
 */
export const ImageUploadBodySchema = z.object({
  image: z.string().min(1), // Base64 encoded image
  filename: z.string().optional(),
  contentType: z
    .string()
    .regex(/^image\/(jpeg|jpg|png|gif|webp)$/)
    .default("image/jpeg"),
});

/**
 * Registry query schema
 */
export const RegistryQuerySchema = z.object({
  onChainOnly: z.coerce.boolean().optional(),
  sortBy: z.enum(["username", "createdAt", "nftTokenId"]).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().positive().max(100).default(100),
  offset: z.coerce.number().nonnegative().default(0),
});

/**
 * Award points schema
 */
export const AwardPointsSchema = z.object({
  userId: UserIdSchema,
  points: z.number().int().min(-1000000).max(1000000),
  reason: z.enum([
    "profile_completion",
    "profile_image",
    "username",
    "social_connect",
    "wallet_connect",
    "referral",
    "trade",
    "achievement",
    "bonus",
    "penalty",
  ]),
  description: z.string().max(500).optional(),
});

/**
 * Referral query schema
 */
export const ReferralQuerySchema = z.object({
  userId: UserIdSchema,
  includeStats: z.coerce.boolean().default(false),
});

/**
 * Link social account schema
 */
export const LinkSocialAccountSchema = z.object({
  platform: z.enum(["twitter", "farcaster"]),
  username: z.string().min(1).max(50),
  verificationToken: z.string().optional(),
});

/**
 * Update visibility schema
 */
export const UpdateVisibilitySchema = z.object({
  showTwitterPublic: z.boolean().optional(),
  showFarcasterPublic: z.boolean().optional(),
  showWalletPublic: z.boolean().optional(),
});

/**
 * Share count schema
 */
export const ShareCountSchema = z.object({
  shareCount: z.number().int().nonnegative().default(1),
});

/**
 * Username param schema
 */
export const UsernameParamSchema = z.object({
  username: z.string().min(1).max(30),
});

/**
 * User ID param schema (accepts both UUID and Privy DID)
 * Uses UserIdSchema from common for consistency
 */
export const UserIdParamSchema = z.object({
  userId: UserIdSchema,
});

/**
 * Breaking news query schema
 */
export const BreakingNewsQuerySchema = z.object({
  limit: z.coerce.number().positive().max(20).default(5),
  category: z.string().optional(),
});

/**
 * Upcoming events query schema
 */
export const UpcomingEventsQuerySchema = z.object({
  limit: z.coerce.number().positive().max(50).default(10),
  timeframe: z.enum(["24h", "7d", "30d"]).default("7d"),
});

/**
 * Trending posts query schema
 */
export const TrendingPostsQuerySchema = z.object({
  limit: z.coerce.number().positive().max(50).default(10),
  timeframe: z
    .string()
    .transform((val): "1h" | "6h" | "24h" | "7d" => {
      const validTimeframes: readonly ["1h", "6h", "24h", "7d"] = [
        "1h",
        "6h",
        "24h",
        "7d",
      ];
      return (validTimeframes as readonly string[]).includes(val)
        ? (val as "1h" | "6h" | "24h" | "7d")
        : "24h"; // Default to 24h for invalid values
    })
    .default("24h"),
  minInteractions: z.coerce.number().nonnegative().default(5),
});

/**
 * Stats query schema
 */
export const StatsQuerySchema = z.object({
  includeMarkets: z.coerce.boolean().default(true),
  includeUsers: z.coerce.boolean().default(true),
  includePools: z.coerce.boolean().default(true),
  includeVolume: z.coerce.boolean().default(true),
});
