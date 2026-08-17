/**
 * Defines immutable terminal receipts for idempotent organization-scoped native storage HEADs.
 * Typed response evidence survives catalog/provider deletion without retaining raw storage keys.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { creditTransactions } from "./credit-transactions";
import { organizations } from "./organizations";

export type OrgStorageHeadReceiptResponseKind =
  | "ok"
  | "not_modified"
  | "not_found"
  | "precondition_failed";
export type OrgStorageHeadHeaderPolicyVersion = 1;

export const orgStorageHeadReceipts = pgTable(
  "org_storage_head_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id").notNull(),
    authority_version: smallint("authority_version").notNull().default(1),
    storage_namespace: text("storage_namespace").notNull().default("attachment-r2-v1"),
    operation: text("operation").notNull().default("head"),
    idempotency_key_hash: text("idempotency_key_hash").notNull(),
    request_digest: text("request_digest").notNull(),
    charge_amount_usd: numeric("charge_amount_usd", { precision: 12, scale: 6 }).notNull(),
    response_kind: text("response_kind").$type<OrgStorageHeadReceiptResponseKind>().notNull(),
    response_status: smallint("response_status").notNull(),
    header_policy_version: smallint("header_policy_version")
      .$type<OrgStorageHeadHeaderPolicyVersion>()
      .notNull()
      .default(1),
    object_id: uuid("object_id"),
    object_generation: bigint("object_generation", { mode: "bigint" }),
    response_content_length: bigint("response_content_length", { mode: "bigint" }),
    response_content_type: text("response_content_type"),
    response_etag: text("response_etag"),
    response_last_modified: timestamp("response_last_modified", { withTimezone: true }),
    response_force_attachment: boolean("response_force_attachment"),
    credit_transaction_id: uuid("credit_transaction_id"),
    receipt_digest: text("receipt_digest").notNull(),
    replay_expires_at: timestamp("replay_expires_at", { withTimezone: true }).notNull(),
    purge_after: timestamp("purge_after", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organization_fk: foreignKey({
      name: "org_storage_head_receipts_organization_id_fkey",
      columns: [table.organization_id],
      foreignColumns: [organizations.id],
    }).onDelete("cascade"),
    credit_transaction_fk: foreignKey({
      name: "org_storage_head_receipts_credit_transaction_id_fkey",
      columns: [table.credit_transaction_id],
      foreignColumns: [creditTransactions.id],
    }).onDelete("no action"),
    idempotency_uidx: uniqueIndex("org_storage_head_receipts_idempotency_uidx").on(
      table.organization_id,
      table.idempotency_key_hash,
    ),
    credit_transaction_uidx: uniqueIndex("org_storage_head_receipts_credit_transaction_uidx")
      .on(table.credit_transaction_id)
      .where(sql`${table.credit_transaction_id} IS NOT NULL`),
    purge_idx: index("org_storage_head_receipts_purge_idx").on(table.purge_after, table.id),
    org_object_generation_idx: index("org_storage_head_receipts_org_object_generation_idx")
      .on(table.organization_id, table.object_id, table.object_generation)
      .where(sql`${table.object_id} IS NOT NULL`),
    identity_check: check(
      "org_storage_head_receipts_identity_check",
      sql`(
        ${table.authority_version} = 1 AND ${table.storage_namespace} = 'attachment-r2-v1'
        AND ${table.operation} = 'head' AND ${table.header_policy_version} = 1
        AND ${table.idempotency_key_hash} ~ '^sha256:[0-9a-f]{64}$'
        AND ${table.request_digest} ~ '^sha256:[0-9a-f]{64}$'
        AND ${table.receipt_digest} ~ '^[0-9a-f]{64}$'
      ) IS TRUE`,
    ),
    charge_shape_check: check(
      "org_storage_head_receipts_charge_shape_check",
      sql`(
        ${table.charge_amount_usd} <> 'NaN'::numeric
        AND ${table.charge_amount_usd} <= 999999.999999 AND (
          (${table.charge_amount_usd} = 0 AND ${table.credit_transaction_id} IS NULL)
          OR (${table.charge_amount_usd} > 0 AND ${table.credit_transaction_id} IS NOT NULL)
        )
      ) IS TRUE`,
    ),
    retention_check: check(
      "org_storage_head_receipts_retention_check",
      sql`(
        isfinite(${table.created_at}) AND isfinite(${table.replay_expires_at})
        AND isfinite(${table.purge_after})
        AND ${table.created_at} < ${table.replay_expires_at}
        AND ${table.replay_expires_at} < ${table.purge_after}
      ) IS TRUE`,
    ),
    response_value_check: check(
      "org_storage_head_receipts_response_value_check",
      sql`(
        (${table.object_generation} IS NULL OR ${table.object_generation} > 0)
        AND (${table.response_content_length} IS NULL
          OR ${table.response_content_length} BETWEEN 0 AND 9007199254740991)
        AND (${table.response_content_type} IS NULL OR (
          char_length(${table.response_content_type}) BETWEEN 1 AND 255
          AND ${table.response_content_type}
            COLLATE "C" !~ U&'^[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]|[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]$'
          AND ${table.response_content_type} COLLATE "C"
            !~ U&'[\\0001-\\001F\\007F-\\009F]'))
        AND (${table.response_etag} IS NULL OR (
          char_length(${table.response_etag}) BETWEEN 1 AND 512
          AND ${table.response_etag} ~ '^[!#-~]+$'))
        AND (${table.response_last_modified} IS NULL OR (
          isfinite(${table.response_last_modified})
          AND ${table.response_last_modified} = date_trunc('second', ${table.response_last_modified})))
      ) IS TRUE`,
    ),
    response_shape_check: check(
      "org_storage_head_receipts_response_shape_check",
      sql`(
        (${table.response_kind} = 'ok' AND ${table.response_status} = 200 AND num_nulls(
          ${table.object_id}, ${table.object_generation}, ${table.response_content_length},
          ${table.response_content_type}, ${table.response_etag},
          ${table.response_last_modified}, ${table.response_force_attachment}) = 0)
        OR (${table.response_kind} = 'not_modified' AND ${table.response_status} = 304
          AND num_nulls(${table.object_id}, ${table.object_generation}, ${table.response_etag},
            ${table.response_last_modified}) = 0
          AND num_nonnulls(${table.response_content_length}, ${table.response_content_type},
            ${table.response_force_attachment}) = 0)
        OR (${table.response_kind} = 'not_found' AND ${table.response_status} = 404
          AND num_nonnulls(${table.object_id}, ${table.object_generation},
            ${table.response_content_length}, ${table.response_content_type},
            ${table.response_etag}, ${table.response_last_modified},
            ${table.response_force_attachment}) = 0)
        OR (${table.response_kind} = 'precondition_failed' AND ${table.response_status} = 412
          AND num_nulls(${table.object_id}, ${table.object_generation}, ${table.response_etag},
            ${table.response_last_modified}) = 0
          AND num_nonnulls(${table.response_content_length}, ${table.response_content_type},
            ${table.response_force_attachment}) = 0)
      ) IS TRUE`,
    ),
  }),
);

export type OrgStorageHeadReceipt = InferSelectModel<typeof orgStorageHeadReceipts>;
export type NewOrgStorageHeadReceipt = InferInsertModel<typeof orgStorageHeadReceipts>;
