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

import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { userCharacters } from "./user-characters";
import { users } from "./users";

/** Monotone per-agent authority shared by every backup in a catalogue chain. */
export const agentBackupCatalogAuthorities = pgTable(
  "agent_backup_catalog_authorities",
  {
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    agent_id: uuid("agent_id").notNull(),
    catalog_revision: bigint("catalog_revision", { mode: "bigint" }).notNull().default(sql`0`),
    restore_generation: bigint("restore_generation", { mode: "bigint" }).notNull().default(sql`0`),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.organization_id, table.agent_id] }),
    counters_check: check(
      "agent_backup_catalog_authorities_counters_check",
      sql`${table.catalog_revision} >= 0 AND ${table.restore_generation} >= 0`,
    ),
  }),
);

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

/**
 * Tiers that own a real container. Every tier except "shared" is here today,
 * but the list is an explicit allowlist rather than a "not shared" test so
 * that adding a tier is a deliberate decision at each container-scoped query
 * (heartbeat dialing, fleet liveness) instead of a silent enrollment.
 */
export const CONTAINER_BACKED_EXECUTION_TIERS = [
  "dedicated-lazy",
  "dedicated-always",
  "custom",
] as const satisfies readonly AgentExecutionTier[];
export type WarmClaimCredentialState = "pending" | "attested" | "ready" | "failed";
export type AgentActivationPurpose = "provision" | "wake" | "restore" | "fresh_boot";
export type AgentActivationPhase =
  | "container_pending"
  | "restore_pending"
  | "restart_pending"
  | "restart_attested"
  | "active"
  | "blocked";

export interface AgentActivationReceipt {
  schemaVersion: 1;
  generation: string;
  purpose: AgentActivationPurpose;
  agentId: string;
  organizationId: string;
  lifecycleRevision: string;
  backupId: string | null;
  backupHash: string | null;
  manifestHash: string | null;
  componentHashes: Record<string, string> | null;
  freshAuthorization: {
    kind: "no_backup" | "explicit_consent";
    lifecycleRevision: string;
    headBackupId: string | null;
    headBackupHash: string | null;
  } | null;
  containerId: string;
  imageDigest: string;
  receiptId: string;
  receiptHash: string;
  receiptMac: string;
  appliedAt: string;
  restored: true;
  requiresRestart: boolean;
}

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
    lifecycle_job_id: uuid("lifecycle_job_id"),
    lifecycle_execution_generation: uuid("lifecycle_execution_generation"),
    /** Durable, retry-stable generation for a quarantined container activation. */
    activation_generation: uuid("activation_generation"),
    activation_previous_generation: uuid("activation_previous_generation"),
    /**
     * Exact signed-int64 copy of `lifecycle_revision`. The source column is a
     * PostgreSQL bigint, so bigint mode avoids a lossy JavaScript number while
     * retaining direct SQL equality and the source column's int64 upper bound.
     */
    activation_lifecycle_revision: bigint("activation_lifecycle_revision", { mode: "bigint" }),
    activation_purpose: text("activation_purpose").$type<AgentActivationPurpose>(),
    activation_phase: text("activation_phase").$type<AgentActivationPhase>(),
    // Composite tenant FKs to agent_sandbox_backups(id, catalog_organization_id,
    // catalog_agent_id) live in 0237 — agentSandboxBackups is declared below, so
    // drizzle's foreignKey() cannot express them here without a TDZ cycle.
    activation_backup_id: uuid("activation_backup_id"),
    activation_backup_hash: text("activation_backup_hash"),
    activation_receipt: jsonb("activation_receipt").$type<AgentActivationReceipt>(),
    activation_receipt_hash: text("activation_receipt_hash"),
    activation_container_id: text("activation_container_id"),
    activation_node_id: text("activation_node_id"),
    activation_image_digest: text("activation_image_digest"),
    activation_token_hash: text("activation_token_hash"),
    activation_token_ciphertext: text("activation_token_ciphertext"),
    activation_boot_id: uuid("activation_boot_id"),
    activation_authority_published_at: timestamp("activation_authority_published_at", {
      withTimezone: true,
    }),
    activation_funding_revision: bigint("activation_funding_revision", { mode: "bigint" }),
    activation_dispatched_at: timestamp("activation_dispatched_at", { withTimezone: true }),
    activation_completed_at: timestamp("activation_completed_at", { withTimezone: true }),
    activation_consent_lifecycle_revision: bigint("activation_consent_lifecycle_revision", {
      mode: "bigint",
    }),
    activation_consent_head_backup_id: uuid("activation_consent_head_backup_id"),
    activation_consent_head_backup_hash: text("activation_consent_head_backup_hash"),
    deletion_attempt_id: uuid("deletion_attempt_id"),
    deletion_started_at: timestamp("deletion_started_at", { withTimezone: true }),
    /** Lifecycle state captured when a reversible deletion generation begins. */
    deletion_previous_status: text("deletion_previous_status").$type<AgentSandboxStatus>(),
    /** Billing state captured with `deletion_previous_status`; restored atomically on cancel. */
    deletion_previous_billing_status: text(
      "deletion_previous_billing_status",
    ).$type<AgentBillingStatus>(),
    /** Billing-warning receipt paired with the prior billing state. */
    deletion_previous_shutdown_warning_sent_at: timestamp(
      "deletion_previous_shutdown_warning_sent_at",
      { withTimezone: true },
    ),
    /** Scheduled billing shutdown receipt paired with the prior billing state. */
    deletion_previous_scheduled_shutdown_at: timestamp("deletion_previous_scheduled_shutdown_at", {
      withTimezone: true,
    }),
    /**
     * A typed waiver for the one supported no-snapshot case. It is scoped to
     * the deletion attempt and the observed container generation so a retry
     * can converge after teardown without treating another container's 404 as
     * authority to delete this one.
     */
    pre_delete_capture_waiver_attempt_id: uuid("pre_delete_capture_waiver_attempt_id"),
    pre_delete_capture_waiver_environment_revision: integer(
      "pre_delete_capture_waiver_environment_revision",
    ),
    pre_delete_capture_waiver_sandbox_id: text("pre_delete_capture_waiver_sandbox_id"),
    pre_delete_capture_waiver_bridge_url: text("pre_delete_capture_waiver_bridge_url"),
    /**
     * Whether THIS deletion generation still owns one counted slot in
     * `docker_nodes.allocated_count`, so the slot is released exactly once no
     * matter how many times the teardown runs.
     *
     * Remote teardown is retryable and idempotent-ish ("No such container" is a
     * success), but the local counter is not: the row keeps its node/container
     * locator until the row is deleted, so a retry after a post-stop failure
     * (credential revocation, row-delete CAS, job-status persistence) would
     * re-decrement the same slot and free a LIVE sibling's capacity —
     * `GREATEST(count - 1, 0)` hides the underflow rather than preventing it.
     *
     * `true` — this generation holds a counted slot; the release CAS may run.
     * `false` — it never held one (suspended/sleeping rows already released at
     * suspend time), or this generation already released it.
     * `null` — no deletion intent, or a pre-migration intent whose ownership was
     * never recorded; reconciliation resolves those explicitly rather than
     * guessing, because guessing either leaks capacity or double-frees it.
     *
     * "Ownership never outlives its generation" is structural, not a CHECK
     * constraint: the only writers set this together with `deletion_attempt_id`
     * in a single UPDATE, and `ADD CONSTRAINT` would full-scan `agent_sandboxes`
     * under ACCESS EXCLUSIVE — the same trade-off migration 0185 documents.
     */
    deletion_allocation_counted: boolean("deletion_allocation_counted"),
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
    /**
     * When a scheduled snapshot last ATTEMPTED to capture this agent —
     * success, failure, or capability skip. `last_backup_at` stays
     * success-only so staleness detection remains honest; this column exists
     * so the sweep can distinguish "never tried" from "tried and cannot"
     * (#15783 Phase 1).
     */
    last_backup_attempt_at: timestamp("last_backup_attempt_at", { withTimezone: true }),
    /**
     * Set when the last auto snapshot attempt was skipped because the agent
     * image does not serve `POST /api/snapshot` (the
     * SNAPSHOT_ENDPOINT_UNSUPPORTED sentinel). Cleared on any successful
     * snapshot. While set, the scheduled sweep only re-probes the row at a
     * slow cadence instead of letting it permanently occupy the capped
     * due-set window and starve backup-capable agents (#15783).
     */
    backup_unsupported_reason: text("backup_unsupported_reason"),
    /**
     * Primary-DB clock authority for the next periodic catalogue-v3 backup.
     * Null means the row is not enrolled; it never proves that a due backup
     * completed.
     */
    next_backup_at: timestamp("next_backup_at", { withTimezone: true }),
    /** Retry-stable operation id allocated before a due row leaves the DB. */
    backup_schedule_operation_id: uuid("backup_schedule_operation_id"),
    /** DB-clock backpressure that does not advance the protected-backup deadline. */
    backup_schedule_retry_at: timestamp("backup_schedule_retry_at", { withTimezone: true }),
    /** Exact bounded scheduler lease. All three members are null or present. */
    backup_schedule_claim_owner: text("backup_schedule_claim_owner"),
    backup_schedule_claim_generation: uuid("backup_schedule_claim_generation"),
    backup_schedule_claim_expires_at: timestamp("backup_schedule_claim_expires_at", {
      withTimezone: true,
    }),
    backup_schedule_attempts: integer("backup_schedule_attempts").notNull().default(0),
    backup_schedule_last_error_code: text("backup_schedule_last_error_code"),
    /** DB-clock time of the exact catalogue proof that advanced the RPO deadline. */
    backup_schedule_last_protected_at: timestamp("backup_schedule_last_protected_at", {
      withTimezone: true,
    }),
    last_heartbeat_at: timestamp("last_heartbeat_at", { withTimezone: true }),
    error_message: text("error_message"),
    error_count: integer("error_count").notNull().default(0),
    environment_vars: jsonb("environment_vars")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    /**
     * Monotonic version of the stored environment. Image swaps capture this
     * before provisioning blue and require the same value at cutover, so a
     * concurrent credential rotation or environment update cannot strand the
     * replacement container on stale credentials.
     */
    environment_revision: integer("environment_revision").notNull().default(0),
    /**
     * Database-owned generation for the complete sandbox row. A trigger
     * advances it on every update, including raw SQL writers, so lifecycle
     * operations can fence asynchronous work without timestamp precision or
     * same-millisecond ABA assumptions.
     */
    lifecycle_revision: bigint("lifecycle_revision", { mode: "number" }).notNull().default(0),
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
    last_billed_at: timestamp("last_billed_at", { withTimezone: true }).defaultNow(),
    hourly_rate: numeric("hourly_rate", { precision: 10, scale: 4 }).default("0.0100"),
    total_billed: numeric("total_billed", { precision: 18, scale: 6 })
      .default("0.000000")
      .notNull(),
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
    /**
     * Server-owned state for the pool-org to user-org inference credential
     * handoff. Null denotes a row that was never warm-claimed.
     */
    warm_claim_credential_state: text(
      "warm_claim_credential_state",
    ).$type<WarmClaimCredentialState>(),
    warm_claim_source_pool_id: uuid("warm_claim_source_pool_id"),
    warm_claim_key_fingerprint: text("warm_claim_key_fingerprint"),
    warm_claim_attested_at: timestamp("warm_claim_attested_at", { withTimezone: true }),
    warm_claim_attested_environment_revision: integer("warm_claim_attested_environment_revision"),
    warm_claim_cleanup_completed_at: timestamp("warm_claim_cleanup_completed_at", {
      withTimezone: true,
    }),
    replacement_cleanup_sandbox_id: text("replacement_cleanup_sandbox_id"),
    replacement_cleanup_node_id: text("replacement_cleanup_node_id"),
    replacement_cleanup_container_name: text("replacement_cleanup_container_name"),
    replacement_cleanup_attempt_id: uuid("replacement_cleanup_attempt_id"),
    replacement_cleanup_container_id: text("replacement_cleanup_container_id"),
    replacement_cleanup_vpn_node_id: text("replacement_cleanup_vpn_node_id"),
    replacement_cleanup_vpn_node_name: text("replacement_cleanup_vpn_node_name"),
    replacement_cleanup_preserved_vpn_node_id: text("replacement_cleanup_preserved_vpn_node_id"),
    replacement_cleanup_vpn_registration_started_at: timestamp(
      "replacement_cleanup_vpn_registration_started_at",
      { withTimezone: true },
    ),
    replacement_cleanup_allocation_counted: boolean("replacement_cleanup_allocation_counted"),
    replacement_cleanup_created_at: timestamp("replacement_cleanup_created_at", {
      withTimezone: true,
    }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    tenant_identity_unique: unique("agent_sandboxes_id_organization_unique").on(
      table.id,
      table.organization_id,
    ),
    organization_idx: index("agent_sandboxes_organization_idx").on(table.organization_id),
    user_idx: index("agent_sandboxes_user_idx").on(table.user_id),
    status_idx: index("agent_sandboxes_status_idx").on(table.status),
    character_idx: index("agent_sandboxes_character_idx").on(table.character_id),
    sandbox_id_idx: index("agent_sandboxes_sandbox_id_idx").on(table.sandbox_id),
    container_name_idx: index("agent_sandboxes_container_name_idx").on(table.container_name),
    billing_status_idx: index("agent_sandboxes_billing_status_idx").on(table.billing_status),
    deleted_at_idx: index("agent_sandboxes_deleted_at_idx").on(table.deleted_at),
    lifecycle_execution_pair_check: check(
      "agent_sandboxes_lifecycle_execution_pair_check",
      sql`(
        ${table.lifecycle_job_id} IS NULL
        AND ${table.lifecycle_execution_generation} IS NULL
      ) OR (
        ${table.lifecycle_job_id} IS NOT NULL
        AND ${table.lifecycle_execution_generation} IS NOT NULL
      )`,
    ),
    lifecycle_execution_idx: index("agent_sandboxes_lifecycle_execution_idx")
      .on(table.lifecycle_job_id, table.lifecycle_execution_generation)
      .where(sql`${table.lifecycle_execution_generation} IS NOT NULL`),
    activation_generation_idx: index("agent_sandboxes_activation_generation_idx")
      .on(table.activation_generation)
      .where(sql`${table.activation_generation} IS NOT NULL`),
    backup_schedule_due_idx: index("agent_sandboxes_backup_schedule_due_idx")
      .on(table.next_backup_at, table.backup_schedule_retry_at, table.organization_id, table.id)
      .where(sql`${table.next_backup_at} IS NOT NULL`),
    backup_schedule_claim_expiry_idx: index("agent_sandboxes_backup_schedule_claim_expiry_idx")
      .on(table.backup_schedule_claim_expires_at)
      .where(sql`${table.backup_schedule_claim_expires_at} IS NOT NULL`),
    backup_schedule_operation_idx: index("agent_sandboxes_backup_schedule_operation_idx")
      .on(table.organization_id, table.id, table.backup_schedule_operation_id)
      .where(sql`${table.backup_schedule_operation_id} IS NOT NULL`),
    backup_schedule_claim_shape_check: check(
      "agent_sandboxes_backup_schedule_claim_shape_check",
      sql`((
        ${table.backup_schedule_claim_owner} IS NULL
        AND ${table.backup_schedule_claim_generation} IS NULL
        AND ${table.backup_schedule_claim_expires_at} IS NULL
      ) OR (
        ${table.next_backup_at} IS NOT NULL
        AND ${table.backup_schedule_operation_id} IS NOT NULL
        AND ${table.backup_schedule_claim_owner} IS NOT NULL
        AND ${table.backup_schedule_claim_owner} <> ''
        AND ${table.backup_schedule_claim_generation} IS NOT NULL
        AND ${table.backup_schedule_claim_expires_at} IS NOT NULL
      )) IS TRUE`,
    ),
    backup_schedule_attempts_check: check(
      "agent_sandboxes_backup_schedule_attempts_check",
      sql`(${table.backup_schedule_attempts} >= 0
        AND (${table.backup_schedule_last_error_code} IS NULL
          OR ${table.backup_schedule_last_error_code} ~ '^[A-Z][A-Z0-9_]{0,95}$')) IS TRUE`,
    ),
    activation_state_check: check(
      "agent_sandboxes_activation_state_v2_check",
      sql`((
        num_nonnulls(${table.activation_generation}, ${table.activation_previous_generation},
          ${table.activation_lifecycle_revision}, ${table.activation_purpose},
          ${table.activation_phase}, ${table.activation_backup_id},
          ${table.activation_backup_hash}, ${table.activation_receipt},
          ${table.activation_receipt_hash}, ${table.activation_container_id},
          ${table.activation_node_id}, ${table.activation_image_digest},
          ${table.activation_token_hash}, ${table.activation_token_ciphertext},
          ${table.activation_boot_id}, ${table.activation_authority_published_at},
          ${table.activation_funding_revision}, ${table.activation_dispatched_at},
          ${table.activation_completed_at}, ${table.activation_consent_lifecycle_revision},
          ${table.activation_consent_head_backup_id},
          ${table.activation_consent_head_backup_hash}) = 0
      ) OR (
        ${table.activation_generation} IS NOT NULL
        AND ${table.activation_lifecycle_revision} >= 0
        AND (${table.activation_purpose} IN ('provision', 'wake', 'restore', 'fresh_boot')
          OR ${table.activation_purpose} IS NULL)
        AND ${table.activation_phase} IN ('container_pending', 'restore_pending',
          'restart_pending', 'restart_attested', 'active', 'blocked')
        AND (${table.activation_purpose} IS NULL OR (
          ${table.activation_token_hash} ~ '^[0-9a-f]{64}$'
          AND octet_length(${table.activation_token_ciphertext}) BETWEEN 1 AND 16384))
        AND ((${table.activation_backup_id} IS NULL AND ${table.activation_backup_hash} IS NULL)
          OR (${table.activation_backup_id} IS NOT NULL
            AND ${table.activation_backup_hash} ~ '^[0-9a-f]{64}$'))
        AND ((${table.activation_purpose} = 'restore'
            AND ${table.activation_backup_id} IS NOT NULL)
          OR (${table.activation_purpose} = 'fresh_boot'
            AND ${table.activation_backup_id} IS NULL)
          OR ${table.activation_purpose} IN ('provision', 'wake')
          OR (${table.activation_purpose} IS NULL AND ${table.activation_phase} = 'active'
            AND num_nonnulls(${table.activation_previous_generation},
              ${table.activation_backup_id}, ${table.activation_backup_hash},
              ${table.activation_token_hash}, ${table.activation_token_ciphertext},
              ${table.activation_funding_revision},
              ${table.activation_consent_lifecycle_revision},
              ${table.activation_consent_head_backup_id},
              ${table.activation_consent_head_backup_hash}) = 0))
        AND ((${table.activation_consent_head_backup_id} IS NULL
            AND ${table.activation_consent_head_backup_hash} IS NULL)
          OR (${table.activation_consent_head_backup_id} IS NOT NULL
            AND ${table.activation_consent_head_backup_hash} ~ '^[0-9a-f]{64}$'))
        AND (${table.activation_consent_lifecycle_revision} IS NULL
          OR ${table.activation_consent_lifecycle_revision} >= 0)
        AND (${table.activation_purpose} IS NULL OR ${table.activation_purpose} <> 'fresh_boot'
          OR ${table.activation_consent_lifecycle_revision} IS NOT NULL)
        AND ((${table.activation_purpose} IS NULL AND ${table.activation_receipt} IS NULL
            AND ${table.activation_receipt_hash} ~ '^[0-9a-f]{64}$')
          OR (${table.activation_receipt} IS NULL AND ${table.activation_receipt_hash} IS NULL)
          OR (${table.activation_receipt} IS NOT NULL
            AND ${table.activation_receipt_hash} ~ '^[0-9a-f]{64}$'))
        AND (${table.activation_phase} NOT IN ('restart_pending', 'restart_attested', 'active')
          OR ${table.activation_receipt} IS NOT NULL OR ${table.activation_purpose} IS NULL)
        AND (${table.activation_phase} NOT IN
          ('restore_pending', 'restart_pending', 'restart_attested', 'active')
          OR (${table.activation_container_id} ~ '^[0-9a-f]{64}$'
            AND ${table.activation_image_digest} ~ '^sha256:[0-9a-f]{64}$'))
        AND (${table.activation_phase} NOT IN ('restart_attested', 'active')
          OR ${table.activation_boot_id} IS NOT NULL)
        AND (${table.activation_phase} <> 'active' OR ((
          ${table.activation_funding_revision} >= 0
          OR (${table.activation_purpose} IS NULL
            AND ${table.activation_funding_revision} IS NULL))
          AND ${table.activation_lifecycle_revision} = ${table.lifecycle_revision}
          AND ${table.activation_node_id} IS NOT NULL
          AND btrim(${table.activation_node_id}) <> ''
          AND ${table.activation_node_id} = ${table.node_id}
          AND ${table.activation_image_digest} = ${table.image_digest}
          AND ${table.sandbox_id} IS NOT NULL
          AND ${table.activation_container_id} <> ${table.sandbox_id}
          AND ${table.activation_authority_published_at} IS NOT NULL
          AND ${table.activation_dispatched_at} IS NOT NULL
          AND ${table.activation_completed_at} IS NOT NULL
          AND ${table.activation_authority_published_at} <= ${table.activation_dispatched_at}
          AND ${table.activation_dispatched_at} <= ${table.activation_completed_at}
        ))
        AND (${table.activation_phase} = 'active' OR (
          ${table.activation_authority_published_at} IS NULL
          AND ${table.activation_dispatched_at} IS NULL
          AND ${table.activation_completed_at} IS NULL
        ))
      )) IS TRUE`,
    ),
    deletion_intent_pair_check: check(
      "agent_sandboxes_deletion_intent_pair_check",
      sql`(
        ${table.deletion_attempt_id} IS NULL
        AND ${table.deletion_started_at} IS NULL
      ) OR (
        ${table.deletion_attempt_id} IS NOT NULL
        AND ${table.deletion_started_at} IS NOT NULL
      )`,
    ),
    pre_delete_capture_waiver_shape_check: check(
      "agent_sandboxes_pre_delete_capture_waiver_shape_check",
      sql`(
        ${table.pre_delete_capture_waiver_attempt_id} IS NULL
        AND ${table.pre_delete_capture_waiver_environment_revision} IS NULL
        AND ${table.pre_delete_capture_waiver_sandbox_id} IS NULL
        AND ${table.pre_delete_capture_waiver_bridge_url} IS NULL
      ) OR (
        ${table.pre_delete_capture_waiver_attempt_id} IS NOT NULL
        AND ${table.pre_delete_capture_waiver_attempt_id} = ${table.deletion_attempt_id}
        AND ${table.pre_delete_capture_waiver_environment_revision} = ${table.environment_revision}
        AND ${table.pre_delete_capture_waiver_sandbox_id} IS NOT DISTINCT FROM ${table.sandbox_id}
        AND ${table.pre_delete_capture_waiver_bridge_url} IS NOT NULL
      )`,
    ),
    warm_claim_credential_state_check: check(
      "agent_sandboxes_warm_claim_credential_state_check",
      sql`${table.warm_claim_credential_state} IS NULL OR ${table.warm_claim_credential_state} IN ('pending', 'attested', 'ready', 'failed')`,
    ),
    warm_claim_pending_idx: index("agent_sandboxes_warm_claim_pending_idx")
      .on(table.updated_at)
      .where(
        sql`${table.claimed_at} IS NOT NULL AND ${table.warm_claim_credential_state} IS DISTINCT FROM 'ready'`,
      ),
    warm_claim_cleanup_idx: index("agent_sandboxes_warm_claim_cleanup_idx")
      .on(table.updated_at)
      .where(
        sql`${table.warm_claim_credential_state} = 'failed' AND ${table.warm_claim_cleanup_completed_at} IS NULL`,
      ),
    replacement_cleanup_locator_check: check(
      "agent_sandboxes_replacement_cleanup_locator_check",
      sql`(
        ${table.replacement_cleanup_sandbox_id} IS NULL
        AND ${table.replacement_cleanup_node_id} IS NULL
        AND ${table.replacement_cleanup_container_name} IS NULL
        AND ${table.replacement_cleanup_attempt_id} IS NULL
        AND ${table.replacement_cleanup_container_id} IS NULL
        AND ${table.replacement_cleanup_vpn_node_id} IS NULL
        AND ${table.replacement_cleanup_vpn_node_name} IS NULL
        AND ${table.replacement_cleanup_preserved_vpn_node_id} IS NULL
        AND ${table.replacement_cleanup_vpn_registration_started_at} IS NULL
        AND ${table.replacement_cleanup_allocation_counted} IS NULL
        AND ${table.replacement_cleanup_created_at} IS NULL
      ) OR (
        ${table.replacement_cleanup_sandbox_id} IS NOT NULL
        AND ${table.replacement_cleanup_node_id} IS NOT NULL
        AND ${table.replacement_cleanup_container_name} IS NOT NULL
        AND ${table.replacement_cleanup_allocation_counted} IS NOT NULL
        AND ${table.replacement_cleanup_created_at} IS NOT NULL
        AND (
          (
            ${table.replacement_cleanup_attempt_id} IS NOT NULL
            AND (
              (
                ${table.replacement_cleanup_vpn_node_id} IS NULL
                AND
                ${table.replacement_cleanup_vpn_node_name} IS NULL
                AND ${table.replacement_cleanup_vpn_registration_started_at} IS NULL
                AND ${table.replacement_cleanup_preserved_vpn_node_id} IS NULL
              )
              OR (
                ${table.replacement_cleanup_vpn_node_name} IS NOT NULL
                AND ${table.replacement_cleanup_vpn_registration_started_at} IS NOT NULL
              )
            )
          )
          OR (
            ${table.replacement_cleanup_attempt_id} IS NULL
            AND ${table.replacement_cleanup_container_id} IS NULL
            AND ${table.replacement_cleanup_vpn_node_name} IS NULL
            AND ${table.replacement_cleanup_preserved_vpn_node_id} IS NULL
            AND ${table.replacement_cleanup_vpn_registration_started_at} IS NULL
            AND ${table.replacement_cleanup_allocation_counted} = TRUE
          )
        )
      )`,
    ),
    replacement_cleanup_pending_idx: index("agent_sandboxes_replacement_cleanup_pending_idx")
      .on(table.replacement_cleanup_created_at)
      .where(sql`${table.replacement_cleanup_sandbox_id} IS NOT NULL`),
    replacement_cleanup_container_name_idx: index(
      "agent_sandboxes_replacement_cleanup_container_name_idx",
    )
      .on(table.replacement_cleanup_container_name)
      .where(sql`${table.replacement_cleanup_container_name} IS NOT NULL`),
  }),
);

/** Sentinel UUIDs that own warm pool rows. Mirrors migration 0107. */
export const WARM_POOL_ORG_ID = "00000000-0000-4000-8000-000000077001";
export const WARM_POOL_USER_ID = "00000000-0000-4000-8000-000000077002";

export type AgentSandboxPoolStatus = "unclaimed";

/**
 * `pre-move` is deliberately distinct from `pre-upgrade`: a rollback restores
 * the latest `pre-upgrade` point, so a relocation writing under that label
 * would silently become the state a later rollback replays.
 */
export type AgentBackupSnapshotType =
  | "auto"
  | "manual"
  | "pre-shutdown"
  | "pre-delete"
  | "pre-upgrade"
  | "pre-move";

/**
 * Outcome of the last restorability verification pass over a backup row
 * (`agent-backup-verifier.ts`). `null`/unset means the row has never been
 * sampled. Verification decrypts the stored payload with the CURRENT KMS keys
 * and checks content/manifest hashes — it exists because staging silently ran
 * an ephemeral KMS for weeks and every backup was undecryptable (#15310).
 * `errored` means the verifier itself hit infrastructure breakage (object
 * storage / KMS transport / oversize payload) and could not judge the backup;
 * the row is re-attempted on the normal re-verify cadence (#15626).
 */
export type AgentBackupVerificationStatus = "verified" | "failed" | "errored";

/**
 * Whether a backup row stores the agent's complete state (`full`) or only the
 * delta against `parent_backup_id` (`incremental`). Restoring an incremental
 * backup replays its parent chain back to the nearest `full` backup. See
 * `agent-backup-diff.ts` for the delta format and reconstruction.
 */
export type AgentBackupKind = "full" | "incremental";

export const AGENT_BACKUP_SOURCE_PROVIDERS = ["operator-onboarded", "hetzner-cloud"] as const;

export type AgentBackupSourceProvider = (typeof AGENT_BACKUP_SOURCE_PROVIDERS)[number];

/**
 * Durable lifecycle of a logical backup operation. `legacy_unmigrated` is a
 * rollout-only state for rows created before the v2 catalogue existed; new
 * writers must always reserve an operation in `scheduled` before touching
 * object storage.
 */
export type AgentBackupCatalogState =
  | "legacy_unmigrated"
  | "scheduled"
  | "capturing"
  | "captured"
  | "uploading"
  | "primary_uploaded"
  | "primary_verified"
  | "secondary_pending"
  | "protected"
  | "retained"
  | "expiration_pending"
  | "deleting"
  | "deleted"
  | "failed_retryable"
  | "failed_terminal"
  | "restore_verified";

export const AGENT_BACKUP_RETENTION_REASONS = [
  "schedule",
  "manual",
  "pre-shutdown",
  "pre-delete",
  "pre-upgrade",
  "pre-move",
  "billing-freeze",
  "legal-hold",
  "user-erasure",
] as const;

export type AgentBackupRetentionReason = (typeof AGENT_BACKUP_RETENTION_REASONS)[number];

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
    sandbox_record_id: uuid("sandbox_record_id").references(() => agentSandboxes.id, {
      // A DB trigger blocks deletion while v2 rows remain. This cascade only
      // removes legacy payloads that have no exact-object GC authority.
      onDelete: "cascade",
    }),
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
    /** Oldest full checkpoint anchoring a v2 incremental chain. */
    base_backup_id: uuid("base_backup_id"),
    /** sha256 of the reconstructed full state, for integrity verification. */
    content_hash: text("content_hash"),
    /**
     * Restorability-verification stamp (see `AgentBackupVerificationStatus`).
     * `verified_at` records the last verification ATTEMPT (success, failure,
     * or verifier infra error) and drives the re-verify sampling interval;
     * `verification_error` carries the classified failure
     * (`key-unavailable: …`, `decrypt-failed: …`) so an operator can tell a
     * KMS misconfig from bit-rot without re-running it. For `errored` rows it
     * is `infra-error[N]: …`, where N is the row's consecutive-attempt error
     * streak (persisted here so it survives daemon restarts).
     */
    verification_status: text("verification_status").$type<AgentBackupVerificationStatus>(),
    verified_at: timestamp("verified_at", { withTimezone: true }),
    verification_error: text("verification_error"),
    /**
     * V2 catalogue identity. These columns deliberately live on the existing
     * `agent_sandbox_backups` authority instead of introducing a second,
     * weaker logical-backup table. They are nullable only for rollout of
     * pre-catalogue rows.
     */
    backup_operation_id: uuid("backup_operation_id"),
    catalog_version: integer("catalog_version"),
    catalog_state: text("catalog_state").$type<AgentBackupCatalogState>(),
    catalog_resume_state: text("catalog_resume_state").$type<AgentBackupCatalogState>(),
    catalog_payload_digest: text("catalog_payload_digest"),
    /** Snapshot of the durable per-agent catalogue authority after this mutation. */
    catalog_revision: bigint("catalog_revision", { mode: "bigint" }).notNull().default(sql`0`),
    catalog_organization_id: uuid("catalog_organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    catalog_agent_id: uuid("catalog_agent_id"),
    lifecycle_generation: uuid("lifecycle_generation"),
    lifecycle_revision: numeric("lifecycle_revision", {
      precision: 20,
      scale: 0,
      mode: "bigint",
    }),
    source_provider: text("source_provider").$type<AgentBackupSourceProvider>(),
    source_node_record_id: uuid("source_node_record_id"),
    source_node_id: text("source_node_id"),
    /** Immutable Linux boot UUID resolved from typed node authority at reservation. */
    source_node_incarnation: uuid("source_node_incarnation"),
    /** Exact Hetzner Cloud server id; null for operator-onboarded Robot nodes. */
    source_provider_server_id: text("source_provider_server_id"),
    /** Provider/container-name handle used only to locate the running sandbox. */
    source_provider_handle: text("source_provider_handle"),
    /** Immutable Docker ID from activation create/inspect. */
    source_container_id: text("source_container_id"),
    manifest_format: text("manifest_format"),
    manifest_version: integer("manifest_version"),
    manifest_digest: text("manifest_digest"),
    /** Exact canonical v2 draft bytes whose SHA-256 is `manifest_digest`. */
    manifest_canonical_draft: text("manifest_canonical_draft"),
    manifest_object_count: integer("manifest_object_count"),
    object_inventory_digest: text("object_inventory_digest"),
    image_digest: text("backup_image_digest"),
    database_schema_version: text("database_schema_version"),
    plugin_set_digest: text("plugin_set_digest"),
    watermark_digest: text("watermark_digest"),
    raw_size_bytes: bigint("raw_size_bytes", { mode: "number" }),
    compressed_size_bytes: bigint("compressed_size_bytes", { mode: "number" }),
    encrypted_size_bytes: bigint("encrypted_size_bytes", { mode: "number" }),
    kms_key_id: text("backup_kms_key_id"),
    kms_key_version: bigint("backup_kms_key_version", { mode: "number" }),
    /** Exact wrapped-DEK envelope persisted independently of chunk objects. */
    wrapped_dek_ref: text("wrapped_dek_ref"),
    wrapped_dek_ciphertext_base64: text("wrapped_dek_ciphertext_base64"),
    wrapped_dek_sha256: text("wrapped_dek_sha256"),
    wrapped_dek_size_bytes: integer("wrapped_dek_size_bytes"),
    wrapped_dek_receipt_digest: text("wrapped_dek_receipt_digest"),
    /** Manifest-v3's one-operation DEK + content-HMAC envelope. Never populated for v2. */
    operation_key_bundle_generation_id: uuid("operation_key_bundle_generation_id"),
    operation_key_bundle_format: text("operation_key_bundle_format"),
    operation_key_bundle_ref: text("operation_key_bundle_ref"),
    operation_key_bundle_ciphertext_base64: text("operation_key_bundle_ciphertext_base64"),
    operation_key_bundle_sha256: text("operation_key_bundle_sha256"),
    operation_key_bundle_size_bytes: integer("operation_key_bundle_size_bytes"),
    /** Exact canonical KMS AAD required to unwrap the v3 bundle after restore. */
    operation_key_bundle_context: text("operation_key_bundle_context"),
    operation_key_bundle_context_derivation: text("operation_key_bundle_context_derivation"),
    operation_key_bundle_local_receipt_derivation: text(
      "operation_key_bundle_local_receipt_derivation",
    ),
    operation_key_bundle_local_receipt_digest: text("operation_key_bundle_local_receipt_digest"),
    /** Authenticated scalar pointer to a vault authority introduced in the restore slice. */
    vault_key_generation_id: uuid("vault_key_generation_id"),
    vault_key_authority_receipt_digest: text("vault_key_authority_receipt_digest"),
    catalog_attempts: integer("catalog_attempts").notNull().default(0),
    catalog_lease_owner: text("catalog_lease_owner"),
    catalog_lease_generation: uuid("catalog_lease_generation"),
    catalog_lease_expires_at: timestamp("catalog_lease_expires_at", { withTimezone: true }),
    catalog_next_attempt_at: timestamp("catalog_next_attempt_at", { withTimezone: true }),
    catalog_last_error_code: text("catalog_last_error_code"),
    catalog_last_error: text("catalog_last_error"),
    retention_reason: text("retention_reason").$type<AgentBackupRetentionReason>(),
    retention_until: timestamp("retention_until", { withTimezone: true }),
    primary_verified_at: timestamp("primary_verified_at", { withTimezone: true }),
    secondary_verified_at: timestamp("secondary_verified_at", { withTimezone: true }),
    restore_verified_at: timestamp("restore_verified_at", { withTimezone: true }),
    restore_receipt_digest: text("restore_receipt_digest"),
    restore_generation: bigint("restore_generation", { mode: "bigint" }),
    catalog_delete_receipt_digest: text("catalog_delete_receipt_digest"),
    catalog_deleted_at: timestamp("catalog_deleted_at", { withTimezone: true }),
    catalog_updated_at: timestamp("catalog_updated_at", { withTimezone: true }),
    /**
     * Recovery metadata identifies the one user-visible legacy pre-delete
     * recovery point. V2 rows must reach exact-object GC before compute can
     * be deleted and therefore never rely on this detached-row authority.
     */
    recovery_organization_id: uuid("recovery_organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    recovery_agent_id: uuid("recovery_agent_id"),
    recovery_deletion_attempt_id: uuid("recovery_deletion_attempt_id"),
    recovery_expires_at: timestamp("recovery_expires_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sandbox_record_idx: index("agent_sandbox_backups_sandbox_idx").on(table.sandbox_record_id),
    created_at_idx: index("agent_sandbox_backups_created_at_idx").on(table.created_at),
    // Serves the newest-backup-per-sandbox access pattern: the verifier's
    // `DISTINCT ON (sandbox_record_id) … ORDER BY sandbox_record_id,
    // created_at DESC` sampler plus listBackups/getLatestBackup (#15626,
    // migration 0174).
    sandbox_latest_idx: index("agent_sandbox_backups_sandbox_latest_idx").on(
      table.sandbox_record_id,
      table.created_at.desc(),
    ),
    parent_backup_idx: index("agent_sandbox_backups_parent_idx").on(table.parent_backup_id),
    base_backup_idx: index("agent_sandbox_backups_base_idx").on(table.base_backup_id),
    recovery_shape_check: check(
      "agent_sandbox_backups_recovery_shape_check",
      sql`((
        ${table.sandbox_record_id} IS NOT NULL
        AND ${table.recovery_organization_id} IS NULL
        AND ${table.recovery_agent_id} IS NULL
        AND ${table.recovery_deletion_attempt_id} IS NULL
        AND ${table.recovery_expires_at} IS NULL
      ) OR (
        ${table.sandbox_record_id} IS NULL AND (
          (
            ${table.catalog_version} IS NULL
            AND ${table.snapshot_type} = 'pre-delete'
            AND ${table.backup_kind} = 'full'
            AND ${table.parent_backup_id} IS NULL
            AND ${table.verification_status} = 'verified'
            AND ${table.verified_at} IS NOT NULL
            AND ${table.recovery_organization_id} IS NOT NULL
            AND ${table.recovery_agent_id} IS NOT NULL
            AND ${table.recovery_deletion_attempt_id} IS NOT NULL
            AND ${table.recovery_expires_at} IS NOT NULL
          ) OR (
            ${table.catalog_version} IN (1, 2)
            AND ${table.catalog_organization_id} IS NOT NULL
            AND ${table.catalog_agent_id} IS NOT NULL
            AND (
              (${table.recovery_organization_id} IS NULL
                AND ${table.recovery_agent_id} IS NULL
                AND ${table.recovery_deletion_attempt_id} IS NULL
                AND ${table.recovery_expires_at} IS NULL)
              OR (${table.recovery_organization_id} = ${table.catalog_organization_id}
                AND ${table.recovery_agent_id} = ${table.catalog_agent_id}
                AND ${table.recovery_deletion_attempt_id} IS NOT NULL
                AND ${table.recovery_expires_at} IS NOT NULL)
            )
          )
        )
      )) IS TRUE`,
    ),
    recovery_lookup_idx: index("agent_sandbox_backups_recovery_lookup_idx")
      .on(table.recovery_organization_id, table.recovery_agent_id, table.created_at.desc())
      .where(sql`${table.sandbox_record_id} IS NULL`),
    recovery_expires_idx: index("agent_sandbox_backups_recovery_expires_idx")
      .on(table.recovery_expires_at)
      .where(sql`${table.sandbox_record_id} IS NULL`),
    recovery_attempt_uidx: uniqueIndex("agent_sandbox_backups_recovery_attempt_uidx")
      .on(
        table.recovery_organization_id,
        table.recovery_agent_id,
        table.recovery_deletion_attempt_id,
      )
      .where(sql`${table.sandbox_record_id} IS NULL`),
    catalog_operation_uidx: uniqueIndex("agent_sandbox_backups_catalog_operation_uidx")
      .on(table.catalog_organization_id, table.catalog_agent_id, table.backup_operation_id)
      .where(sql`${table.backup_operation_id} IS NOT NULL`),
    // Unconditional because PostgreSQL cannot target a partial unique index
    // from the composite tenant foreign key on exact-object authority rows.
    catalog_identity_unique: unique("agent_sandbox_backups_catalog_identity_unique").on(
      table.id,
      table.catalog_organization_id,
    ),
    catalog_chain_identity_unique: unique("agent_sandbox_backups_catalog_chain_identity_unique").on(
      table.id,
      table.catalog_organization_id,
      table.catalog_agent_id,
    ),
    restore_authority_unique: unique("agent_sandbox_backups_restore_authority_unique").on(
      table.id,
      table.catalog_organization_id,
      table.catalog_agent_id,
      table.backup_operation_id,
      table.lifecycle_generation,
      table.lifecycle_revision,
      table.manifest_digest,
    ),
    publication_backup_authority_unique: unique(
      "agent_sandbox_backups_publication_backup_authority_unique",
    ).on(table.id, table.catalog_organization_id, table.catalog_agent_id, table.manifest_digest),
    final_restore_authority_unique: unique(
      "agent_sandbox_backups_final_restore_authority_unique",
    ).on(
      table.id,
      table.catalog_organization_id,
      table.catalog_agent_id,
      table.backup_operation_id,
      table.lifecycle_generation,
      table.lifecycle_revision,
      table.manifest_digest,
    ),
    vault_restore_authority_unique: unique(
      "agent_sandbox_backups_vault_restore_authority_unique",
    ).on(
      table.id,
      table.catalog_organization_id,
      table.catalog_agent_id,
      table.backup_operation_id,
      table.lifecycle_generation,
      table.lifecycle_revision,
      table.manifest_digest,
      table.vault_key_generation_id,
      table.vault_key_authority_receipt_digest,
    ),
    catalog_authority_fk: foreignKey({
      name: "agent_sandbox_backups_catalog_authority_fkey",
      columns: [table.catalog_organization_id, table.catalog_agent_id],
      foreignColumns: [
        agentBackupCatalogAuthorities.organization_id,
        agentBackupCatalogAuthorities.agent_id,
      ],
    }).onDelete("restrict"),
    attached_catalog_tenant_fk: foreignKey({
      name: "agent_sandbox_backups_attached_catalog_tenant_fkey",
      columns: [table.sandbox_record_id, table.catalog_organization_id],
      foreignColumns: [agentSandboxes.id, agentSandboxes.organization_id],
    }).onDelete("cascade"),
    parent_catalog_authority_fk: foreignKey({
      name: "agent_sandbox_backups_parent_catalog_authority_fkey",
      columns: [table.parent_backup_id, table.catalog_organization_id, table.catalog_agent_id],
      foreignColumns: [table.id, table.catalog_organization_id, table.catalog_agent_id],
    }).onDelete("restrict"),
    base_catalog_authority_fk: foreignKey({
      name: "agent_sandbox_backups_base_catalog_authority_fkey",
      columns: [table.base_backup_id, table.catalog_organization_id, table.catalog_agent_id],
      foreignColumns: [table.id, table.catalog_organization_id, table.catalog_agent_id],
    }).onDelete("restrict"),
    catalog_due_idx: index("agent_sandbox_backups_catalog_due_idx")
      .on(table.catalog_next_attempt_at, table.created_at)
      .where(
        sql`${table.catalog_state} IN (
          'scheduled', 'capturing', 'captured', 'uploading',
          'primary_uploaded', 'primary_verified', 'secondary_pending',
          'failed_retryable'
        )`,
      ),
    catalog_shape_check: check(
      "agent_sandbox_backups_catalog_shape_check",
      sql`((
        ${table.backup_operation_id} IS NULL
        AND ${table.catalog_version} IS NULL
        AND ${table.catalog_state} IS NULL
        AND ${table.catalog_resume_state} IS NULL
        AND ${table.catalog_payload_digest} IS NULL
        AND ${table.catalog_organization_id} IS NULL
        AND ${table.catalog_agent_id} IS NULL
        AND ${table.lifecycle_generation} IS NULL
        AND ${table.lifecycle_revision} IS NULL
      ) OR (
        ${table.backup_operation_id} IS NOT NULL
        AND ${table.catalog_version} IN (1, 2)
        AND ${table.catalog_state} IS NOT NULL
        AND ${table.catalog_payload_digest} ~ '^[0-9a-f]{64}$'
        AND ${table.catalog_organization_id} IS NOT NULL
        AND ${table.catalog_agent_id} IS NOT NULL
        AND ${table.lifecycle_generation} IS NOT NULL
        AND ${table.lifecycle_revision} IS NOT NULL
        AND ${table.lifecycle_revision} BETWEEN 0 AND 18446744073709551615
        AND (
          (${table.catalog_version} = 1
            AND ${table.catalog_state} = 'legacy_unmigrated')
          OR (${table.catalog_version} = 2 AND (
            (${table.backup_kind} = 'full'
              AND ${table.parent_backup_id} IS NULL
              AND ${table.base_backup_id} IS NULL)
            OR (${table.backup_kind} = 'incremental'
              AND ${table.parent_backup_id} IS NOT NULL
              AND ${table.base_backup_id} IS NOT NULL)
          ))
        )
        AND (
          (${table.catalog_state} IN ('failed_retryable', 'failed_terminal')
            AND ${table.catalog_resume_state} IS NOT NULL
            AND ${table.catalog_resume_state} NOT IN (
              'legacy_unmigrated', 'failed_retryable', 'failed_terminal', 'deleted'
            ))
          OR (${table.catalog_state} NOT IN ('failed_retryable', 'failed_terminal')
            AND ${table.catalog_resume_state} IS NULL)
        )
      )) IS TRUE`,
    ),
    attached_catalog_identity_check: check(
      "agent_sandbox_backups_attached_catalog_identity_check",
      sql`(${table.sandbox_record_id} IS NULL OR ${table.catalog_version} IS NULL OR (
        ${table.catalog_organization_id} IS NOT NULL
        AND ${table.catalog_agent_id} = ${table.sandbox_record_id}
      )) IS TRUE`,
    ),
    catalog_state_check: check(
      "agent_sandbox_backups_catalog_state_check",
      sql`${table.catalog_state} IS NULL OR ${table.catalog_state} IN (
        'legacy_unmigrated', 'scheduled', 'capturing', 'captured', 'uploading',
        'primary_uploaded', 'primary_verified', 'secondary_pending', 'protected',
        'retained', 'expiration_pending', 'deleting', 'deleted',
        'failed_retryable', 'failed_terminal', 'restore_verified'
      )`,
    ),
    catalog_retention_reason_check: check(
      "agent_sandbox_backups_catalog_retention_reason_check",
      sql`(${table.catalog_version} IS DISTINCT FROM 2 OR (
        ${table.retention_reason} IS NOT NULL AND ${table.retention_reason} IN (
        'schedule', 'manual', 'pre-shutdown', 'pre-delete', 'pre-upgrade',
        'pre-move', 'billing-freeze', 'legal-hold', 'user-erasure'
      ))) IS TRUE`,
    ),
    catalog_v2_source_check: check(
      "agent_sandbox_backups_catalog_v2_source_check",
      sql`(${table.catalog_version} IS DISTINCT FROM 2 OR (
        ${table.source_provider} IN ('operator-onboarded', 'hetzner-cloud')
        AND ${table.source_node_record_id} IS NOT NULL
        AND ${table.source_node_id} IS NOT NULL AND btrim(${table.source_node_id}) <> ''
        AND ${table.source_provider_handle} IS NOT NULL
        AND btrim(${table.source_provider_handle}) <> ''
        AND ${table.source_container_id} ~ '^[0-9a-f]{64}$'
        AND ${table.source_provider_handle} <> ${table.source_container_id}
        AND ${table.retention_reason} IS NOT NULL
        AND ${table.retention_until} IS NOT NULL
      )) IS TRUE`,
    ),
    catalog_v2_source_authority_check: check(
      "agent_sandbox_backups_catalog_v2_source_authority_check",
      sql`(${table.catalog_version} IS DISTINCT FROM 2 OR (
        ${table.source_node_incarnation} IS NOT NULL
        AND (
          (${table.source_provider} = 'operator-onboarded'
            AND ${table.source_provider_server_id} IS NULL)
          OR (${table.source_provider} = 'hetzner-cloud'
            AND ${table.source_provider_server_id} IS NOT NULL
            AND CASE
              WHEN ${table.source_provider_server_id} ~ '^[1-9][0-9]{0,19}$'
                THEN ${table.source_provider_server_id}::numeric <= 18446744073709551615
              ELSE false
            END)
        )
      )) IS TRUE`,
    ),
    catalog_manifest_shape_check: check(
      "agent_sandbox_backups_catalog_manifest_shape_check",
      sql`(${table.catalog_version} IS DISTINCT FROM 2 OR (
        ((${table.catalog_state} IN ('scheduled', 'capturing')
            OR (${table.catalog_state} IN ('failed_retryable', 'failed_terminal')
              AND ${table.catalog_resume_state} IN ('scheduled', 'capturing')))
          AND num_nonnulls(
            ${table.manifest_format}, ${table.manifest_version}, ${table.manifest_digest},
            ${table.manifest_canonical_draft}, ${table.manifest_object_count},
            ${table.object_inventory_digest}, ${table.image_digest},
            ${table.database_schema_version}, ${table.plugin_set_digest},
            ${table.watermark_digest}, ${table.raw_size_bytes},
            ${table.compressed_size_bytes}, ${table.encrypted_size_bytes},
            ${table.kms_key_id}, ${table.kms_key_version}, ${table.wrapped_dek_ref},
            ${table.wrapped_dek_ciphertext_base64}, ${table.wrapped_dek_sha256},
            ${table.wrapped_dek_size_bytes}, ${table.wrapped_dek_receipt_digest},
            ${table.operation_key_bundle_generation_id}, ${table.operation_key_bundle_format},
            ${table.operation_key_bundle_ref}, ${table.operation_key_bundle_ciphertext_base64},
            ${table.operation_key_bundle_sha256}, ${table.operation_key_bundle_size_bytes},
            ${table.operation_key_bundle_context}, ${table.operation_key_bundle_context_derivation},
            ${table.operation_key_bundle_local_receipt_derivation},
            ${table.operation_key_bundle_local_receipt_digest}, ${table.vault_key_generation_id},
            ${table.vault_key_authority_receipt_digest}
          ) = 0)
      ) OR (
        (${table.catalog_state} IN (
            'captured', 'uploading', 'primary_uploaded', 'primary_verified',
            'secondary_pending', 'protected', 'retained', 'expiration_pending',
            'deleting', 'deleted', 'restore_verified'
          )
          OR (${table.catalog_state} IN ('failed_retryable', 'failed_terminal')
            AND ${table.catalog_resume_state} IN (
              'captured', 'uploading', 'primary_uploaded', 'primary_verified',
              'secondary_pending', 'protected', 'retained', 'expiration_pending',
              'deleting', 'restore_verified'
            )))
        AND ${table.manifest_format} = 'elizaos.agent-backup'
        AND ${table.manifest_version} IN (2, 3)
        AND ${table.manifest_digest} ~ '^[0-9a-f]{64}$'
        AND ${table.manifest_canonical_draft} IS NOT NULL
        AND octet_length(${table.manifest_canonical_draft}) BETWEEN 1 AND 4194304
        AND ${table.manifest_object_count} BETWEEN 1 AND 8192
        AND ${table.object_inventory_digest} ~ '^[0-9a-f]{64}$'
        AND ${table.image_digest} IS NOT NULL AND ${table.image_digest} <> ''
        AND ${table.database_schema_version} IS NOT NULL
        AND ${table.plugin_set_digest} ~ '^[0-9a-f]{64}$'
        AND ${table.watermark_digest} ~ '^[0-9a-f]{64}$'
        AND ${table.raw_size_bytes} IS NOT NULL
        AND ${table.compressed_size_bytes} IS NOT NULL
        AND ${table.encrypted_size_bytes} IS NOT NULL
        AND ${table.kms_key_id} IS NOT NULL AND ${table.kms_key_id} <> ''
        AND ${table.kms_key_version} BETWEEN 1 AND 9007199254740991
        AND ((${table.manifest_version} = 2
          AND num_nulls(${table.wrapped_dek_ref}, ${table.wrapped_dek_ciphertext_base64},
            ${table.wrapped_dek_sha256}, ${table.wrapped_dek_size_bytes},
            ${table.wrapped_dek_receipt_digest}) = 0
          AND ${table.wrapped_dek_ref} <> ''
          AND octet_length(${table.wrapped_dek_ciphertext_base64}) BETWEEN 4 AND 21848
          AND ${table.wrapped_dek_sha256} ~ '^[0-9a-f]{64}$'
          AND ${table.wrapped_dek_size_bytes} BETWEEN 1 AND 16384
          AND ${table.wrapped_dek_receipt_digest} ~ '^[0-9a-f]{64}$'
          AND num_nonnulls(${table.operation_key_bundle_generation_id},
            ${table.operation_key_bundle_format}, ${table.operation_key_bundle_ref},
            ${table.operation_key_bundle_ciphertext_base64},
            ${table.operation_key_bundle_sha256}, ${table.operation_key_bundle_size_bytes},
            ${table.operation_key_bundle_context}, ${table.operation_key_bundle_context_derivation},
            ${table.operation_key_bundle_local_receipt_derivation},
            ${table.operation_key_bundle_local_receipt_digest}, ${table.vault_key_generation_id},
            ${table.vault_key_authority_receipt_digest}) = 0)
        OR (${table.manifest_version} = 3
          AND num_nonnulls(${table.wrapped_dek_ref}, ${table.wrapped_dek_ciphertext_base64},
            ${table.wrapped_dek_sha256}, ${table.wrapped_dek_size_bytes},
            ${table.wrapped_dek_receipt_digest}) = 0
          AND num_nulls(${table.operation_key_bundle_generation_id},
            ${table.operation_key_bundle_format}, ${table.operation_key_bundle_ref},
            ${table.operation_key_bundle_ciphertext_base64},
            ${table.operation_key_bundle_sha256}, ${table.operation_key_bundle_size_bytes},
            ${table.operation_key_bundle_context}, ${table.operation_key_bundle_context_derivation},
            ${table.operation_key_bundle_local_receipt_derivation},
            ${table.operation_key_bundle_local_receipt_digest}, ${table.vault_key_generation_id},
            ${table.vault_key_authority_receipt_digest}) = 0
          AND ${table.operation_key_bundle_format} = 'kms-aead-operation-key-bundle-v1'
          AND ${table.operation_key_bundle_ref} =
            'backup-key-bundle:' || ${table.backup_operation_id}::text
          AND ${table.operation_key_bundle_ciphertext_base64} ~ '^[A-Za-z0-9+/]{123}=$'
          AND ${table.operation_key_bundle_sha256} ~ '^[0-9a-f]{64}$'
          AND ${table.operation_key_bundle_size_bytes} = 92
          AND octet_length(${table.operation_key_bundle_context}) BETWEEN 1 AND 65536
          AND ${table.operation_key_bundle_context_derivation} =
            'elizaos.agent-backup.operation-key-bundle-context.v1'
          AND ${table.operation_key_bundle_local_receipt_derivation} =
            'elizaos.kms-aead-operation-key-bundle.local-receipt.v1'
          AND ${table.operation_key_bundle_local_receipt_digest} ~ '^[0-9a-f]{64}$'
          AND ${table.vault_key_authority_receipt_digest} ~ '^[0-9a-f]{64}$'))
      )) IS TRUE`,
    ),
    catalog_lease_shape_check: check(
      "agent_sandbox_backups_catalog_lease_shape_check",
      sql`(
        ${table.catalog_lease_owner} IS NULL
        AND ${table.catalog_lease_generation} IS NULL
        AND ${table.catalog_lease_expires_at} IS NULL
      ) OR (
        ${table.catalog_lease_owner} IS NOT NULL
        AND ${table.catalog_lease_owner} <> ''
        AND ${table.catalog_lease_generation} IS NOT NULL
        AND ${table.catalog_lease_expires_at} IS NOT NULL
      )`,
    ),
    catalog_sizes_check: check(
      "agent_sandbox_backups_catalog_sizes_check",
      sql`COALESCE(${table.raw_size_bytes}, 0) >= 0
        AND COALESCE(${table.compressed_size_bytes}, 0) >= 0
        AND COALESCE(${table.encrypted_size_bytes}, 0) >= 0
        AND (${table.manifest_object_count} IS NULL
          OR ${table.manifest_object_count} BETWEEN 1 AND 8192)
        AND ${table.catalog_attempts} >= 0
        AND ${table.catalog_revision} >= 0`,
    ),
    catalog_error_bounds_check: check(
      "agent_sandbox_backups_catalog_error_bounds_check",
      sql`(${table.catalog_last_error_code} IS NULL OR length(${table.catalog_last_error_code}) <= 96)
        AND (${table.catalog_last_error} IS NULL OR length(${table.catalog_last_error}) <= 2048)`,
    ),
    catalog_restore_receipt_check: check(
      "agent_sandbox_backups_catalog_restore_receipt_check",
      sql`((${table.catalog_state} IS DISTINCT FROM 'restore_verified' OR (
          ${table.restore_receipt_digest} ~ '^[0-9a-f]{64}$'
          AND ${table.restore_generation} IS NOT NULL
          AND ${table.restore_verified_at} IS NOT NULL
        ))
        AND ((${table.restore_receipt_digest} IS NULL
          AND ${table.restore_generation} IS NULL
          AND ${table.restore_verified_at} IS NULL)
        OR (${table.restore_receipt_digest} ~ '^[0-9a-f]{64}$'
          AND ${table.restore_generation} IS NOT NULL
          AND ${table.restore_verified_at} IS NOT NULL))) IS TRUE`,
    ),
    catalog_delete_receipt_check: check(
      "agent_sandbox_backups_catalog_delete_receipt_check",
      sql`((${table.catalog_state} IS DISTINCT FROM 'deleted'
          AND ${table.catalog_delete_receipt_digest} IS NULL
          AND ${table.catalog_deleted_at} IS NULL)
        OR (${table.catalog_state} = 'deleted'
          AND ${table.catalog_delete_receipt_digest} ~ '^[0-9a-f]{64}$'
          AND ${table.catalog_deleted_at} IS NOT NULL)) IS TRUE`,
    ),
  }),
);

/**
 * Machine-readable trailer appended to `agent_sandboxes.error_message` when an
 * AGENT_UPGRADE exhausts retries on a ROLLBACK-SAFE failure (the old container
 * still serves its previous version). Encodes the exhausted TARGET digest so
 * the fleet reconciler can re-arm the agent for a NEWER target digest instead
 * of excluding it from all future upgrades forever. Lives in error_message to
 * avoid a schema migration; strictly additive (rows without it parse to null).
 * Defined here (schema layer) so both the writeback (provisioning-jobs service)
 * and the reconciler query (agent-sandboxes repository) can share it without a
 * service↔repository import cycle. See #15357 / lalalune's #15311 review.
 */
export const UPGRADE_FAILURE_TARGET_MARKER_PREFIX = "[upgrade-failed-target:";

export type AgentSandbox = InferSelectModel<typeof agentSandboxes>;
export type NewAgentSandbox = InferInsertModel<typeof agentSandboxes>;
export type StoredAgentSandboxBackup = InferSelectModel<typeof agentSandboxBackups>;
export type AgentSandboxBackup = Omit<StoredAgentSandboxBackup, "state_data"> & {
  state_data: AgentBackupPlainStateData;
};
export type NewAgentSandboxBackup = Omit<
  InferInsertModel<typeof agentSandboxBackups>,
  "sandbox_record_id" | "state_data"
> & {
  sandbox_record_id: string;
  state_data: AgentBackupStoredStateData;
};
