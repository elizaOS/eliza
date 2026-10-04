import { relations, sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { tenantAppClients, tenants } from "./schema";

// ─── Users ──────────────────────────────────────────────────────────────────
// Central identity record, decoupled from any tenant.
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 255 }).unique(),
    emailVerified: boolean("email_verified").default(false),
    name: varchar("name", { length: 255 }),
    image: text("image"),
    walletAddress: varchar("wallet_address", { length: 128 }),
    walletChain: varchar("wallet_chain", { length: 16 }).default("ethereum"),
    stewardWalletId: varchar("steward_wallet_id", { length: 64 }),
    customMetadata: jsonb("custom_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /**
     * Guest (ephemeral / anonymous) marker — Privy parity. A guest has no login
     * credential yet but gets a session + wallet immediately. Defaults to false
     * so every existing/full user row is unaffected. Upgrading a guest flips
     * this back to false (and clears `guestExpiresAt`) while preserving the id.
     */
    isGuest: boolean("is_guest").notNull().default(false),
    /**
     * Hard expiry for a guest session. NULL for full accounts. For guests this
     * bounds the session lifetime and is enforced server-side in
     * verifySessionToken (fail-closed), independent of the access-token `exp`.
     */
    guestExpiresAt: timestamp("guest_expires_at", { withTimezone: true }),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    walletIdentityUniqueIdx: uniqueIndex("users_wallet_identity_unique_idx")
      .on(table.walletChain, table.walletAddress)
      .where(sql`${table.walletAddress} is not null`),
    guestExpiresAtIdx: index("users_guest_expires_at_idx")
      .on(table.guestExpiresAt)
      .where(sql`${table.isGuest} = true`),
  }),
);

// ─── Authenticators (WebAuthn / passkeys) ────────────────────────────────────
export const authenticators = pgTable(
  "authenticators",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull().unique(),
    credentialPublicKey: text("credential_public_key").notNull(),
    /**
     * WebAuthn relying-party ID that scoped this credential at registration.
     *
     * Nullable only for credentials created before migration 0114. A
     * successful authentication can safely fill legacy provenance because
     * WebAuthn verifies the RP ID hash as part of that ceremony.
     */
    rpId: varchar("rp_id", { length: 253 }),
    counter: integer("counter").notNull().default(0),
    credentialDeviceType: varchar("credential_device_type", { length: 32 }),
    credentialBackedUp: boolean("credential_backed_up").default(false),
    transports: text("transports").array(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userIdIdx: index("authenticators_user_id_idx").on(table.userId),
  }),
);

export const userWalletAppConsents = pgTable(
  "user_wallet_app_consents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    clientId: varchar("client_id", { length: 64 }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    walletAgentId: varchar("wallet_agent_id", { length: 128 }),
    walletAddress: varchar("wallet_address", { length: 128 }),
    origin: text("origin").notNull(),
    redirectUri: text("redirect_uri"),
    scopes: text("scopes").array().notNull().default([]),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    appClientFk: foreignKey({
      columns: [table.tenantId, table.clientId],
      foreignColumns: [tenantAppClients.tenantId, tenantAppClients.id],
      name: "user_wallet_app_consents_app_client_fk",
    }).onDelete("cascade"),
    tenantClientUserIdx: index(
      "user_wallet_app_consents_tenant_client_user_idx",
    ).on(table.tenantId, table.clientId, table.userId),
    activeConsentUniqueIdx: uniqueIndex(
      "user_wallet_app_consents_active_unique_idx",
    )
      .on(table.tenantId, table.clientId, table.userId, table.origin)
      .where(sql`${table.status} = 'active'`),
  }),
);

export const globalWalletActionConfirmations = pgTable(
  "global_wallet_action_confirmations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    consentId: uuid("consent_id")
      .notNull()
      .references(() => userWalletAppConsents.id, { onDelete: "cascade" }),
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    clientId: varchar("client_id", { length: 64 }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    origin: text("origin").notNull(),
    method: varchar("method", { length: 64 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("approved"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    consentIdx: index("global_wallet_action_confirmations_consent_idx").on(
      table.consentId,
    ),
    userStatusIdx: index(
      "global_wallet_action_confirmations_user_status_idx",
    ).on(table.userId, table.status),
  }),
);

export const userPushSubscriptions = pgTable(
  "user_push_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: varchar("tenant_id", { length: 64 }).references(
      () => tenants.id,
      {
        onDelete: "cascade",
      },
    ),
    provider: varchar("provider", { length: 16 }).notNull(),
    token: text("token").notNull(),
    platform: varchar("platform", { length: 16 }),
    deviceId: varchar("device_id", { length: 255 }),
    appId: varchar("app_id", { length: 255 }),
    locale: varchar("locale", { length: 64 }),
    timezone: varchar("timezone", { length: 128 }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userStatusIdx: index("user_push_subscriptions_user_status_idx").on(
      table.userId,
      table.status,
    ),
    tenantUserIdx: index("user_push_subscriptions_tenant_user_idx").on(
      table.tenantId,
      table.userId,
    ),
    activeTokenUniqueIdx: uniqueIndex(
      "user_push_subscriptions_active_token_idx",
    )
      .on(table.userId, table.provider, table.token)
      .where(sql`${table.status} = 'active'`),
  }),
);

// ─── Sessions ────────────────────────────────────────────────────────────────
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionToken: text("session_token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userIdIdx: index("sessions_user_id_idx").on(table.userId),
  }),
);

// ─── OAuth Accounts ──────────────────────────────────────────────────────────
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 64 }).notNull(),
    providerAccountId: varchar("provider_account_id", {
      length: 255,
    }).notNull(),
    accessTokenEncrypted: text("access_token_encrypted"),
    accessTokenIv: text("access_token_iv"),
    accessTokenTag: text("access_token_tag"),
    accessTokenSalt: text("access_token_salt"),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    refreshTokenIv: text("refresh_token_iv"),
    refreshTokenTag: text("refresh_token_tag"),
    refreshTokenSalt: text("refresh_token_salt"),
    // Unix timestamp integer — matches OAuth provider convention
    expiresAt: integer("expires_at"),
  },
  (table) => ({
    providerUnique: uniqueIndex("accounts_provider_unique").on(
      table.provider,
      table.providerAccountId,
    ),
    userIdIdx: index("accounts_user_id_idx").on(table.userId),
  }),
);

// ─── Refresh Tokens ─────────────────────────────────────────────────────────
// Long-lived tokens (30 days) that can be exchanged for new access tokens.
// One-time use: each refresh rotates both tokens and deletes the old refresh token.
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("refresh_tokens_token_hash_unique_idx").on(
      table.tokenHash,
    ),
    tokenHashIdx: index("refresh_tokens_token_hash_idx").on(table.tokenHash),
    userIdIdx: index("refresh_tokens_user_id_idx").on(table.userId),
  }),
);

// ─── User–Tenant membership ───────────────────────────────────────────────────
// A user can belong to multiple tenants with a per-tenant role.
export const userTenants = pgTable(
  "user_tenants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 32 }).notNull().default("member"),
    customMetadata: jsonb("custom_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userTenantUnique: uniqueIndex("user_tenants_unique").on(
      table.userId,
      table.tenantId,
    ),
  }),
);

export const tenantInvitations = pgTable(
  "tenant_invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: varchar("tenant_id", { length: 64 })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 255 }).notNull(),
    role: varchar("role", { length: 32 }).notNull().default("member"),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("tenant_invitations_token_hash_idx").on(
      table.tokenHash,
    ),
    tenantStatusIdx: index("tenant_invitations_tenant_status_idx").on(
      table.tenantId,
      table.status,
    ),
    pendingEmailUnique: uniqueIndex("tenant_invitations_pending_email_idx")
      .on(table.tenantId, sql`lower(${table.email})`)
      .where(sql`${table.status} = 'pending'`),
  }),
);

// ─── Relations ────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  authenticators: many(authenticators),
  sessions: many(sessions),
  accounts: many(accounts),
  userTenants: many(userTenants),
  pushSubscriptions: many(userPushSubscriptions),
  acceptedInvitations: many(tenantInvitations, {
    relationName: "acceptedInvitations",
  }),
  sentInvitations: many(tenantInvitations, { relationName: "sentInvitations" }),
}));

export const authenticatorsRelations = relations(authenticators, ({ one }) => ({
  user: one(users, {
    fields: [authenticators.userId],
    references: [users.id],
  }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, {
    fields: [refreshTokens.userId],
    references: [users.id],
  }),
}));

export const userTenantsRelations = relations(userTenants, ({ one }) => ({
  user: one(users, {
    fields: [userTenants.userId],
    references: [users.id],
  }),
  tenant: one(tenants, {
    fields: [userTenants.tenantId],
    references: [tenants.id],
  }),
}));

export const tenantInvitationsRelations = relations(
  tenantInvitations,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [tenantInvitations.tenantId],
      references: [tenants.id],
    }),
    invitedBy: one(users, {
      fields: [tenantInvitations.invitedByUserId],
      references: [users.id],
      relationName: "sentInvitations",
    }),
    acceptedBy: one(users, {
      fields: [tenantInvitations.acceptedByUserId],
      references: [users.id],
      relationName: "acceptedInvitations",
    }),
  }),
);

export const userPushSubscriptionsRelations = relations(
  userPushSubscriptions,
  ({ one }) => ({
    user: one(users, {
      fields: [userPushSubscriptions.userId],
      references: [users.id],
    }),
    tenant: one(tenants, {
      fields: [userPushSubscriptions.tenantId],
      references: [tenants.id],
    }),
  }),
);

// ─── Inferred Types ───────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Authenticator = typeof authenticators.$inferSelect;
export type NewAuthenticator = typeof authenticators.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

export type UserTenant = typeof userTenants.$inferSelect;
export type NewUserTenant = typeof userTenants.$inferInsert;

export type TenantInvitation = typeof tenantInvitations.$inferSelect;
export type NewTenantInvitation = typeof tenantInvitations.$inferInsert;

export type RefreshToken = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = typeof refreshTokens.$inferInsert;

export type UserPushSubscription = typeof userPushSubscriptions.$inferSelect;
export type NewUserPushSubscription = typeof userPushSubscriptions.$inferInsert;
