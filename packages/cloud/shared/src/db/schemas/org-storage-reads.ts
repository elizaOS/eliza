/**
 * Defines durable, tenant-bound receipts for paid native storage reads, lists,
 * and opaque signed-read capabilities.
 */
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { creditTransactions } from "./credit-transactions";
import { orgStorageObjects } from "./org-storage-mutations";
import { organizations } from "./organizations";
import { users } from "./users";

export type OrgStorageReadMethod = "get" | "head" | "list" | "presign";
export type OrgStorageReadState = "prepared" | "provider_succeeded" | "committed" | "failed";

export const orgStorageReadOperations = pgTable(
  "org_storage_read_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    object_id: uuid("object_id"),
    idempotency_key_hash: text("idempotency_key_hash").notNull(),
    request_digest: text("request_digest").notNull(),
    renewal_root_id: uuid("renewal_root_id"),
    renewal_generation: integer("renewal_generation").notNull().default(0),
    method: text("method").$type<OrgStorageReadMethod>().notNull(),
    state: text("state").$type<OrgStorageReadState>().notNull().default("prepared"),
    price_usd: numeric("price_usd", { precision: 12, scale: 6 }).notNull(),
    object_generation: bigint("object_generation", { mode: "bigint" }),
    provider_key: text("provider_key"),
    result_size_bytes: bigint("result_size_bytes", { mode: "bigint" }),
    result_content_type: text("result_content_type"),
    result_etag: text("result_etag"),
    response_status: integer("response_status"),
    response_json: text("response_json"),
    capability_id: uuid("capability_id"),
    capability_host: text("capability_host"),
    capability_issued_at: timestamp("capability_issued_at", { withTimezone: true }),
    capability_expires_at: timestamp("capability_expires_at", { withTimezone: true }),
    capability_revoked_at: timestamp("capability_revoked_at", { withTimezone: true }),
    retain_until: timestamp("retain_until", { withTimezone: true }),
    credit_transaction_id: uuid("credit_transaction_id"),
    provider_succeeded_at: timestamp("provider_succeeded_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    access_count: bigint("access_count", { mode: "bigint" }).notNull().default(0n),
    last_access_at: timestamp("last_access_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    object_tenant: foreignKey({
      name: "org_storage_read_operations_object_tenant_fkey",
      columns: [table.object_id, table.organization_id],
      foreignColumns: [orgStorageObjects.id, orgStorageObjects.organization_id],
    }).onDelete("restrict"),
    credit: foreignKey({
      name: "org_storage_read_operations_credit_fkey",
      columns: [table.credit_transaction_id],
      foreignColumns: [creditTransactions.id],
    }).onDelete("restrict"),
    renewal_root: foreignKey({
      name: "org_storage_read_operations_renewal_root_fkey",
      columns: [table.renewal_root_id],
      foreignColumns: [table.id as AnyPgColumn],
    }).onDelete("restrict"),
    idempotency: uniqueIndex("org_storage_read_operations_idempotency_uidx").on(
      table.organization_id,
      table.idempotency_key_hash,
    ),
    renewal: uniqueIndex("org_storage_read_operations_renewal_uidx")
      .on(table.organization_id, table.renewal_root_id, table.renewal_generation)
      .where(sql`${table.renewal_root_id} IS NOT NULL`),
    capability: uniqueIndex("org_storage_read_operations_capability_uidx")
      .on(table.capability_id)
      .where(sql`${table.capability_id} IS NOT NULL`),
    capability_expiry: index("org_storage_read_operations_capability_expiry_idx").on(
      table.capability_expires_at,
    ),
    retention: index("org_storage_read_operations_retention_idx").on(
      table.provider_key,
      table.retain_until,
    ),
    shape: check(
      "org_storage_read_operations_shape_check",
      sql`${table.idempotency_key_hash} ~ '^[0-9a-f]{64}$'
        AND ${table.request_digest} ~ '^[0-9a-f]{64}$'
        AND ${table.renewal_generation} >= 0
        AND ((${table.renewal_root_id} IS NULL AND ${table.renewal_generation} = 0)
          OR (${table.renewal_root_id} IS NOT NULL AND ${table.renewal_generation} > 0
            AND ${table.method} = 'presign'))
        AND ${table.method} IN ('get', 'head', 'list', 'presign')
        AND ${table.state} IN ('prepared', 'provider_succeeded', 'committed', 'failed')
        AND ${table.price_usd} >= 0 AND ${table.access_count} >= 0
        AND (${table.state} <> 'prepared' OR (
          ${table.object_generation} IS NULL AND ${table.provider_key} IS NULL
          AND ${table.result_size_bytes} IS NULL AND ${table.result_content_type} IS NULL
          AND ${table.result_etag} IS NULL AND ${table.response_status} IS NULL
          AND ${table.response_json} IS NULL AND ${table.provider_succeeded_at} IS NULL
          AND ${table.completed_at} IS NULL AND ${table.credit_transaction_id} IS NULL
          AND ${table.last_access_at} IS NULL AND ${table.access_count} = 0
        ))
        AND (${table.state} = 'prepared' OR (
          ${table.response_status} IS NOT NULL AND ${table.response_json} IS NOT NULL
        ))
        AND (${table.state} NOT IN ('provider_succeeded', 'committed')
          OR ${table.provider_succeeded_at} IS NOT NULL)
        AND (${table.state} NOT IN ('committed', 'failed') OR ${table.completed_at} IS NOT NULL)
        AND (${table.state} <> 'provider_succeeded' OR (
          ${table.credit_transaction_id} IS NULL AND ${table.completed_at} IS NULL
        ))
        AND (${table.state} = 'committed' OR (
          ${table.credit_transaction_id} IS NULL
          AND ${table.last_access_at} IS NULL AND ${table.access_count} = 0
        ))
        AND (${table.state} <> 'committed' OR (
          (${table.price_usd} = 0 AND ${table.credit_transaction_id} IS NULL)
          OR (${table.price_usd} > 0 AND ${table.credit_transaction_id} IS NOT NULL)
        ))
        AND (${table.method} = 'list' OR ${table.state} IN ('prepared', 'failed')
          OR ${table.object_id} IS NOT NULL)
        AND (${table.provider_key} IS NULL OR ${table.object_generation} IS NOT NULL)
        AND ((${table.capability_id} IS NULL AND ${table.capability_host} IS NULL
          AND ${table.capability_issued_at} IS NULL AND ${table.capability_expires_at} IS NULL)
          OR (${table.method} = 'presign' AND ${table.capability_id} IS NOT NULL
            AND ${table.capability_host} IS NOT NULL
            AND ${table.capability_issued_at} IS NOT NULL
            AND ${table.capability_expires_at} > ${table.capability_issued_at}))
        AND (${table.capability_revoked_at} IS NULL OR ${table.capability_id} IS NOT NULL)
        AND (${table.last_access_at} IS NULL OR ${table.access_count} > 0)`,
    ),
  }),
);

export type OrgStorageReadOperation = InferSelectModel<typeof orgStorageReadOperations>;
