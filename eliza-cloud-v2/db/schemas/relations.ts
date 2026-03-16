/**
 * Database relations definitions.
 *
 * Defines relationships between tables for Drizzle ORM query building.
 */
import { relations } from "drizzle-orm";
import { organizations } from "./organizations";
import { organizationInvites } from "./organization-invites";
import { users } from "./users";
import { conversations, conversationMessages } from "./conversations";
import { userCharacters } from "./user-characters";
import { apps, appUsers, appAnalytics } from "./apps";
import { apiKeys } from "./api-keys";
import { appCreditBalances } from "./app-credit-balances";
import { appEarnings, appEarningsTransactions } from "./app-earnings";
import { tokenRedemptions, redemptionLimits } from "./token-redemptions";
import { cryptoPayments } from "./crypto-payments";

/**
 * Organizations table relations.
 */
export const organizationsRelations = relations(organizations, ({ many }) => ({
  users: many(users),
  invites: many(organizationInvites),
  apps: many(apps),
}));

/**
 * Users table relations.
 */
export const usersRelations = relations(users, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [users.organization_id],
    references: [organizations.id],
  }),
  conversations: many(conversations),
}));

/**
 * Conversations table relations.
 */
export const conversationsRelations = relations(
  conversations,
  ({ many, one }) => ({
    messages: many(conversationMessages),
    user: one(users, {
      fields: [conversations.user_id],
      references: [users.id],
    }),
    organization: one(organizations, {
      fields: [conversations.organization_id],
      references: [organizations.id],
    }),
  }),
);

/**
 * Conversation messages table relations.
 */
export const conversationMessagesRelations = relations(
  conversationMessages,
  ({ one }) => ({
    conversation: one(conversations, {
      fields: [conversationMessages.conversation_id],
      references: [conversations.id],
    }),
  }),
);

/**
 * User characters table relations.
 */
export const userCharactersRelations = relations(userCharacters, ({ one }) => ({
  user: one(users, {
    fields: [userCharacters.user_id],
    references: [users.id],
  }),
  organization: one(organizations, {
    fields: [userCharacters.organization_id],
    references: [organizations.id],
  }),
}));

/**
 * Organization invites table relations.
 */
export const organizationInvitesRelations = relations(
  organizationInvites,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [organizationInvites.organization_id],
      references: [organizations.id],
    }),
    inviter: one(users, {
      fields: [organizationInvites.inviter_user_id],
      references: [users.id],
    }),
    acceptedBy: one(users, {
      fields: [organizationInvites.accepted_by_user_id],
      references: [users.id],
    }),
  }),
);

/**
 * Apps table relations.
 */
export const appsRelations = relations(apps, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [apps.organization_id],
    references: [organizations.id],
  }),
  createdBy: one(users, {
    fields: [apps.created_by_user_id],
    references: [users.id],
  }),
  apiKey: one(apiKeys, {
    fields: [apps.api_key_id],
    references: [apiKeys.id],
  }),
  users: many(appUsers),
  analytics: many(appAnalytics),
  creditBalances: many(appCreditBalances),
  earningsTransactions: many(appEarningsTransactions),
}));

/**
 * App users table relations.
 */
export const appUsersRelations = relations(appUsers, ({ one }) => ({
  app: one(apps, {
    fields: [appUsers.app_id],
    references: [apps.id],
  }),
  user: one(users, {
    fields: [appUsers.user_id],
    references: [users.id],
  }),
}));

/**
 * App analytics table relations.
 */
export const appAnalyticsRelations = relations(appAnalytics, ({ one }) => ({
  app: one(apps, {
    fields: [appAnalytics.app_id],
    references: [apps.id],
  }),
}));

/**
 * App credit balances table relations.
 */
export const appCreditBalancesRelations = relations(
  appCreditBalances,
  ({ one }) => ({
    app: one(apps, {
      fields: [appCreditBalances.app_id],
      references: [apps.id],
    }),
    user: one(users, {
      fields: [appCreditBalances.user_id],
      references: [users.id],
    }),
    organization: one(organizations, {
      fields: [appCreditBalances.organization_id],
      references: [organizations.id],
    }),
  }),
);

/**
 * App earnings table relations.
 */
export const appEarningsRelations = relations(appEarnings, ({ one }) => ({
  app: one(apps, {
    fields: [appEarnings.app_id],
    references: [apps.id],
  }),
}));

/**
 * App earnings transactions table relations.
 */
export const appEarningsTransactionsRelations = relations(
  appEarningsTransactions,
  ({ one }) => ({
    app: one(apps, {
      fields: [appEarningsTransactions.app_id],
      references: [apps.id],
    }),
    user: one(users, {
      fields: [appEarningsTransactions.user_id],
      references: [users.id],
    }),
  }),
);

/**
 * Token redemptions table relations.
 */
export const tokenRedemptionsRelations = relations(
  tokenRedemptions,
  ({ one }) => ({
    user: one(users, {
      fields: [tokenRedemptions.user_id],
      references: [users.id],
    }),
    app: one(apps, {
      fields: [tokenRedemptions.app_id],
      references: [apps.id],
    }),
    reviewer: one(users, {
      fields: [tokenRedemptions.reviewed_by],
      references: [users.id],
    }),
  }),
);

/**
 * Redemption limits table relations.
 */
export const redemptionLimitsRelations = relations(
  redemptionLimits,
  ({ one }) => ({
    user: one(users, {
      fields: [redemptionLimits.user_id],
      references: [users.id],
    }),
  }),
);

/**
 * Crypto payments table relations.
 */
export const cryptoPaymentsRelations = relations(cryptoPayments, ({ one }) => ({
  organization: one(organizations, {
    fields: [cryptoPayments.organization_id],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [cryptoPayments.user_id],
    references: [users.id],
  }),
}));
