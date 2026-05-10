/**
 * Agent Browser Bridge Drizzle schema.
 *
 * The four generic browser tables (`browser_bridge_companions`,
 * `browser_bridge_settings`, `browser_bridge_tabs`,
 * `browser_bridge_page_contexts`) are owned by this plugin. The
 * workflow-bound `life_browser_sessions` table remains in LifeOps because
 * it carries `workflowId` plus LifeOps-only scoping columns.
 *
 * Tables are placed in the `browser` PostgreSQL schema (matches the
 * `deriveSchemaName("@elizaos/plugin-browser")` result used by
 * plugin-sql's runtime migrator) so they no longer trip the
 * "Plugin table is using public schema" warning. The runtime migrator
 * issues `CREATE SCHEMA IF NOT EXISTS` automatically before applying
 * migrations.
 *
 * Migrations are applied via elizaOS plugin-sql's `runPluginMigrations`
 * when the plugin's `schema` field is populated and an appropriate
 * migration strategy is selected. Renaming the old `life_browser_*`
 * tables to `browser_bridge_*` is a destructive migration — gate it on
 * `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true`.
 */

import {
  boolean,
  index,
  integer,
  pgSchema,
  text,
  unique,
} from "drizzle-orm/pg-core";

export const browserPgSchema = pgSchema("browser");

export const browserBridgeCompanions = browserPgSchema.table(
  "browser_bridge_companions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    browser: text("browser").notNull(),
    profileId: text("profile_id").notNull(),
    profileLabel: text("profile_label").notNull().default(""),
    label: text("label").notNull().default(""),
    extensionVersion: text("extension_version"),
    connectionState: text("connection_state").notNull().default("disconnected"),
    permissionsJson: text("permissions_json").notNull().default("{}"),
    pairingTokenHash: text("pairing_token_hash"),
    pairingTokenExpiresAt: text("pairing_token_expires_at"),
    pairingTokenRevokedAt: text("pairing_token_revoked_at"),
    pendingPairingTokenHashesJson: text("pending_pairing_token_hashes_json")
      .notNull()
      .default("[]"),
    lastSeenAt: text("last_seen_at"),
    pairedAt: text("paired_at"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.browser, t.profileId),
    index("idx_browser_bridge_companions_agent").on(
      t.agentId,
      t.browser,
      t.updatedAt,
    ),
  ],
);

export const browserBridgeSettings = browserPgSchema.table(
  "browser_bridge_settings",
  {
    agentId: text("agent_id").primaryKey(),
    enabled: boolean("enabled").notNull().default(false),
    trackingMode: text("tracking_mode").notNull().default("current_tab"),
    allowBrowserControl: boolean("allow_browser_control")
      .notNull()
      .default(false),
    requireConfirmationForAccountAffecting: boolean(
      "require_confirmation_for_account_affecting",
    )
      .notNull()
      .default(true),
    incognitoEnabled: boolean("incognito_enabled").notNull().default(false),
    siteAccessMode: text("site_access_mode")
      .notNull()
      .default("current_site_only"),
    grantedOriginsJson: text("granted_origins_json").notNull().default("[]"),
    blockedOriginsJson: text("blocked_origins_json").notNull().default("[]"),
    maxRememberedTabs: integer("max_remembered_tabs").notNull().default(10),
    pauseUntil: text("pause_until"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
);

export const browserBridgeTabs = browserPgSchema.table(
  "browser_bridge_tabs",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    companionId: text("companion_id"),
    browser: text("browser").notNull(),
    profileId: text("profile_id").notNull(),
    windowId: text("window_id").notNull(),
    tabId: text("tab_id").notNull(),
    url: text("url").notNull().default(""),
    title: text("title").notNull().default(""),
    activeInWindow: boolean("active_in_window").notNull().default(false),
    focusedWindow: boolean("focused_window").notNull().default(false),
    focusedActive: boolean("focused_active").notNull().default(false),
    incognito: boolean("incognito").notNull().default(false),
    faviconUrl: text("favicon_url"),
    lastSeenAt: text("last_seen_at").notNull(),
    lastFocusedAt: text("last_focused_at"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.browser, t.profileId, t.windowId, t.tabId),
    index("idx_browser_bridge_tabs_agent").on(
      t.agentId,
      t.focusedActive,
      t.activeInWindow,
      t.lastSeenAt,
    ),
  ],
);

export const browserBridgePageContexts = browserPgSchema.table(
  "browser_bridge_page_contexts",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    browser: text("browser").notNull(),
    profileId: text("profile_id").notNull(),
    windowId: text("window_id").notNull(),
    tabId: text("tab_id").notNull(),
    url: text("url").notNull().default(""),
    title: text("title").notNull().default(""),
    selectionText: text("selection_text"),
    mainText: text("main_text"),
    headingsJson: text("headings_json").notNull().default("[]"),
    linksJson: text("links_json").notNull().default("[]"),
    formsJson: text("forms_json").notNull().default("[]"),
    capturedAt: text("captured_at").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
  },
  (t) => [
    unique().on(t.agentId, t.browser, t.profileId, t.windowId, t.tabId),
    index("idx_browser_bridge_page_contexts_agent").on(t.agentId, t.capturedAt),
  ],
);

export const browserBridgeSchema = {
  browserBridgeCompanions,
  browserBridgeSettings,
  browserBridgeTabs,
  browserBridgePageContexts,
} as const;
