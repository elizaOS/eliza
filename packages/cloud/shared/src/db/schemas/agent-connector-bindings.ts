/**
 * Agent-scoped connector authorization records for Cloud execution. These rows
 * bind a canonical character/runtime identity to an existing platform
 * credential without copying token material into agent configuration.
 */
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { platformCredentials } from "./platform-credentials";
import { userCharacters } from "./user-characters";
import { users } from "./users";

export const CLOUD_CONNECTOR_BINDING_ROLES = ["OWNER", "AGENT", "TEAM"] as const;
export type CloudConnectorBindingRole = (typeof CLOUD_CONNECTOR_BINDING_ROLES)[number];

export const CLOUD_CONNECTOR_BINDING_STATUSES = [
  "connected",
  "pending",
  "disabled",
  "revoked",
  "error",
] as const;
export type CloudConnectorBindingStatus = (typeof CLOUD_CONNECTOR_BINDING_STATUSES)[number];

export const CLOUD_CONNECTOR_OAUTH_MODES = ["eliza_managed", "bring_your_own"] as const;
export type CloudConnectorOAuthMode = (typeof CLOUD_CONNECTOR_OAUTH_MODES)[number];

export const CLOUD_CONNECTOR_EXECUTION_TARGETS = ["cloud_broker", "agent_host"] as const;
export type CloudConnectorExecutionTarget = (typeof CLOUD_CONNECTOR_EXECUTION_TARGETS)[number];

export const agentConnectorBindings = pgTable(
  "agent_connector_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agent_id: uuid("agent_id")
      .notNull()
      .references(() => userCharacters.id, { onDelete: "cascade" }),
    platform_credential_id: uuid("platform_credential_id")
      .notNull()
      .references(() => platformCredentials.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    role: text("role").$type<CloudConnectorBindingRole>().notNull(),
    purposes: jsonb("purposes").$type<string[]>().notNull().default([]),
    access_gate: text("access_gate").notNull().default("open"),
    status: text("status").$type<CloudConnectorBindingStatus>().notNull().default("connected"),
    oauth_mode: text("oauth_mode")
      .$type<CloudConnectorOAuthMode>()
      .notNull()
      .default("eliza_managed"),
    execution_target: text("execution_target")
      .$type<CloudConnectorExecutionTarget>()
      .notNull()
      .default("cloud_broker"),
    selected_products: jsonb("selected_products").$type<string[]>().notNull().default([]),
    allowed_capabilities: jsonb("allowed_capabilities").$type<string[]>().notNull().default([]),
    is_default: boolean("is_default").notNull().default(false),
    owner_binding_id: uuid("owner_binding_id").references(
      (): AnyPgColumn => agentConnectorBindings.id,
      { onDelete: "set null" },
    ),
    owner_identity_id: text("owner_identity_id"),
    authorized_by_user_id: uuid("authorized_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    org_agent_provider_idx: index("idx_agent_connector_bindings_org_agent_provider").on(
      table.organization_id,
      table.agent_id,
      table.provider,
    ),
    active_credential_unique: uniqueIndex("uq_agent_connector_bindings_active_credential")
      .on(table.agent_id, table.provider, table.platform_credential_id)
      .where(sql`${table.deleted_at} IS NULL`),
    default_role_unique: uniqueIndex("uq_agent_connector_bindings_default_role")
      .on(table.agent_id, table.provider, table.role)
      .where(sql`${table.deleted_at} IS NULL AND ${table.is_default} = true`),
    credential_idx: index("idx_agent_connector_bindings_credential").on(
      table.platform_credential_id,
    ),
    role_check: check(
      "agent_connector_bindings_role_check",
      sql`${table.role} IN ('OWNER','AGENT','TEAM')`,
    ),
    status_check: check(
      "agent_connector_bindings_status_check",
      sql`${table.status} IN ('connected','pending','disabled','revoked','error')`,
    ),
    oauth_mode_check: check(
      "agent_connector_bindings_oauth_mode_check",
      sql`${table.oauth_mode} IN ('eliza_managed','bring_your_own')`,
    ),
    execution_target_check: check(
      "agent_connector_bindings_execution_target_check",
      sql`${table.execution_target} IN ('cloud_broker','agent_host')`,
    ),
  }),
);

export type AgentConnectorBindingRow = InferSelectModel<typeof agentConnectorBindings>;
export type NewAgentConnectorBindingRow = InferInsertModel<typeof agentConnectorBindings>;
