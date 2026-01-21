import type { GameOnboardingStep } from "@polyagent/shared";
import { relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  decimal,
  doublePrecision,
  index,
  integer,
  json,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import type { JsonValue } from "../types";
import { onboardingStatusEnum } from "./enums";

// Re-export for consumers
export type { GameOnboardingStep } from "@polyagent/shared";

/**
 * Game onboarding state stored in JSONB
 * Note: startedAt and completedAt are ISO date strings since JSONB serializes dates as strings
 */
export interface GameOnboardingState {
  completedSteps: GameOnboardingStep[];
  currentStep: GameOnboardingStep;
  startedAt: string | null;
  completedAt: string | null;
  rewards: Array<{ step: GameOnboardingStep; points: number }>;
}

/**
 * Default game onboarding state.
 * This constant is used to generate the SQL default for the state column,
 * ensuring TypeScript validates the default against the GameOnboardingState interface.
 */
export const DEFAULT_GAME_ONBOARDING_STATE: GameOnboardingState = {
  completedSteps: [],
  currentStep: "welcome",
  startedAt: null,
  completedAt: null,
  rewards: [],
};

/**
 * GameOnboarding - Tracks user's game tutorial progress
 */
export const gameOnboarding = pgTable(
  "GameOnboarding",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),

    // Current step in the tutorial
    currentStep: text("currentStep")
      .$type<GameOnboardingStep>()
      .notNull()
      .default("welcome"),

    // Full state as JSONB for flexibility
    // The default is generated from DEFAULT_GAME_ONBOARDING_STATE constant,
    // ensuring TypeScript validates the default against the GameOnboardingState interface.
    state: jsonb("state")
      .$type<GameOnboardingState>()
      .default(DEFAULT_GAME_ONBOARDING_STATE),

    // Quick access flags
    isComplete: boolean("isComplete").notNull().default(false),
    skippedAt: timestamp("skippedAt", { mode: "date" }),

    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // Note: userId already has unique() constraint which creates an implicit unique index
    // so a separate index on userId would be redundant
    index("GameOnboarding_isComplete_idx").on(table.isComplete),
    index("GameOnboarding_currentStep_idx").on(table.currentStep),
  ],
);

export type GameOnboardingRow = typeof gameOnboarding.$inferSelect;
export type NewGameOnboardingRow = typeof gameOnboarding.$inferInsert;

// User - Main user table
export const users = pgTable(
  "User",
  {
    id: text("id").primaryKey(),
    walletAddress: text("walletAddress").unique(),
    username: text("username").unique(),
    displayName: text("displayName"),
    bio: text("bio"),
    profileImageUrl: text("profileImageUrl"),
    isActor: boolean("isActor").notNull().default(false),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
    personality: text("personality"),
    postStyle: text("postStyle"),
    postExample: text("postExample"),
    virtualBalance: decimal("virtualBalance", { precision: 18, scale: 2 })
      .notNull()
      .default("1000"),
    totalDeposited: decimal("totalDeposited", { precision: 18, scale: 2 })
      .notNull()
      .default("1000"),
    totalWithdrawn: decimal("totalWithdrawn", { precision: 18, scale: 2 })
      .notNull()
      .default("0"),
    lifetimePnL: decimal("lifetimePnL", { precision: 18, scale: 2 })
      .notNull()
      .default("0"),
    profileComplete: boolean("profileComplete").notNull().default(false),
    hasProfileImage: boolean("hasProfileImage").notNull().default(false),
    hasUsername: boolean("hasUsername").notNull().default(false),
    hasBio: boolean("hasBio").notNull().default(false),
    profileSetupCompletedAt: timestamp("profileSetupCompletedAt", {
      mode: "date",
    }),
    farcasterUsername: text("farcasterUsername"),
    hasFarcaster: boolean("hasFarcaster").notNull().default(false),
    hasTwitter: boolean("hasTwitter").notNull().default(false),
    hasDiscord: boolean("hasDiscord").notNull().default(false),
    nftTokenId: integer("nftTokenId").unique(),
    onChainRegistered: boolean("onChainRegistered").notNull().default(false),
    pointsAwardedForFarcaster: boolean("pointsAwardedForFarcaster")
      .notNull()
      .default(false),
    pointsAwardedForFarcasterFollow: boolean("pointsAwardedForFarcasterFollow")
      .notNull()
      .default(false),
    pointsAwardedForProfile: boolean("pointsAwardedForProfile")
      .notNull()
      .default(false),
    pointsAwardedForProfileImage: boolean("pointsAwardedForProfileImage")
      .notNull()
      .default(false),
    pointsAwardedForTwitter: boolean("pointsAwardedForTwitter")
      .notNull()
      .default(false),
    pointsAwardedForTwitterFollow: boolean("pointsAwardedForTwitterFollow")
      .notNull()
      .default(false),
    pointsAwardedForDiscord: boolean("pointsAwardedForDiscord")
      .notNull()
      .default(false),
    pointsAwardedForDiscordJoin: boolean("pointsAwardedForDiscordJoin")
      .notNull()
      .default(false),
    pointsAwardedForUsername: boolean("pointsAwardedForUsername")
      .notNull()
      .default(false),
    pointsAwardedForWallet: boolean("pointsAwardedForWallet")
      .notNull()
      .default(false),
    pointsAwardedForReferralBonus: boolean("pointsAwardedForReferralBonus")
      .notNull()
      .default(false),
    pointsAwardedForShare: boolean("pointsAwardedForShare")
      .notNull()
      .default(false),
    pointsAwardedForPrivateGroup: boolean("pointsAwardedForPrivateGroup")
      .notNull()
      .default(false),
    pointsAwardedForPrivateChannel: boolean("pointsAwardedForPrivateChannel")
      .notNull()
      .default(false),
    referralCode: text("referralCode").unique(),
    referralCount: integer("referralCount").notNull().default(0),
    referredBy: text("referredBy"),
    registrationIpHash: text("registrationIpHash"),
    lastReferralIpHash: text("lastReferralIpHash"),
    registrationTxHash: text("registrationTxHash"),
    reputationPoints: integer("reputationPoints").notNull().default(1000),
    twitterUsername: text("twitterUsername"),
    bannerDismissCount: integer("bannerDismissCount").notNull().default(0),
    bannerLastShown: timestamp("bannerLastShown", { mode: "date" }),
    coverImageUrl: text("coverImageUrl"),
    showFarcasterPublic: boolean("showFarcasterPublic").notNull().default(true),
    showTwitterPublic: boolean("showTwitterPublic").notNull().default(true),
    showWalletPublic: boolean("showWalletPublic").notNull().default(true),
    usernameChangedAt: timestamp("usernameChangedAt", { mode: "date" }),
    agent0FeedbackCount: integer("agent0FeedbackCount"),
    agent0MetadataCID: text("agent0MetadataCID"),
    agent0RegisteredAt: timestamp("agent0RegisteredAt", { mode: "date" }),
    agent0TokenId: integer("agent0TokenId"),
    agent0TrustScore: doublePrecision("agent0TrustScore"),
    bannedAt: timestamp("bannedAt", { mode: "date" }),
    bannedBy: text("bannedBy"),
    bannedReason: text("bannedReason"),
    farcasterDisplayName: text("farcasterDisplayName"),
    farcasterFid: text("farcasterFid").unique(),
    farcasterPfpUrl: text("farcasterPfpUrl"),
    farcasterVerifiedAt: timestamp("farcasterVerifiedAt", { mode: "date" }),
    isAdmin: boolean("isAdmin").notNull().default(false),
    isBanned: boolean("isBanned").notNull().default(false),
    isScammer: boolean("isScammer").notNull().default(false),
    isCSAM: boolean("isCSAM").notNull().default(false),
    appealCount: integer("appealCount").notNull().default(0),
    appealStaked: boolean("appealStaked").notNull().default(false),
    appealStakeAmount: decimal("appealStakeAmount", {
      precision: 18,
      scale: 2,
    }),
    appealStakeTxHash: text("appealStakeTxHash"),
    appealStatus: text("appealStatus"),
    appealSubmittedAt: timestamp("appealSubmittedAt", { mode: "date" }),
    appealReviewedAt: timestamp("appealReviewedAt", { mode: "date" }),
    falsePositiveHistory: json("falsePositiveHistory").$type<JsonValue>(),
    privyId: text("privyId").unique(),
    registrationBlockNumber: bigint("registrationBlockNumber", {
      mode: "bigint",
    }),
    registrationGasUsed: bigint("registrationGasUsed", { mode: "bigint" }),
    registrationTimestamp: timestamp("registrationTimestamp", { mode: "date" }),
    role: text("role"),
    totalFeesEarned: decimal("totalFeesEarned", { precision: 18, scale: 2 })
      .notNull()
      .default("0"),
    totalFeesPaid: decimal("totalFeesPaid", { precision: 18, scale: 2 })
      .notNull()
      .default("0"),
    twitterAccessToken: text("twitterAccessToken"),
    twitterId: text("twitterId").unique(),
    twitterRefreshToken: text("twitterRefreshToken"),
    twitterTokenExpiresAt: timestamp("twitterTokenExpiresAt", { mode: "date" }),
    twitterVerifiedAt: timestamp("twitterVerifiedAt", { mode: "date" }),
    discordId: text("discordId").unique(),
    discordUsername: text("discordUsername"),
    discordAccessToken: text("discordAccessToken"),
    discordRefreshToken: text("discordRefreshToken"),
    discordTokenExpiresAt: timestamp("discordTokenExpiresAt", { mode: "date" }),
    discordVerifiedAt: timestamp("discordVerifiedAt", { mode: "date" }),
    tosAccepted: boolean("tosAccepted").notNull().default(false),
    tosAcceptedAt: timestamp("tosAcceptedAt", { mode: "date" }),
    tosAcceptedVersion: text("tosAcceptedVersion").default("2025-11-11"),
    privacyPolicyAccepted: boolean("privacyPolicyAccepted")
      .notNull()
      .default(false),
    privacyPolicyAcceptedAt: timestamp("privacyPolicyAcceptedAt", {
      mode: "date",
    }),
    privacyPolicyAcceptedVersion: text("privacyPolicyAcceptedVersion").default(
      "2025-11-11",
    ),
    invitePoints: integer("invitePoints").notNull().default(0),
    earnedPoints: integer("earnedPoints").notNull().default(0),
    bonusPoints: integer("bonusPoints").notNull().default(0),
    waitlistPosition: integer("waitlistPosition"),
    waitlistJoinedAt: timestamp("waitlistJoinedAt", { mode: "date" }),
    isWaitlistActive: boolean("isWaitlistActive").notNull().default(false),
    isTest: boolean("isTest").notNull().default(false),
    pointsAwardedForEmail: boolean("pointsAwardedForEmail")
      .notNull()
      .default(false),
    emailVerified: boolean("emailVerified").notNull().default(false),
    email: text("email"),
    waitlistGraduatedAt: timestamp("waitlistGraduatedAt", { mode: "date" }),
    // Agent flags (config stored in UserAgentConfig table)
    isAgent: boolean("isAgent").notNull().default(false),
    managedBy: text("managedBy"),
    // Agent owner - the user who created/owns this agent
    ownerId: text("ownerId"),
    // Polymarket trading configuration
    tradingEnabled: boolean("tradingEnabled").notNull().default(false),
    riskTolerance: text("riskTolerance")
      .$type<"conservative" | "moderate" | "aggressive">()
      .default("moderate"),
    maxPositionSize: decimal("maxPositionSize", {
      precision: 18,
      scale: 2,
    }).default("100"),
    tradingStrategy: text("tradingStrategy"),
    systemPrompt: text("systemPrompt"),
    // Polymarket API credentials (encrypted in production)
    polymarketApiKey: text("polymarketApiKey"),
    polymarketApiSecret: text("polymarketApiSecret"),
    polymarketPassphrase: text("polymarketPassphrase"),
    // USDC balance for agent trading
    balance: decimal("balance", { precision: 18, scale: 6 }).default("0"),
    // Game guide completion tracking
    gameGuideCompletedAt: timestamp("gameGuideCompletedAt", { mode: "date" }),
  },
  (table) => [
    index("User_displayName_idx").on(table.displayName),
    index("User_earnedPoints_idx").on(table.earnedPoints),
    index("User_invitePoints_idx").on(table.invitePoints),
    index("User_isActor_idx").on(table.isActor),
    // Admin stats indexes for optimized user signups queries
    index("User_isActor_createdAt_idx").on(table.isActor, table.createdAt),
    index("User_isAgent_idx").on(table.isAgent),
    index("User_isAgent_createdAt_idx").on(table.isAgent, table.createdAt),
    index("User_isAgent_managedBy_idx").on(table.isAgent, table.managedBy),
    index("User_ownerId_idx").on(table.ownerId),
    index("User_isAgent_ownerId_idx").on(table.isAgent, table.ownerId),
    index("User_tradingEnabled_idx").on(table.tradingEnabled),
    index("User_isBanned_isActor_idx").on(table.isBanned, table.isActor),
    index("User_isScammer_idx").on(table.isScammer),
    index("User_isCSAM_idx").on(table.isCSAM),
    index("User_managedBy_idx").on(table.managedBy),
    index("User_profileComplete_createdAt_idx").on(
      table.profileComplete,
      table.createdAt,
    ),
    index("User_referralCode_idx").on(table.referralCode),
    index("User_reputationPoints_idx").on(table.reputationPoints),
    index("User_username_idx").on(table.username),
    index("User_waitlistJoinedAt_idx").on(table.waitlistJoinedAt),
    index("User_waitlistPosition_idx").on(table.waitlistPosition),
    index("User_walletAddress_idx").on(table.walletAddress),
    index("User_registrationIpHash_idx").on(table.registrationIpHash),
    index("User_lastReferralIpHash_idx").on(table.lastReferralIpHash),
  ],
);

// OnboardingIntent
export const onboardingIntents = pgTable(
  "OnboardingIntent",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull().unique(),
    status: onboardingStatusEnum("status").notNull().default("PENDING_PROFILE"),
    referralCode: text("referralCode"),
    payload: json("payload").$type<JsonValue>(),
    profileApplied: boolean("profileApplied").notNull().default(false),
    profileCompletedAt: timestamp("profileCompletedAt", { mode: "date" }),
    onchainStartedAt: timestamp("onchainStartedAt", { mode: "date" }),
    onchainCompletedAt: timestamp("onchainCompletedAt", { mode: "date" }),
    lastError: json("lastError").$type<JsonValue>(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("OnboardingIntent_createdAt_idx").on(table.createdAt),
    index("OnboardingIntent_status_idx").on(table.status),
  ],
);

// Follow - User follow relationships
export const follows = pgTable(
  "Follow",
  {
    id: text("id").primaryKey(),
    followerId: text("followerId").notNull(),
    followingId: text("followingId").notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    unique("Follow_followerId_followingId_key").on(
      table.followerId,
      table.followingId,
    ),
    index("Follow_followerId_idx").on(table.followerId),
    index("Follow_followingId_idx").on(table.followingId),
  ],
);

// FollowStatus
export const followStatuses = pgTable(
  "FollowStatus",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull(),
    npcId: text("npcId").notNull(),
    followedAt: timestamp("followedAt", { mode: "date" })
      .notNull()
      .defaultNow(),
    unfollowedAt: timestamp("unfollowedAt", { mode: "date" }),
    isActive: boolean("isActive").notNull().default(true),
    followReason: text("followReason"),
  },
  (table) => [
    unique("FollowStatus_userId_npcId_key").on(table.userId, table.npcId),
    index("FollowStatus_npcId_idx").on(table.npcId),
    index("FollowStatus_userId_isActive_idx").on(table.userId, table.isActive),
  ],
);

// Favorite
export const favorites = pgTable(
  "Favorite",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull(),
    targetUserId: text("targetUserId").notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    unique("Favorite_userId_targetUserId_key").on(
      table.userId,
      table.targetUserId,
    ),
    index("Favorite_targetUserId_idx").on(table.targetUserId),
    index("Favorite_userId_idx").on(table.userId),
  ],
);

// UserBlock
export const userBlocks = pgTable(
  "UserBlock",
  {
    id: text("id").primaryKey(),
    blockerId: text("blockerId").notNull(),
    blockedId: text("blockedId").notNull(),
    reason: text("reason"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    unique("UserBlock_blockerId_blockedId_key").on(
      table.blockerId,
      table.blockedId,
    ),
    index("UserBlock_blockerId_idx").on(table.blockerId),
    index("UserBlock_blockedId_idx").on(table.blockedId),
    index("UserBlock_createdAt_idx").on(table.createdAt),
  ],
);

// UserMute
export const userMutes = pgTable(
  "UserMute",
  {
    id: text("id").primaryKey(),
    muterId: text("muterId").notNull(),
    mutedId: text("mutedId").notNull(),
    reason: text("reason"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    unique("UserMute_muterId_mutedId_key").on(table.muterId, table.mutedId),
    index("UserMute_muterId_idx").on(table.muterId),
    index("UserMute_mutedId_idx").on(table.mutedId),
    index("UserMute_createdAt_idx").on(table.createdAt),
  ],
);

// Referral
export const referrals = pgTable(
  "Referral",
  {
    id: text("id").primaryKey(),
    referrerId: text("referrerId").notNull(),
    referredUserId: text("referredUserId"),
    referralCode: text("referralCode").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    completedAt: timestamp("completedAt", { mode: "date" }),
    qualifiedAt: timestamp("qualifiedAt", { mode: "date" }),
    signupPointsAwarded: boolean("signupPointsAwarded")
      .notNull()
      .default(false),
    suspiciousReferralFlags: json("suspiciousReferralFlags").$type<JsonValue>(),
  },
  (table) => [
    unique("Referral_referralCode_referredUserId_key").on(
      table.referralCode,
      table.referredUserId,
    ),
    index("Referral_referralCode_idx").on(table.referralCode),
    index("Referral_referrerId_idx").on(table.referrerId),
    index("Referral_referredUserId_idx").on(table.referredUserId),
    index("Referral_status_createdAt_idx").on(table.status, table.createdAt),
    index("Referral_qualifiedAt_idx").on(table.qualifiedAt),
    // Index for unqualified referral limit queries
    index("Referral_referrerId_status_qualifiedAt_signupPointsAwarded_idx").on(
      table.referrerId,
      table.status,
      table.qualifiedAt,
      table.signupPointsAwarded,
    ),
    // Index for pending referrals FIFO queue
    index("Referral_referrerId_signupPointsAwarded_completedAt_idx").on(
      table.referrerId,
      table.signupPointsAwarded,
      table.completedAt,
    ),
  ],
);

// ProfileUpdateLog
export const profileUpdateLogs = pgTable(
  "ProfileUpdateLog",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull(),
    changedFields: text("changedFields").array().notNull(),
    backendSigned: boolean("backendSigned").notNull(),
    txHash: text("txHash"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("ProfileUpdateLog_userId_createdAt_idx").on(
      table.userId,
      table.createdAt,
    ),
  ],
);

// TwitterOAuthToken
export const twitterOAuthTokens = pgTable(
  "TwitterOAuthToken",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull().unique(),
    oauth1Token: text("oauth1Token").notNull(),
    oauth1TokenSecret: text("oauth1TokenSecret").notNull(),
    screenName: text("screenName"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" }).notNull(),
  },
  (table) => [index("TwitterOAuthToken_userId_idx").on(table.userId)],
);

// UserActorFollow
export const userActorFollows = pgTable(
  "UserActorFollow",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull(),
    actorId: text("actorId").notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    unique("UserActorFollow_userId_actorId_key").on(
      table.userId,
      table.actorId,
    ),
    index("UserActorFollow_actorId_idx").on(table.actorId),
    index("UserActorFollow_userId_idx").on(table.userId),
  ],
);

// UserInteraction
export const userInteractions = pgTable(
  "UserInteraction",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull(),
    npcId: text("npcId").notNull(),
    postId: text("postId").notNull(),
    commentId: text("commentId").notNull(),
    timestamp: timestamp("timestamp", { mode: "date" }).notNull().defaultNow(),
    qualityScore: doublePrecision("qualityScore").notNull().default(1.0),
    wasFollowed: boolean("wasFollowed").notNull().default(false),
    wasInvitedToChat: boolean("wasInvitedToChat").notNull().default(false),
  },
  (table) => [
    index("UserInteraction_npcId_timestamp_idx").on(
      table.npcId,
      table.timestamp,
    ),
    index("UserInteraction_userId_npcId_timestamp_idx").on(
      table.userId,
      table.npcId,
      table.timestamp,
    ),
    index("UserInteraction_userId_timestamp_idx").on(
      table.userId,
      table.timestamp,
    ),
  ],
);

// UserApiKey - Per-user API keys for MCP authentication
export const userApiKeys = pgTable(
  "UserApiKey",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull(),
    keyHash: text("keyHash").notNull(), // SHA-256 hash of API key
    name: text("name"), // Optional name/label for the key
    lastUsedAt: timestamp("lastUsedAt", { mode: "date" }),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    expiresAt: timestamp("expiresAt", { mode: "date" }), // Optional expiration
    revokedAt: timestamp("revokedAt", { mode: "date" }), // For revocation
  },
  (table) => [
    index("UserApiKey_userId_idx").on(table.userId),
    index("UserApiKey_keyHash_idx").on(table.keyHash),
    index("UserApiKey_userId_revokedAt_idx").on(table.userId, table.revokedAt),
  ],
);

export const gameOnboardingRelations = relations(gameOnboarding, ({ one }) => ({
  user: one(users, {
    fields: [gameOnboarding.userId],
    references: [users.id],
  }),
}));

export const onboardingIntentsRelations = relations(
  onboardingIntents,
  ({ one }) => ({
    user: one(users, {
      fields: [onboardingIntents.userId],
      references: [users.id],
    }),
  }),
);

export const followsRelations = relations(follows, ({ one }) => ({
  follower: one(users, {
    fields: [follows.followerId],
    references: [users.id],
    relationName: "Follow_followerIdToUser",
  }),
  following: one(users, {
    fields: [follows.followingId],
    references: [users.id],
    relationName: "Follow_followingIdToUser",
  }),
}));

export const favoritesRelations = relations(favorites, ({ one }) => ({
  User_Favorite_targetUserIdToUser: one(users, {
    fields: [favorites.targetUserId],
    references: [users.id],
    relationName: "Favorite_targetUserIdToUser",
  }),
  User_Favorite_userIdToUser: one(users, {
    fields: [favorites.userId],
    references: [users.id],
    relationName: "Favorite_userIdToUser",
  }),
}));

export const userBlocksRelations = relations(userBlocks, ({ one }) => ({
  blocker: one(users, {
    fields: [userBlocks.blockerId],
    references: [users.id],
    relationName: "UserBlock_blockerIdToUser",
  }),
  blocked: one(users, {
    fields: [userBlocks.blockedId],
    references: [users.id],
    relationName: "UserBlock_blockedIdToUser",
  }),
}));

export const userMutesRelations = relations(userMutes, ({ one }) => ({
  muter: one(users, {
    fields: [userMutes.muterId],
    references: [users.id],
    relationName: "UserMute_muterIdToUser",
  }),
  muted: one(users, {
    fields: [userMutes.mutedId],
    references: [users.id],
    relationName: "UserMute_mutedIdToUser",
  }),
}));

export const referralsRelations = relations(referrals, ({ one }) => ({
  User_Referral_referrerIdToUser: one(users, {
    fields: [referrals.referrerId],
    references: [users.id],
    relationName: "Referral_referrerIdToUser",
  }),
  User_Referral_referredUserIdToUser: one(users, {
    fields: [referrals.referredUserId],
    references: [users.id],
    relationName: "Referral_referredUserIdToUser",
  }),
}));

export const profileUpdateLogsRelations = relations(
  profileUpdateLogs,
  ({ one }) => ({
    user: one(users, {
      fields: [profileUpdateLogs.userId],
      references: [users.id],
    }),
  }),
);

export const twitterOAuthTokensRelations = relations(
  twitterOAuthTokens,
  ({ one }) => ({
    user: one(users, {
      fields: [twitterOAuthTokens.userId],
      references: [users.id],
    }),
  }),
);

export const userActorFollowsRelations = relations(
  userActorFollows,
  ({ one }) => ({
    user: one(users, {
      fields: [userActorFollows.userId],
      references: [users.id],
    }),
  }),
);

export const userApiKeysRelations = relations(userApiKeys, ({ one }) => ({
  user: one(users, {
    fields: [userApiKeys.userId],
    references: [users.id],
    relationName: "UserApiKey_userIdToUser",
  }),
}));

// Type exports
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type OnboardingIntent = typeof onboardingIntents.$inferSelect;
export type NewOnboardingIntent = typeof onboardingIntents.$inferInsert;
export type Follow = typeof follows.$inferSelect;
export type NewFollow = typeof follows.$inferInsert;
export type FollowStatus = typeof followStatuses.$inferSelect;
export type NewFollowStatus = typeof followStatuses.$inferInsert;
export type Favorite = typeof favorites.$inferSelect;
export type NewFavorite = typeof favorites.$inferInsert;
export type UserBlock = typeof userBlocks.$inferSelect;
export type NewUserBlock = typeof userBlocks.$inferInsert;
export type UserMute = typeof userMutes.$inferSelect;
export type NewUserMute = typeof userMutes.$inferInsert;
export type Referral = typeof referrals.$inferSelect;
export type NewReferral = typeof referrals.$inferInsert;
export type ProfileUpdateLog = typeof profileUpdateLogs.$inferSelect;
export type NewProfileUpdateLog = typeof profileUpdateLogs.$inferInsert;
export type TwitterOAuthToken = typeof twitterOAuthTokens.$inferSelect;
export type NewTwitterOAuthToken = typeof twitterOAuthTokens.$inferInsert;
export type UserActorFollow = typeof userActorFollows.$inferSelect;
export type NewUserActorFollow = typeof userActorFollows.$inferInsert;
export type UserInteraction = typeof userInteractions.$inferSelect;
export type NewUserInteraction = typeof userInteractions.$inferInsert;
export type UserApiKey = typeof userApiKeys.$inferSelect;
export type NewUserApiKey = typeof userApiKeys.$inferInsert;
