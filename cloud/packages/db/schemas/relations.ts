/**
 * Database relations definitions.
 *
 * Defines relationships between tables for Drizzle ORM query building.
 */
import { relations } from "drizzle-orm";
import { apiKeys } from "./api-keys";
import { appBilling } from "./app-billing";
import { appConfig } from "./app-config";
import { appCreditBalances } from "./app-credit-balances";
import { appDatabases } from "./app-databases";
import { appEarnings, appEarningsTransactions } from "./app-earnings";
import { appAnalytics, apps, appUsers } from "./apps";
import { conversationMessages, conversations } from "./conversations";
import { cryptoPayments } from "./crypto-payments";
import { organizationBilling } from "./organization-billing";
import { organizationConfig } from "./organization-config";
import { organizationEncryptionKeys } from "./organization-encryption-keys";
import { organizationInvites } from "./organization-invites";
import { organizations } from "./organizations";
import { redemptionLimits, tokenRedemptions } from "./token-redemptions";
import { userCharacters } from "./user-characters";
import { userIdentities } from "./user-identities";
import { userPreferences } from "./user-preferences";
import { users } from "./users";

/**
 * Organizations table relations.
 */
export const organizationsRelations = relations(organizations, ({ one, many }) => ({
  users: many(users),
  invites: many(organizationInvites),
  apps: many(apps),
  encryptionKey: one(organizationEncryptionKeys),
  billing: one(organizationBilling),
  config: one(organizationConfig),
}));

/**
 * Organization billing table relations.
 */
export const organizationBillingRelations = relations(organizationBilling, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationBilling.organization_id],
    references: [organizations.id],
  }),
}));

/**
 * Organization config table relations.
 */
export const organizationConfigRelations = relations(organizationConfig, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationConfig.organization_id],
    references: [organizations.id],
  }),
}));

/**
 * Organization encryption keys table relations.
 */
export const organizationEncryptionKeysRelations = relations(
  organizationEncryptionKeys,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [organizationEncryptionKeys.organization_id],
      references: [organizations.id],
    }),
  }),
);

/**
 * Users table relations.
 */
export const usersRelations = relations(users, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [users.organization_id],
    references: [organizations.id],
  }),
  identity: one(userIdentities),
  preferences: one(userPreferences),
  conversations: many(conversations),
}));

/**
 * User identities table relations.
 */
export const userIdentitiesRelations = relations(userIdentities, ({ one }) => ({
  user: one(users, {
    fields: [userIdentities.user_id],
    references: [users.id],
  }),
}));

/**
 * User preferences table relations.
 */
export const userPreferencesRelations = relations(userPreferences, ({ one }) => ({
  user: one(users, {
    fields: [userPreferences.user_id],
    references: [users.id],
  }),
}));

/**
 * Conversations table relations.
 */
export const conversationsRelations = relations(conversations, ({ many, one }) => ({
  messages: many(conversationMessages),
  user: one(users, {
    fields: [conversations.user_id],
    references: [users.id],
  }),
  organization: one(organizations, {
    fields: [conversations.organization_id],
    references: [organizations.id],
  }),
}));

/**
 * Conversation messages table relations.
 */
export const conversationMessagesRelations = relations(conversationMessages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [conversationMessages.conversation_id],
    references: [conversations.id],
  }),
}));

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
export const organizationInvitesRelations = relations(organizationInvites, ({ one }) => ({
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
}));

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
  config: one(appConfig),
  billing: one(appBilling),
  database: one(appDatabases),
  users: many(appUsers),
  analytics: many(appAnalytics),
  creditBalances: many(appCreditBalances),
  earningsTransactions: many(appEarningsTransactions),
}));

/**
 * App config table relations.
 */
export const appConfigRelations = relations(appConfig, ({ one }) => ({
  app: one(apps, {
    fields: [appConfig.app_id],
    references: [apps.id],
  }),
}));

/**
 * App billing table relations.
 */
export const appBillingRelations = relations(appBilling, ({ one }) => ({
  app: one(apps, {
    fields: [appBilling.app_id],
    references: [apps.id],
  }),
}));

/**
 * App databases table relations.
 */
export const appDatabasesRelations = relations(appDatabases, ({ one }) => ({
  app: one(apps, {
    fields: [appDatabases.app_id],
    references: [apps.id],
  }),
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
export const appCreditBalancesRelations = relations(appCreditBalances, ({ one }) => ({
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
}));

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
export const appEarningsTransactionsRelations = relations(appEarningsTransactions, ({ one }) => ({
  app: one(apps, {
    fields: [appEarningsTransactions.app_id],
    references: [apps.id],
  }),
  user: one(users, {
    fields: [appEarningsTransactions.user_id],
    references: [users.id],
  }),
}));

/**
 * Token redemptions table relations.
 */
export const tokenRedemptionsRelations = relations(tokenRedemptions, ({ one }) => ({
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
}));

/**
 * Redemption limits table relations.
 */
export const redemptionLimitsRelations = relations(redemptionLimits, ({ one }) => ({
  user: one(users, {
    fields: [redemptionLimits.user_id],
    references: [users.id],
  }),
}));

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
