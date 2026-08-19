/**
 * Defines the active native-storage mutation authority: logical object heads,
 * durable PUT receipts, and old-generation garbage-collection work.
 */
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { creditTransactions } from "./credit-transactions";
import { organizations } from "./organizations";

export const orgStorageObjects = pgTable(
  "org_storage_objects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    logical_key: text("logical_key").notNull(),
    generation: bigint("generation", { mode: "bigint" }).notNull().default(0n),
    provider_key: text("provider_key"),
    size_bytes: bigint("size_bytes", { mode: "bigint" }).notNull().default(0n),
    content_type: text("content_type"),
    content_sha256: text("content_sha256"),
    etag: text("etag"),
    uploaded_at: timestamp("uploaded_at", { withTimezone: true }),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenant_identity: unique("org_storage_objects_tenant_identity_unique").on(
      table.id,
      table.organization_id,
    ),
    tenant_key: uniqueIndex("org_storage_objects_tenant_key_uidx").on(
      table.organization_id,
      table.logical_key,
    ),
    provider_key: uniqueIndex("org_storage_objects_provider_key_uidx")
      .on(table.provider_key)
      .where(sql`${table.provider_key} IS NOT NULL`),
    shape: check(
      "org_storage_objects_shape_check",
      sql`${table.generation} >= 0 AND ${table.size_bytes} >= 0 AND ((
        ${table.generation} = 0 AND ${table.provider_key} IS NULL AND ${table.size_bytes} = 0
      ) OR (
        ${table.generation} = 0 AND ${table.provider_key} IS NOT NULL AND ${table.size_bytes} > 0
        AND char_length(${table.content_type}) BETWEEN 1 AND 255
        AND char_length(${table.etag}) BETWEEN 1 AND 512
        AND ${table.uploaded_at} IS NOT NULL AND ${table.deleted_at} IS NULL
      ) OR (
        ${table.generation} > 0 AND ${table.provider_key} IS NOT NULL
        AND ${table.content_sha256} ~ '^[0-9a-f]{64}$'
        AND char_length(${table.content_type}) BETWEEN 1 AND 255
        AND char_length(${table.etag}) BETWEEN 1 AND 512
        AND ${table.uploaded_at} IS NOT NULL AND ${table.deleted_at} IS NULL
      ) OR (
        ${table.generation} > 0 AND ${table.provider_key} IS NULL
        AND ${table.size_bytes} = 0 AND ${table.deleted_at} IS NOT NULL
      ))`,
    ),
  }),
);

export type OrgStoragePutState =
  | "prepared"
  | "reserved"
  | "provider_started"
  | "reconciling"
  | "committed"
  | "refunded";

export const orgStoragePutOperations = pgTable(
  "org_storage_put_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    object_id: uuid("object_id").notNull(),
    idempotency_key_hash: text("idempotency_key_hash").notNull(),
    request_digest: text("request_digest").notNull(),
    state: text("state").$type<OrgStoragePutState>().notNull().default("prepared"),
    source_generation: bigint("source_generation", { mode: "bigint" }).notNull(),
    source_provider_key: text("source_provider_key"),
    source_size_bytes: bigint("source_size_bytes", { mode: "bigint" }).notNull(),
    target_generation: bigint("target_generation", { mode: "bigint" }).notNull(),
    target_provider_key: text("target_provider_key").notNull(),
    target_size_bytes: bigint("target_size_bytes", { mode: "bigint" }).notNull(),
    target_content_type: text("target_content_type").notNull(),
    target_content_sha256: text("target_content_sha256").notNull(),
    quota_reserved_bytes: bigint("quota_reserved_bytes", { mode: "bigint" }).notNull(),
    price_usd: numeric("price_usd", { precision: 12, scale: 6 }).notNull(),
    credit_transaction_id: uuid("credit_transaction_id"),
    lease_token: uuid("lease_token"),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    provider_absence_observed_at: timestamp("provider_absence_observed_at", {
      withTimezone: true,
    }),
    result_etag: text("result_etag"),
    result_uploaded_at: timestamp("result_uploaded_at", { withTimezone: true }),
    response_json: text("response_json"),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    object_tenant: foreignKey({
      name: "org_storage_put_operations_object_tenant_fkey",
      columns: [table.object_id, table.organization_id],
      foreignColumns: [orgStorageObjects.id, orgStorageObjects.organization_id],
    }).onDelete("restrict"),
    credit: foreignKey({
      name: "org_storage_put_operations_credit_fkey",
      columns: [table.credit_transaction_id],
      foreignColumns: [creditTransactions.id],
    }).onDelete("restrict"),
    credit_tenant: check(
      "org_storage_put_operations_credit_tenant_check",
      sql`org_storage_credit_matches_tenant(${table.credit_transaction_id}, ${table.organization_id})`,
    ),
    idempotency: uniqueIndex("org_storage_put_operations_idempotency_uidx").on(
      table.organization_id,
      table.idempotency_key_hash,
    ),
    provider_key: uniqueIndex("org_storage_put_operations_provider_key_uidx").on(
      table.target_provider_key,
    ),
    active_object: uniqueIndex("org_storage_put_operations_active_object_uidx")
      .on(table.object_id)
      .where(sql`${table.state} IN ('prepared', 'reserved', 'provider_started', 'reconciling')`),
    due: index("org_storage_put_operations_due_idx").on(table.state, table.lease_expires_at),
    shape: check(
      "org_storage_put_operations_shape_check",
      sql`${table.idempotency_key_hash} ~ '^[0-9a-f]{64}$'
        AND ${table.request_digest} ~ '^[0-9a-f]{64}$'
        AND ${table.target_content_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.source_generation} >= 0
        AND ${table.target_generation} = ${table.source_generation} + 1
        AND ${table.source_size_bytes} >= 0 AND ${table.target_size_bytes} > 0
        AND ${table.quota_reserved_bytes} = GREATEST(
          ${table.target_size_bytes} - ${table.source_size_bytes}, 0
        )
        AND ${table.price_usd} >= 0
        AND (${table.state} IN ('prepared', 'reconciling', 'refunded')
          OR ${table.credit_transaction_id} IS NOT NULL OR ${table.price_usd} = 0)
        AND ((${table.lease_token} IS NULL) = (${table.lease_expires_at} IS NULL))
        AND (${table.state} <> 'reconciling' OR ${table.lease_token} IS NOT NULL)
        AND (${table.provider_absence_observed_at} IS NULL OR ${table.state} = 'reconciling')
        AND (${table.state} <> 'committed' OR (
          ${table.result_etag} IS NOT NULL AND ${table.result_uploaded_at} IS NOT NULL
          AND ${table.response_json} IS NOT NULL AND ${table.completed_at} IS NOT NULL
        ))
        AND (${table.state} <> 'refunded' OR (
          ${table.response_json} IS NOT NULL AND ${table.completed_at} IS NOT NULL
        ))`,
    ),
  }),
);

export const orgStorageGcOutbox = pgTable(
  "org_storage_gc_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    operation_id: uuid("operation_id")
      .notNull()
      .references(() => orgStoragePutOperations.id, { onDelete: "cascade" }),
    provider_key: text("provider_key").notNull(),
    state: text("state").notNull().default("pending"),
    not_before: timestamp("not_before", { withTimezone: true }).notNull(),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    operation: uniqueIndex("org_storage_gc_outbox_operation_uidx").on(table.operation_id),
    due: index("org_storage_gc_outbox_due_idx").on(table.state, table.not_before),
    shape: check(
      "org_storage_gc_outbox_shape_check",
      sql`${table.state} IN ('pending', 'completed')
        AND (${table.state} <> 'completed' OR ${table.completed_at} IS NOT NULL)`,
    ),
  }),
);

export type OrgStorageObject = InferSelectModel<typeof orgStorageObjects>;
export type OrgStoragePutOperation = InferSelectModel<typeof orgStoragePutOperations>;
export type NewOrgStoragePutOperation = InferInsertModel<typeof orgStoragePutOperations>;

export type OrgStorageDeleteState = "prepared" | "provider_started" | "committed";

export const orgStorageDeleteOperations = pgTable(
  "org_storage_delete_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    object_id: uuid("object_id").notNull(),
    idempotency_key_hash: text("idempotency_key_hash").notNull(),
    request_digest: text("request_digest").notNull(),
    state: text("state").$type<OrgStorageDeleteState>().notNull().default("prepared"),
    source_generation: bigint("source_generation", { mode: "bigint" }).notNull(),
    source_provider_key: text("source_provider_key").notNull(),
    source_size_bytes: bigint("source_size_bytes", { mode: "bigint" }).notNull(),
    lease_token: uuid("lease_token"),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    response_json: text("response_json"),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    object_tenant: foreignKey({
      name: "org_storage_delete_operations_object_tenant_fkey",
      columns: [table.object_id, table.organization_id],
      foreignColumns: [orgStorageObjects.id, orgStorageObjects.organization_id],
    }).onDelete("restrict"),
    idempotency: uniqueIndex("org_storage_delete_operations_idempotency_uidx").on(
      table.organization_id,
      table.idempotency_key_hash,
    ),
    active_object: uniqueIndex("org_storage_delete_operations_active_object_uidx")
      .on(table.object_id)
      .where(sql`${table.state} IN ('prepared', 'provider_started')`),
    due: index("org_storage_delete_operations_due_idx").on(table.state, table.lease_expires_at),
    shape: check(
      "org_storage_delete_operations_shape_check",
      sql`${table.idempotency_key_hash} ~ '^[0-9a-f]{64}$'
        AND ${table.request_digest} ~ '^[0-9a-f]{64}$'
        AND ${table.state} IN ('prepared', 'provider_started', 'committed')
        AND ${table.source_generation} >= 0 AND ${table.source_size_bytes} > 0
        AND ((${table.lease_token} IS NULL) = (${table.lease_expires_at} IS NULL))
        AND (${table.state} <> 'committed' OR (
          ${table.response_json} IS NOT NULL AND ${table.completed_at} IS NOT NULL
          AND ${table.lease_token} IS NULL
        ))`,
    ),
  }),
);

export type OrgStorageDeleteOperation = InferSelectModel<typeof orgStorageDeleteOperations>;
