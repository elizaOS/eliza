/**
 * User-related validation schemas
 */

import { z } from "zod";
import {
  createTrimmedStringSchema,
  EmailSchema,
  PaginationSchema,
  SnowflakeIdSchema,
  URLSchema,
  UsernameSchema,
  WalletAddressSchema,
} from "./common";

/**
 * Create user schema for registration
 */
export const CreateUserSchema = z
  .object({
    walletAddress: WalletAddressSchema.optional(),
    email: EmailSchema.optional(),
    username: UsernameSchema.optional(),
    displayName: createTrimmedStringSchema(undefined, 100).optional(),
    bio: createTrimmedStringSchema(undefined, 500).optional(),
    profileImageUrl: URLSchema.optional(),
    coverImageUrl: URLSchema.optional(),
  })
  .refine((data) => data.walletAddress || data.email, {
    message: "Either wallet address or email is required",
  });

/**
 * Update user profile schema
 */
export const UpdateUserSchema = z.object({
  username: UsernameSchema.optional(),
  displayName: createTrimmedStringSchema(undefined, 100).optional(),
  bio: createTrimmedStringSchema(undefined, 500).optional(),
  profileImageUrl: URLSchema.optional(),
  coverImageUrl: URLSchema.optional(),
  showTwitterPublic: z.boolean().optional(),
  showFarcasterPublic: z.boolean().optional(),
  showWalletPublic: z.boolean().optional(),
  onchainTxHash: z
    .string()
    .regex(
      /^0x[0-9a-fA-F]{64}$/,
      "onchainTxHash must be a valid 32-byte hex string",
    )
    .optional(),
});

/**
 * Social connection schemas
 */
export const ConnectSocialSchema = z.object({
  platform: z.enum(["twitter", "farcaster"]),
  username: z.string().min(1).max(50),
  verificationToken: z.string().optional(), // For verification purposes
});

/**
 * Referral schema
 */
export const ReferralSchema = z.object({
  referralCode: z
    .string()
    .min(6)
    .max(20)
    .regex(/^[A-Z0-9]+$/, "Referral code must be alphanumeric uppercase"),
});

/**
 * User authentication schema
 */
export const UserAuthSchema = z.object({
  walletAddress: WalletAddressSchema,
  signature: z.string(),
  nonce: z.string(),
});

/**
 * User balance transaction schema
 */
export const UserBalanceTransactionSchema = z.object({
  amount: z.number().positive(),
  type: z.enum([
    "deposit",
    "withdrawal",
    "trade_profit",
    "trade_loss",
    "fee",
    "reward",
  ]),
  description: z.string().optional(),
  transactionHash: z.string().optional(),
});

/**
 * User points transaction schema
 */
export const UserPointsTransactionSchema = z.object({
  points: z.number(),
  type: z.enum([
    "profile_completion",
    "profile_image",
    "username",
    "social_connect",
    "wallet_connect",
    "referral",
    "trade",
    "achievement",
  ]),
  description: z.string(),
});

/**
 * User query filters
 */
export const UserQuerySchema = z.object({
  isActor: z.boolean().optional(),
  hasWallet: z.boolean().optional(),
  minReputation: z.number().optional(),
  maxReputation: z.number().optional(),
  onChainRegistered: z.boolean().optional(),
  search: z.string().optional(),
});

/**
 * Follow/unfollow schema
 */
export const FollowUserSchema = z.object({
  targetUserId: SnowflakeIdSchema,
});

/**
 * Favorite user schema
 */
export const FavoriteUserSchema = z.object({
  targetUserId: SnowflakeIdSchema,
});

/**
 * User onboarding completion schema
 */
export const CompleteOnboardingSchema = z.object({
  username: UsernameSchema,
  displayName: createTrimmedStringSchema(undefined, 100).optional(),
  bio: createTrimmedStringSchema(undefined, 500).optional(),
  profileImageUrl: URLSchema.optional(),
  referralCode: z.string().optional(),
});

/**
 * On-chain registration schema
 */
export const OnChainRegistrationSchema = z.object({
  walletAddress: WalletAddressSchema.optional(),
  username: z.string().min(1).max(50).optional(),
  displayName: z.string().min(1).max(100).optional(),
  bio: createTrimmedStringSchema(undefined, 500).optional(),
  // Accept valid URLs or local asset paths (for preset images)
  profileImageUrl: z
    .string()
    .refine(
      (val) =>
        !val ||
        val.startsWith("/assets/") ||
        val.startsWith("http://") ||
        val.startsWith("https://") ||
        val.startsWith("/uploads/"),
      { message: "Must be a valid URL or asset path" },
    )
    .optional(),
  coverImageUrl: z
    .string()
    .refine(
      (val) =>
        !val ||
        val.startsWith("/assets/") ||
        val.startsWith("http://") ||
        val.startsWith("https://") ||
        val.startsWith("/uploads/"),
      { message: "Must be a valid URL or asset path" },
    )
    .optional(),
  endpoint: URLSchema.optional(),
  referralCode: z.string().optional(),
});

/**
 * Agent0 registration schema
 */
export const Agent0RegistrationSchema = z.object({
  metadataCID: z.string(), // IPFS CID
  mcpEndpoint: URLSchema.optional(),
  a2aEndpoint: URLSchema.optional(),
});

/**
 * User wallet update schema
 */
export const UpdateWalletSchema = z.object({
  walletAddress: WalletAddressSchema,
  signature: z.string(),
  nonce: z.string(),
});

/**
 * User response schema (for API responses)
 */
export const UserResponseSchema = z.object({
  id: SnowflakeIdSchema,
  walletAddress: WalletAddressSchema.nullable(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  bio: z.string().nullable(),
  profileImageUrl: URLSchema.nullable(),
  coverImageUrl: URLSchema.nullable(),
  isActor: z.boolean(),
  reputationPoints: z.number(),
  virtualBalance: z.string(), // Decimal as string
  lifetimePnL: z.string(), // Decimal as string
  onChainRegistered: z.boolean(),
  nftTokenId: z.number().nullable(),
  profileComplete: z.boolean(),
  hasFarcaster: z.boolean(),
  hasTwitter: z.boolean(),
  referralCode: z.string().nullable(),
  referralCount: z.number(),
  agent0TrustScore: z.number(),
  createdAt: z.string(), // DateTime as string
  updatedAt: z.string(), // DateTime as string
});

/**
 * User list response schema
 */
export const UserListResponseSchema = z.object({
  users: z.array(UserResponseSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

/**
 * User posts query schema
 */
export const UserPostsQuerySchema = z.object({
  type: z.enum(["posts", "replies"]).default("posts"),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(100),
});

/**
 * User followers/following query schema
 */
export const UserFollowersQuerySchema = PaginationSchema.extend({
  includeMutual: z.coerce.boolean().default(false),
});
