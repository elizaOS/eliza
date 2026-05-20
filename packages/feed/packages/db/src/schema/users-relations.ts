import { relations } from "drizzle-orm";
import { agentPerformanceMetrics } from "./agents";
import { userAgentConfigs } from "./user-agent-configs";
import {
  favorites,
  follows,
  gameOnboarding,
  onboardingIntents,
  profileUpdateLogs,
  referrals,
  twitterOAuthTokens,
  userActorFollows,
  userApiKeys,
  userBlocks,
  userMutes,
  users,
} from "./users";

export const usersRelations = relations(users, ({ many, one }) => ({
  onboardingIntent: one(onboardingIntents, {
    fields: [users.id],
    references: [onboardingIntents.userId],
  }),
  followerFollows: many(follows, { relationName: "Follow_followerIdToUser" }),
  followingFollows: many(follows, { relationName: "Follow_followingIdToUser" }),
  targetFavorites: many(favorites, {
    relationName: "Favorite_targetUserIdToUser",
  }),
  userFavorites: many(favorites, { relationName: "Favorite_userIdToUser" }),
  blockerBlocks: many(userBlocks, {
    relationName: "UserBlock_blockerIdToUser",
  }),
  blockedBlocks: many(userBlocks, {
    relationName: "UserBlock_blockedIdToUser",
  }),
  muterMutes: many(userMutes, { relationName: "UserMute_muterIdToUser" }),
  mutedMutes: many(userMutes, { relationName: "UserMute_mutedIdToUser" }),
  referrerReferrals: many(referrals, {
    relationName: "Referral_referrerIdToUser",
  }),
  referredReferrals: many(referrals, {
    relationName: "Referral_referredUserIdToUser",
  }),
  twitterOAuthToken: one(twitterOAuthTokens, {
    fields: [users.id],
    references: [twitterOAuthTokens.userId],
  }),
  userActorFollows: many(userActorFollows),
  profileUpdateLogs: many(profileUpdateLogs),
  manager: one(users, {
    fields: [users.managedBy],
    references: [users.id],
    relationName: "UserToUser",
  }),
  managedAgents: many(users, { relationName: "UserToUser" }),
  agentPerformanceMetrics: one(agentPerformanceMetrics, {
    fields: [users.id],
    references: [agentPerformanceMetrics.userId],
  }),
  apiKeys: many(userApiKeys, {
    relationName: "UserApiKey_userIdToUser",
  }),
  agentConfig: one(userAgentConfigs, {
    fields: [users.id],
    references: [userAgentConfigs.userId],
  }),
  gameOnboarding: one(gameOnboarding, {
    fields: [users.id],
    references: [gameOnboarding.userId],
  }),
}));
