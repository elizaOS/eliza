import { z } from "zod";
import { UsernameSchema } from "./common";

export const OnboardingProfileSchema = z.object({
  username: UsernameSchema,
  displayName: z
    .string()
    .trim()
    .min(1, "Display name is required")
    .max(80, "Display name must be at most 80 characters"),
  bio: z
    .string()
    .trim()
    .max(280, "Bio must be at most 280 characters")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  profileImageUrl: z
    .string()
    .url("Profile image must be a valid URL")
    .optional()
    .or(z.literal("").transform(() => undefined))
    .nullable(),
  coverImageUrl: z
    .string()
    .url("Cover image must be a valid URL")
    .optional()
    .or(z.literal("").transform(() => undefined))
    .nullable(),
  referralCode: z
    .string()
    .trim()
    .min(1, "Referral code cannot be empty")
    .max(64, "Referral code must be at most 64 characters")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  // Social account import data
  importedFrom: z.enum(["twitter", "farcaster"]).optional().nullable(),
  twitterId: z.string().optional().nullable(),
  twitterUsername: z.string().optional().nullable(),
  farcasterFid: z.string().optional().nullable(),
  farcasterUsername: z.string().optional().nullable(),
  // Legal acceptance (required for GDPR compliance)
  tosAccepted: z.boolean().optional(),
  privacyPolicyAccepted: z.boolean().optional(),
});
