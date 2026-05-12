import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
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

export const secretScopeEnum = pgEnum("secret_scope", ["organization", "project", "environment"]);

export const secretEnvironmentEnum = pgEnum("secret_environment", [
  "development",
  "preview",
  "production",
]);

export const secretAuditActionEnum = pgEnum("secret_audit_action", [
  "created",
  "read",
  "updated",
  "deleted",
  "rotated",
]);

export const secretActorTypeEnum = pgEnum("secret_actor_type", [
  "user",
  "api_key",
  "system",
  "deployment",
  "workflow",
]);

export const secretProviderEnum = pgEnum("secret_provider", [
  "openai",
  "anthropic",
  "google",
  "elevenlabs",
  "fal",
  "stripe",
  "discord",
  "telegram",
  "twitter",
  "github",
  "slack",
  "aws",
  "custom",
]);

export const secretProjectTypeEnum = pgEnum("secret_project_type", [
  "character",
  "app",
  "workflow",
  "container",
  "mcp",
]);

export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scope: secretScopeEnum("scope").notNull().default("organization"),
    project_id: uuid("project_id"),
    project_type: text("project_type"),
    environment: secretEnvironmentEnum("environment"),
    name: text("name").notNull(),
    description: text("description"),
    provider: secretProviderEnum("provider"),
    provider_metadata: jsonb("provider_metadata").$type<{
      pattern?: string;
      testUrl?: string;
      testMethod?: string;
      validated?: boolean;
      lastValidatedAt?: string;
    }>(),
    encrypted_value: text("encrypted_value").notNull(),
    encryption_key_id: text("encryption_key_id").notNull(),
    encrypted_dek: text("encrypted_dek").notNull(),
    nonce: text("nonce").notNull(),
    auth_tag: text("auth_tag").notNull(),
    version: integer("version").default(1).notNull(),
    last_rotated_at: timestamp("last_rotated_at"),
    expires_at: timestamp("expires_at"),
    created_by: uuid("created_by")
      .notNull()
      .references(() => users.id),
    last_accessed_at: timestamp("last_accessed_at"),
    access_count: integer("access_count").default(0).notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    org_name_project_env_idx: uniqueIndex("secrets_org_name_project_env_idx").on(
      table.organization_id,
      table.name,
      table.project_id,
      table.environment,
    ),
    org_idx: index("secrets_org_idx").on(table.organization_id),
    project_idx: index("secrets_project_idx").on(table.project_id),
    scope_idx: index("secrets_scope_idx").on(table.scope),
    env_idx: index("secrets_env_idx").on(table.environment),
    name_idx: index("secrets_name_idx").on(table.name),
    expires_idx: index("secrets_expires_idx").on(table.expires_at),
    provider_idx: index("secrets_provider_idx").on(table.provider),
  }),
);

/**
 * Secret bindings - allows attaching org-level secrets to specific projects
 * This enables reusing secrets across multiple projects without duplication
 */
export const secretBindings = pgTable(
  "secret_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    secret_id: uuid("secret_id")
      .notNull()
      .references(() => secrets.id, { onDelete: "cascade" }),
    project_id: uuid("project_id").notNull(),
    project_type: secretProjectTypeEnum("project_type").notNull(),
    created_by: uuid("created_by")
      .notNull()
      .references(() => users.id),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    secret_project_idx: uniqueIndex("secret_bindings_secret_project_idx").on(
      table.secret_id,
      table.project_id,
      table.project_type,
    ),
    org_idx: index("secret_bindings_org_idx").on(table.organization_id),
    project_idx: index("secret_bindings_project_idx").on(table.project_id, table.project_type),
    secret_idx: index("secret_bindings_secret_idx").on(table.secret_id),
  }),
);

/**
 * App secret requirements - declares which secrets an app needs access to
 * Requires admin approval before the app can access the secret
 */
export const appSecretRequirements = pgTable(
  "app_secret_requirements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    secret_name: text("secret_name").notNull(),
    required: boolean("required").default(true).notNull(),
    approved: boolean("approved").default(false).notNull(),
    approved_by: uuid("approved_by").references(() => users.id),
    approved_at: timestamp("approved_at"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    app_secret_idx: uniqueIndex("app_secret_requirements_app_secret_idx").on(
      table.app_id,
      table.secret_name,
    ),
    app_idx: index("app_secret_requirements_app_idx").on(table.app_id),
    approved_idx: index("app_secret_requirements_approved_idx").on(table.approved),
  }),
);

export const oauthSessions = pgTable(
  "oauth_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    provider: text("provider").notNull(),
    provider_account_id: text("provider_account_id"),
    encrypted_access_token: text("encrypted_access_token").notNull(),
    encrypted_refresh_token: text("encrypted_refresh_token"),
    token_type: text("token_type").default("Bearer"),
    encryption_key_id: text("encryption_key_id").notNull(),
    encrypted_dek: text("encrypted_dek").notNull(),
    nonce: text("nonce").notNull(),
    auth_tag: text("auth_tag").notNull(),
    refresh_encrypted_dek: text("refresh_encrypted_dek"),
    refresh_nonce: text("refresh_nonce"),
    refresh_auth_tag: text("refresh_auth_tag"),
    scopes: jsonb("scopes").$type<string[]>().default([]).notNull(),
    access_token_expires_at: timestamp("access_token_expires_at"),
    refresh_token_expires_at: timestamp("refresh_token_expires_at"),
    encrypted_provider_data: text("encrypted_provider_data"),
    provider_data_nonce: text("provider_data_nonce"),
    provider_data_auth_tag: text("provider_data_auth_tag"),
    last_used_at: timestamp("last_used_at"),
    last_refreshed_at: timestamp("last_refreshed_at"),
    refresh_count: integer("refresh_count").default(0).notNull(),
    is_valid: boolean("is_valid").default(true).notNull(),
    revoked_at: timestamp("revoked_at"),
    revoke_reason: text("revoke_reason"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    org_provider_idx: uniqueIndex("oauth_sessions_org_provider_idx").on(
      table.organization_id,
      table.provider,
      table.user_id,
    ),
    user_provider_idx: index("oauth_sessions_user_provider_idx").on(table.user_id, table.provider),
    provider_idx: index("oauth_sessions_provider_idx").on(table.provider),
    expires_idx: index("oauth_sessions_expires_idx").on(table.access_token_expires_at),
    valid_idx: index("oauth_sessions_valid_idx").on(table.is_valid),
  }),
);

export const secretAuditLog = pgTable(
  "secret_audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    secret_id: uuid("secret_id"),
    oauth_session_id: uuid("oauth_session_id"),
    organization_id: uuid("organization_id").notNull(),
    action: secretAuditActionEnum("action").notNull(),
    secret_name: text("secret_name"),
    actor_type: secretActorTypeEnum("actor_type").notNull(),
    actor_id: text("actor_id").notNull(),
    actor_email: text("actor_email"),
    ip_address: text("ip_address"),
    user_agent: text("user_agent"),
    source: text("source"),
    request_id: text("request_id"),
    endpoint: text("endpoint"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    secret_idx: index("secret_audit_log_secret_idx").on(table.secret_id),
    oauth_idx: index("secret_audit_log_oauth_idx").on(table.oauth_session_id),
    org_idx: index("secret_audit_log_org_idx").on(table.organization_id),
    action_idx: index("secret_audit_log_action_idx").on(table.action),
    actor_idx: index("secret_audit_log_actor_idx").on(table.actor_type, table.actor_id),
    created_at_idx: index("secret_audit_log_created_at_idx").on(table.created_at),
    org_action_time_idx: index("secret_audit_log_org_action_time_idx").on(
      table.organization_id,
      table.action,
      table.created_at,
    ),
  }),
);

export type Secret = InferSelectModel<typeof secrets>;
export type NewSecret = InferInsertModel<typeof secrets>;

export type OAuthSession = InferSelectModel<typeof oauthSessions>;
export type NewOAuthSession = InferInsertModel<typeof oauthSessions>;

export type SecretAuditLog = InferSelectModel<typeof secretAuditLog>;
export type NewSecretAuditLog = InferInsertModel<typeof secretAuditLog>;

export type SecretBinding = InferSelectModel<typeof secretBindings>;
export type NewSecretBinding = InferInsertModel<typeof secretBindings>;

export type AppSecretRequirement = InferSelectModel<typeof appSecretRequirements>;
export type NewAppSecretRequirement = InferInsertModel<typeof appSecretRequirements>;

export type SecretScope = "organization" | "project" | "environment";
export type SecretEnvironment = "development" | "preview" | "production";
export type SecretAuditAction = "created" | "read" | "updated" | "deleted" | "rotated";
export type SecretActorType = "user" | "api_key" | "system" | "deployment" | "workflow";
export type SecretProvider =
  | "openai"
  | "anthropic"
  | "google"
  | "elevenlabs"
  | "fal"
  | "stripe"
  | "discord"
  | "telegram"
  | "twitter"
  | "github"
  | "slack"
  | "aws"
  | "custom";
export type SecretProjectType = "character" | "app" | "workflow" | "container" | "mcp";
