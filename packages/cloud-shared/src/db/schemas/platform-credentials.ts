/**
 * Platform Credentials Schema
 *
 * Stores OAuth credentials that users have authorized cloud apps to use.
 * This is a core cloud feature that enables any app to request
 * platform credentials from users.
 *
 * Flow:
 * 1. App generates a credential link URL
 * 2. User clicks link (from Discord, Telegram, web, etc.)
 * 3. User lands on cloud-hosted OAuth page
 * 4. User authorizes their platform account
 * 5. Credentials stored securely in cloud
 * 6. App can use credentials via cloud API
 */

import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { apps } from "./apps";
import { organizations } from "./organizations";
import { users } from "./users";

// =============================================================================
// ENUMS
// =============================================================================

export const platformCredentialTypeEnum = pgEnum("platform_credential_type", [
  "discord",
  "telegram",
  "twitter",
  "gmail",
  "slack",
  "github",
  "google",
  "bluesky",
  "reddit",
  "facebook",
  "instagram",
  "tiktok",
  "linkedin",
  "mastodon",
  "twilio",
  "google_calendar",
  // Generic OAuth providers (added via migration 0023)
  "linear",
  "notion",
  "hubspot",
  "salesforce",
  "jira",
  "asana",
  "airtable",
  "dropbox",
  "spotify",
  "zoom",
  // Microsoft OAuth (added via migration 0024)
  "microsoft",
]);

export const platformCredentialStatusEnum = pgEnum("platform_credential_status", [
  "pending",
  "active",
  "expired",
  "revoked",
  "error",
]);

// =============================================================================
// PLATFORM CREDENTIALS
// =============================================================================

/**
 * Stores OAuth credentials that users have authorized.
 * Scoped to organization + app + user.
 */
export const platformCredentials = pgTable(
  "platform_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Ownership
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id").references(() => users.id, {
      onDelete: "cascade",
    }), // Cloud user (optional)
    app_id: uuid("app_id").references(() => apps.id, { onDelete: "cascade" }), // Which app requested this

    // Platform identity
    platform: platformCredentialTypeEnum("platform").notNull(),
    platform_user_id: text("platform_user_id").notNull(), // Platform's user ID
    platform_username: text("platform_username"),
    platform_display_name: text("platform_display_name"),
    platform_avatar_url: text("platform_avatar_url"),
    platform_email: text("platform_email"),

    // Status
    status: platformCredentialStatusEnum("status").notNull().default("pending"),
    error_message: text("error_message"),

    // OAuth tokens (stored as secret references for security)
    access_token_secret_id: uuid("access_token_secret_id"),
    refresh_token_secret_id: uuid("refresh_token_secret_id"),
    token_expires_at: timestamp("token_expires_at"),
    scopes: jsonb("scopes").$type<string[]>().default([]),

    // For API key based platforms (e.g., Telegram bot tokens)
    api_key_secret_id: uuid("api_key_secret_id"),

    // Permissions granted
    granted_permissions: jsonb("granted_permissions").$type<string[]>().default([]),

    // Source context - where did the link come from?
    source_type: text("source_type"), // "discord" | "telegram" | "web" | "api"
    source_context: jsonb("source_context").$type<{
      server_id?: string;
      channel_id?: string;
      message_id?: string;
      referrer?: string;
      agentGoogleSide?: "owner" | "agent";
      connectionRole?: "OWNER" | "AGENT" | "TEAM";
    }>(),

    // Raw profile data from OAuth provider
    profile_data: jsonb("profile_data").$type<Record<string, unknown>>(),

    // Timestamps
    created_at: timestamp("created_at").notNull().defaultNow(),
    linked_at: timestamp("linked_at"),
    last_used_at: timestamp("last_used_at"),
    last_refreshed_at: timestamp("last_refreshed_at"),
    expires_at: timestamp("expires_at"),
    revoked_at: timestamp("revoked_at"),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    org_idx: index("platform_credentials_org_idx").on(table.organization_id),
    user_idx: index("platform_credentials_user_idx").on(table.user_id),
    app_idx: index("platform_credentials_app_idx").on(table.app_id),
    platform_user_idx: uniqueIndex("platform_credentials_platform_user_idx").on(
      table.organization_id,
      table.platform,
      table.platform_user_id,
    ),
    status_idx: index("platform_credentials_status_idx").on(table.status),
  }),
);

// =============================================================================
// CREDENTIAL LINK SESSIONS
// =============================================================================

/**
 * Temporary sessions for the OAuth credential linking flow.
 * Generated when an app requests a credential link URL.
 */
export const platformCredentialSessions = pgTable(
  "platform_credential_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Unique session identifier (in URL)
    session_id: text("session_id").notNull().unique(),

    // Who is requesting the credential
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    app_id: uuid("app_id").references(() => apps.id, { onDelete: "cascade" }),
    requesting_user_id: uuid("requesting_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    // What platform is being linked
    platform: platformCredentialTypeEnum("platform").notNull(),

    // Requested permissions/scopes
    requested_scopes: jsonb("requested_scopes").$type<string[]>().default([]),

    // OAuth state for CSRF protection
    oauth_state: text("oauth_state").notNull(),

    // Where to redirect/notify after completion
    callback_url: text("callback_url"),
    callback_type: text("callback_type"), // "redirect" | "webhook" | "message"
    callback_context: jsonb("callback_context").$type<{
      platform?: string; // "discord" | "telegram"
      server_id?: string;
      channel_id?: string;
      user_id?: string;
      instanceUrl?: string; // Mastodon instance URL
    }>(),

    // Session status
    status: text("status").notNull().default("pending"), // pending | completed | expired | failed

    // Result
    credential_id: uuid("credential_id").references(() => platformCredentials.id, {
      onDelete: "set null",
    }),
    error_code: text("error_code"),
    error_message: text("error_message"),

    // Timestamps
    created_at: timestamp("created_at").notNull().defaultNow(),
    expires_at: timestamp("expires_at").notNull(),
    completed_at: timestamp("completed_at"),
  },
  (table) => ({
    session_id_idx: index("platform_credential_sessions_session_idx").on(table.session_id),
    org_idx: index("platform_credential_sessions_org_idx").on(table.organization_id),
    oauth_state_idx: uniqueIndex("platform_credential_sessions_oauth_state_idx").on(
      table.oauth_state,
    ),
    status_idx: index("platform_credential_sessions_status_idx").on(table.status),
    expires_idx: index("platform_credential_sessions_expires_idx").on(table.expires_at),
  }),
);

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type PlatformCredential = typeof platformCredentials.$inferSelect;
export type NewPlatformCredential = typeof platformCredentials.$inferInsert;

export type PlatformCredentialSession = typeof platformCredentialSessions.$inferSelect;
export type NewPlatformCredentialSession = typeof platformCredentialSessions.$inferInsert;

export type PlatformType = PlatformCredential["platform"];
