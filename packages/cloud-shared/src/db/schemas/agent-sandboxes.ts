/**
 * Managed Eliza agent sandboxes.
 *
 * These are NOT the same as user-deployed containers (`containers` table).
 *
 * agent_sandboxes — system-managed, full-lifecycle Eliza agent instances
 * ─────────────────────────────────────────────────────────────────────────
 *   • Provisioned by the system as part of agent creation flows (character
 *     creation, `eliza-sandbox.ts`, `provisioning-jobs.ts` worker).
 *   • Each row has a managed Neon PostgreSQL database, a bridge proxy URL,
 *     a heartbeat monitor, backup snapshots, pairing tokens, and optional
 *     headscale VPN allocation.
 *   • Async multi-step provisioning via the jobs queue.
 *   • Supporting tables: `agent_sandbox_backups`, `agent_pairing_tokens`,
 *     `remote_sessions`.
 *   • Billing: hourly rate with active/warning/suspended/exempt tiers.
 *
 * containers — user-deployed arbitrary Docker workloads
 * ─────────────────────────────────────────────────────────────────────────
 *   • Created explicitly by the user via `POST /api/v1/containers`.
 *   • User supplies image, env vars, port; the control plane runs
 *     docker pull + docker create + docker start over SSH.
 *   • Supports persistent project volumes (local host dir or Hetzner Cloud
 *     block device), stable public hostnames, and the ingress map endpoint.
 *   • Supporting tables: `container_billing_records`.
 *   • Billing: daily credit deductions per `container_billing_records`.
 *
 * Why they are separate: the two domains share a compute substrate
 * (Hetzner-Docker pool) but nothing else. Merging them would force every
 * query, service, billing cron, and API route to discriminate on a type
 * tag between two entirely different sets of nullable columns. The cost of
 * that polymorphism is higher than the cost of two clearly-scoped tables.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { userCharacters } from "./user-characters";
import { users } from "./users";

export type AgentSandboxStatus =
  | "pending"
  | "provisioning"
  | "running"
  | "stopped"
  | "disconnected"
  | "error";

export type AgentBillingStatus = "active" | "warning" | "suspended" | "shutdown_pending" | "exempt";

export const agentSandboxes = pgTable(
  "agent_sandboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    character_id: uuid("character_id").references(() => userCharacters.id, {
      onDelete: "set null",
    }),
    sandbox_id: text("sandbox_id"),
    status: text("status").$type<AgentSandboxStatus>().notNull().default("pending"),
    bridge_url: text("bridge_url"),
    health_url: text("health_url"),
    agent_name: text("agent_name"),
    agent_config: jsonb("agent_config").$type<Record<string, unknown>>(),
    neon_project_id: text("neon_project_id"),
    neon_branch_id: text("neon_branch_id"),
    database_uri: text("database_uri"),
    database_status: text("database_status")
      .$type<"none" | "provisioning" | "ready" | "error">()
      .notNull()
      .default("none"),
    database_error: text("database_error"),
    snapshot_id: text("snapshot_id"),
    last_backup_at: timestamp("last_backup_at", { withTimezone: true }),
    last_heartbeat_at: timestamp("last_heartbeat_at", { withTimezone: true }),
    error_message: text("error_message"),
    error_count: integer("error_count").notNull().default(0),
    environment_vars: jsonb("environment_vars")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    // Docker infrastructure columns (added by 0047_docker_nodes migration)
    node_id: text("node_id"),
    container_name: text("container_name"),
    bridge_port: integer("bridge_port"),
    web_ui_port: integer("web_ui_port"),
    headscale_ip: text("headscale_ip"),
    docker_image: text("docker_image"),
    // Billing tracking fields (mirrors containers table pattern)
    billing_status: text("billing_status").$type<AgentBillingStatus>().notNull().default("active"),
    last_billed_at: timestamp("last_billed_at", { withTimezone: true }),
    hourly_rate: numeric("hourly_rate", { precision: 10, scale: 4 }).default("0.0100"),
    total_billed: numeric("total_billed", { precision: 10, scale: 2 }).default("0.00").notNull(),
    shutdown_warning_sent_at: timestamp("shutdown_warning_sent_at", {
      withTimezone: true,
    }),
    scheduled_shutdown_at: timestamp("scheduled_shutdown_at", {
      withTimezone: true,
    }),
    // Warm pool tracking. `pool_status` is null for user-owned rows and
    // 'unclaimed' for pool entries owned by the sentinel pool org.
    pool_status: text("pool_status").$type<AgentSandboxPoolStatus>(),
    pool_ready_at: timestamp("pool_ready_at", { withTimezone: true }),
    claimed_at: timestamp("claimed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organization_idx: index("agent_sandboxes_organization_idx").on(table.organization_id),
    user_idx: index("agent_sandboxes_user_idx").on(table.user_id),
    status_idx: index("agent_sandboxes_status_idx").on(table.status),
    character_idx: index("agent_sandboxes_character_idx").on(table.character_id),
    sandbox_id_idx: index("agent_sandboxes_sandbox_id_idx").on(table.sandbox_id),
    billing_status_idx: index("agent_sandboxes_billing_status_idx").on(table.billing_status),
  }),
);

/** Sentinel UUIDs that own warm pool rows. Mirrors migration 0107. */
export const WARM_POOL_ORG_ID = "00000000-0000-4000-8000-000000077001";
export const WARM_POOL_USER_ID = "00000000-0000-4000-8000-000000077002";

export type AgentSandboxPoolStatus = "unclaimed";

export type AgentBackupSnapshotType = "auto" | "manual" | "pre-shutdown";

export interface AgentBackupStateData {
  memories: Array<{ role: string; text: string; timestamp: number }>;
  config: Record<string, unknown>;
  workspaceFiles: Record<string, string>;
}

export const agentSandboxBackups = pgTable(
  "agent_sandbox_backups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sandbox_record_id: uuid("sandbox_record_id")
      .notNull()
      .references(() => agentSandboxes.id, { onDelete: "cascade" }),
    snapshot_type: text("snapshot_type").$type<AgentBackupSnapshotType>().notNull(),
    state_data: jsonb("state_data").$type<AgentBackupStateData>().notNull(),
    state_data_storage: text("state_data_storage").notNull().default("inline"),
    state_data_key: text("state_data_key"),
    size_bytes: bigint("size_bytes", { mode: "number" }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sandbox_record_idx: index("agent_sandbox_backups_sandbox_idx").on(table.sandbox_record_id),
    created_at_idx: index("agent_sandbox_backups_created_at_idx").on(table.created_at),
  }),
);

export type AgentSandbox = InferSelectModel<typeof agentSandboxes>;
export type NewAgentSandbox = InferInsertModel<typeof agentSandboxes>;
export type AgentSandboxBackup = InferSelectModel<typeof agentSandboxBackups>;
export type NewAgentSandboxBackup = InferInsertModel<typeof agentSandboxBackups>;
