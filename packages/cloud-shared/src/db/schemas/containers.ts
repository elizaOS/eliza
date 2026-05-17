/**
 * User-deployed Docker containers.
 *
 * See `agent-sandboxes.ts` for the companion table and a full explanation
 * of why these two tables are intentionally separate.
 *
 * Short answer: `containers` = user-controlled arbitrary workloads with
 * persistent volumes and public URLs. `agent_sandboxes` = system-managed
 * full-lifecycle Eliza agent instances with Neon DB, bridge proxy, and backups.
 * They share the Hetzner-Docker compute pool but nothing else.
 */
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { apiKeys } from "./api-keys";
import { creditTransactions } from "./credit-transactions";
import { organizations } from "./organizations";
import { userCharacters } from "./user-characters";
import { users } from "./users";

/**
 * Containers table schema.
 *
 * Tracks user-deployed container instances on the Hetzner-Docker pool.
 * Each row is one Docker container running on a registered docker_node.
 */
export const containers = pgTable(
  "containers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    project_name: text("project_name").notNull(),
    description: text("description"),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    api_key_id: uuid("api_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    character_id: uuid("character_id").references(() => userCharacters.id, {
      onDelete: "set null",
    }),
    /** Public URL exposed by the ingress / direct host:port mapping. */
    load_balancer_url: text("load_balancer_url"),
    /**
     * Stable per-container hostname under CONTAINERS_PUBLIC_BASE_DOMAIN
     * (e.g. `xyz123.containers.elizacloud.ai`). Used by the ingress map
     * endpoint to wire reverse-proxy / DNS configuration.
     */
    public_hostname: text("public_hostname"),
    status: text("status").default("pending").notNull(),
    /** Full Docker image reference (e.g. ghcr.io/owner/repo:tag). */
    image_tag: text("image_tag"),
    environment_vars: jsonb("environment_vars")
      .$type<Record<string, string>>()
      .default({})
      .notNull(),
    desired_count: integer("desired_count").default(1).notNull(),
    cpu: integer("cpu").default(1792).notNull(),
    memory: integer("memory").default(1792).notNull(),
    port: integer("port").default(3000).notNull(),
    health_check_path: text("health_check_path").default("/health"),
    /** docker_nodes.node_id this container is pinned to (for stateful sticky scheduling). */
    node_id: text("node_id"),
    /** Host filesystem path mounted into the container at /data (persistent volume). */
    volume_path: text("volume_path"),
    /** Informational: declared volume size in GiB. */
    volume_size_gb: integer("volume_size_gb"),
    /**
     * Hetzner Cloud block storage volume id (when network-attached). NULL
     * means the container is using a local-host volume bound to its node.
     */
    hcloud_volume_id: integer("hcloud_volume_id"),
    /** Hetzner Cloud location the network volume lives in (e.g. "fsn1"). */
    volume_location: text("volume_location"),
    last_deployed_at: timestamp("last_deployed_at"),
    last_health_check: timestamp("last_health_check"),
    deployment_log: text("deployment_log"),
    deployment_log_storage: text("deployment_log_storage").notNull().default("inline"),
    deployment_log_key: text("deployment_log_key"),
    error_message: text("error_message"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    last_billed_at: timestamp("last_billed_at"),
    next_billing_at: timestamp("next_billing_at"),
    billing_status: text("billing_status").default("active").notNull(),
    shutdown_warning_sent_at: timestamp("shutdown_warning_sent_at"),
    scheduled_shutdown_at: timestamp("scheduled_shutdown_at"),
    total_billed: numeric("total_billed", { precision: 10, scale: 2 }).default("0.00").notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    organization_idx: index("containers_organization_idx").on(table.organization_id),
    user_idx: index("containers_user_idx").on(table.user_id),
    status_idx: index("containers_status_idx").on(table.status),
    character_idx: index("containers_character_idx").on(table.character_id),
    project_name_idx: index("containers_project_name_idx").on(table.project_name),
    user_project_idx: index("containers_user_project_idx").on(table.user_id, table.project_name),
    billing_status_idx: index("containers_billing_status_idx").on(table.billing_status),
    next_billing_idx: index("containers_next_billing_idx").on(table.next_billing_at),
    scheduled_shutdown_idx: index("containers_scheduled_shutdown_idx").on(
      table.scheduled_shutdown_at,
    ),
    node_idx: index("containers_node_idx").on(table.node_id),
    public_hostname_idx: index("containers_public_hostname_idx").on(table.public_hostname),
    hcloud_volume_idx: index("containers_hcloud_volume_idx").on(table.hcloud_volume_id),
    volume_location_idx: index("containers_volume_location_idx").on(table.volume_location),
    /**
     * One active stateful container per (org, project_name). The partial
     * predicate is the source of truth — Drizzle does not enforce
     * predicates client-side, but having the index here keeps schema
     * introspection consistent with the SQL migration.
     */
    active_project_volume_unique: uniqueIndex("containers_active_project_volume_unique")
      .on(table.organization_id, table.project_name)
      .where(sql`${table.status} not in ('failed','stopped') and ${table.volume_path} is not null`),
  }),
);

/**
 * Container billing records table schema.
 *
 * Audit trail for daily container billing charges.
 */
export const containerBillingRecords = pgTable(
  "container_billing_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    container_id: uuid("container_id")
      .notNull()
      .references(() => containers.id, { onDelete: "cascade" }),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    billing_period_start: timestamp("billing_period_start").notNull(),
    billing_period_end: timestamp("billing_period_end").notNull(),
    status: text("status").default("success").notNull(), // success, failed, insufficient_credits
    credit_transaction_id: uuid("credit_transaction_id").references(() => creditTransactions.id, {
      onDelete: "set null",
    }),
    error_message: text("error_message"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    container_idx: index("container_billing_records_container_idx").on(table.container_id),
    org_idx: index("container_billing_records_org_idx").on(table.organization_id),
    created_idx: index("container_billing_records_created_idx").on(table.created_at),
    status_idx: index("container_billing_records_status_idx").on(table.status),
  }),
);

// Type inference
export type Container = InferSelectModel<typeof containers>;
export type NewContainer = InferInsertModel<typeof containers>;
export type ContainerBillingRecord = InferSelectModel<typeof containerBillingRecords>;
export type NewContainerBillingRecord = InferInsertModel<typeof containerBillingRecords>;
