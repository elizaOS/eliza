/**
 * Managed Eliza agent sandboxes.
 *
 * These are NOT the same as user-deployed containers (`containers` table).
 *
 * agent_sandboxes — system-managed, full-lifecycle Eliza agent instances
 * ─────────────────────────────────────────────────────────────────────────
 *   • Provisioned by the system as part of agent creation flows (character
 *     creation, `eliza-sandbox.ts`, `provisioning-jobs.ts` worker).
 *   • Each row has a managed PostgreSQL database, a bridge proxy URL,
 *     a heartbeat monitor, backup snapshots, pairing tokens, and optional
 *     headscale VPN allocation.
 *   • Async multi-step provisioning via the jobs queue.
 *   • Supporting tables: `agent_sandbox_backups`, `agent_pairing_tokens`,
 *     `remote_sessions`.
 *   • Billing: hourly rate with active/warning/suspended/exempt tiers.
 *
 * containers — user-deployed arbitrary Docker workloads (LEGACY)
 * ─────────────────────────────────────────────────────────────────────────
 *   • DEPRECATED — user-facing CRUD removed; table kept for history.
 *   • Historical rows reachable via admin infra dashboard only.
 *   • Supporting tables: `container_billing_records`.
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
  /**
   * Cold storage. The agent's full state has been backed up to object
   * storage and its container removed, freeing the compute slot (the node
   * autoscaler reclaims the now-empty Hetzner box). No compute cost accrues.
   * An `agent_wake` job provisions a fresh container and restores state.
   * Distinct from `stopped` (suspend), which also drops the container and
   * frees the node slot but keeps the row's `sandbox_id` for a lighter
   * in-place resume; both retain the per-tenant managed DB.
   */
  | "sleeping"
  | "disconnected"
  | "error"
  /**
   * Row is queued for async deletion. An `agent_delete` job has been
   * enqueued in `jobs`; the provisioning worker will SSH the core, stop
   * the container, and then DELETE the row. UI must treat this as
   * "soon-to-be-gone" — no mutations should be accepted while in this
   * state.
   */
  | "deletion_pending"
  /**
   * Async deletion exhausted retries (e.g. SSH unreachable for the core
   * hosting this sandbox). The container may still be running on the
   * core; ops must investigate. Row stays so the failure is visible.
   */
  | "deletion_failed";

export type AgentBillingStatus = "active" | "warning" | "suspended" | "shutdown_pending" | "exempt";

/**
 * How an agent runs. "shared" agents run container-free in the hosted shared
 * runtime (chat/webhook/cron turns via a hosted LLM); the other tiers get a
 * dedicated container. New agents default to "shared"; the column-adding
 * migration backfills pre-existing rows to "dedicated-lazy" because they already
 * have containers. See services/shared-runtime/agent-tier.ts for derivation.
 */
export type AgentExecutionTier = "shared" | "dedicated-lazy" | "dedicated-always" | "custom";

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
    /**
     * Execution tier (see AgentExecutionTier). New agents default to "shared"
     * (container-free); only a real need escalates to a dedicated container.
     * The migration backfills pre-existing container rows to "dedicated-lazy".
     */
    execution_tier: text("execution_tier").$type<AgentExecutionTier>().notNull().default("shared"),
    bridge_url: text("bridge_url"),
    health_url: text("health_url"),
    agent_name: text("agent_name"),
    agent_config: jsonb("agent_config").$type<Record<string, unknown>>(),
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
    /**
     * Registry-resolved sha256 digest of the image this agent is actually
     * running. Stamped at provision time (and re-stamped after a successful
     * fleet upgrade). The reconciler compares this against the current
     * registry digest of the configured tag to decide who needs an upgrade.
     * Null on rows provisioned before the fleet-upgrade feature shipped —
     * those are treated as "upgrade on next cycle".
     */
    image_digest: text("image_digest"),
    /**
     * The image digest the agent ran on BEFORE its most recent fleet upgrade —
     * the rollback target. Stamped at upgrade swap time from the old row's
     * `image_digest`; `executeDowngrade` swaps the agent back onto this digest.
     * Null until the first upgrade. Additive: pre-upgrade rows have no prior
     * good image to roll back to, so rollback is simply unavailable for them.
     */
    previous_image_digest: text("previous_image_digest"),
    /**
     * The `docker_image` ref the agent ran on before its most recent upgrade.
     * For managed-fleet agents this matches the current `docker_image`, but it
     * is captured explicitly so a rollback can reconstruct the exact prior
     * image reference (`<ref>@<previous_image_digest>`) without assuming the
     * tag is unchanged. Null until the first upgrade.
     */
    previous_docker_image: text("previous_docker_image"),
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
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    organization_idx: index("agent_sandboxes_organization_idx").on(table.organization_id),
    user_idx: index("agent_sandboxes_user_idx").on(table.user_id),
    status_idx: index("agent_sandboxes_status_idx").on(table.status),
    character_idx: index("agent_sandboxes_character_idx").on(table.character_id),
    sandbox_id_idx: index("agent_sandboxes_sandbox_id_idx").on(table.sandbox_id),
    billing_status_idx: index("agent_sandboxes_billing_status_idx").on(table.billing_status),
    deleted_at_idx: index("agent_sandboxes_deleted_at_idx").on(table.deleted_at),
  }),
);

/** Sentinel UUIDs that own warm pool rows. Mirrors migration 0107. */
export const WARM_POOL_ORG_ID = "00000000-0000-4000-8000-000000077001";
export const WARM_POOL_USER_ID = "00000000-0000-4000-8000-000000077002";

export type AgentSandboxPoolStatus = "unclaimed";

export type AgentBackupSnapshotType = "auto" | "manual" | "pre-shutdown" | "pre-upgrade";

/**
 * Whether a backup row stores the agent's complete state (`full`) or only the
 * delta against `parent_backup_id` (`incremental`). Restoring an incremental
 * backup replays its parent chain back to the nearest `full` backup. See
 * `agent-backup-diff.ts` for the delta format and reconstruction.
 */
export type AgentBackupKind = "full" | "incremental";

export interface AgentBackupFileEntry {
  path: string;
  sha256: string;
  size: number;
  mode?: number;
  mtimeMs?: number;
  bytesBase64: string;
}

export interface AgentBackupFileSet {
  kind: "file-set";
  rootLabel: "state-dir" | "pglite-dir";
  rootPath?: string;
  files: AgentBackupFileEntry[];
  sha256: string;
}

export interface AgentBackupPostgresTable {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface AgentBackupPostgresDump {
  kind: "postgres-rows";
  tables: AgentBackupPostgresTable[];
  sha256: string;
}

export interface AgentBackupManifest {
  schemaVersion: 1;
  format: "elizaos.agent-backup";
  createdAt: string;
  agentId: string;
  components: {
    database: {
      kind: "pglite-files" | "postgres-rows" | "none";
      pglite?: AgentBackupFileSet;
      postgres?: AgentBackupPostgresDump;
      reason?: string;
      sha256: string;
    };
    media: AgentBackupFileSet;
    vault: AgentBackupFileSet;
    character: {
      runtimeCharacter: unknown;
      configFile?: AgentBackupFileEntry;
      sha256: string;
    };
    stateFiles: AgentBackupFileSet;
  };
  integrity: {
    componentHashes: Record<string, string>;
  };
}

export interface AgentBackupStateData {
  memories: Array<{ role: string; text: string; timestamp: number }>;
  config: Record<string, unknown>;
  workspaceFiles: Record<string, string>;
  /**
   * Real full-agent backup manifest returned by the deployed @elizaos/agent
   * image. The legacy fields above remain for compatibility with older
   * template images and cloud UI summaries, but this manifest is the durable
   * restore surface: DB, media, vault, character, and remaining state-dir files.
   */
  manifest?: AgentBackupManifest;
}

export interface AgentBackupDeltaData {
  filesChanged: Record<string, string>;
  filesRemoved: string[];
  configChanged: Record<string, unknown>;
  configRemoved: string[];
  memoriesBaseCount: number;
  memoriesAppended: AgentBackupStateData["memories"];
}

export type AgentBackupPlainStateData = AgentBackupStateData | AgentBackupDeltaData;

export interface EncryptedAgentBackupStateData {
  kind: "encrypted-agent-backup-state";
  algorithm: "kms-aes-256-gcm";
  ciphertext: string;
  nonce: string;
  auth_tag: string;
  kms_key_id: string;
  kms_key_version: number;
}

export type AgentBackupStoredStateData = AgentBackupPlainStateData | EncryptedAgentBackupStateData;

export const agentSandboxBackups = pgTable(
  "agent_sandbox_backups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sandbox_record_id: uuid("sandbox_record_id")
      .notNull()
      .references(() => agentSandboxes.id, { onDelete: "cascade" }),
    snapshot_type: text("snapshot_type").$type<AgentBackupSnapshotType>().notNull(),
    /**
     * For `full` backups, `state_data` is the complete state. For
     * `incremental` backups, it is the `BackupDelta` against `parent_backup_id`.
     * The repository encrypts both shapes at rest and decrypts them before
     * returning an AgentSandboxBackup to callers.
     */
    state_data: jsonb("state_data").$type<AgentBackupStoredStateData>().notNull(),
    state_data_storage: text("state_data_storage").notNull().default("inline"),
    state_data_key: text("state_data_key"),
    size_bytes: bigint("size_bytes", { mode: "number" }),
    backup_kind: text("backup_kind").$type<AgentBackupKind>().notNull().default("full"),
    /** Set only on `incremental` rows: the backup this delta builds on. */
    parent_backup_id: uuid("parent_backup_id"),
    /** sha256 of the reconstructed full state, for integrity verification. */
    content_hash: text("content_hash"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sandbox_record_idx: index("agent_sandbox_backups_sandbox_idx").on(table.sandbox_record_id),
    created_at_idx: index("agent_sandbox_backups_created_at_idx").on(table.created_at),
    parent_backup_idx: index("agent_sandbox_backups_parent_idx").on(table.parent_backup_id),
  }),
);

export type AgentSandbox = InferSelectModel<typeof agentSandboxes>;
export type NewAgentSandbox = InferInsertModel<typeof agentSandboxes>;
export type StoredAgentSandboxBackup = InferSelectModel<typeof agentSandboxBackups>;
export type AgentSandboxBackup = Omit<StoredAgentSandboxBackup, "state_data"> & {
  state_data: AgentBackupPlainStateData;
};
export type NewAgentSandboxBackup = Omit<
  InferInsertModel<typeof agentSandboxBackups>,
  "state_data"
> & {
  state_data: AgentBackupStoredStateData;
};
