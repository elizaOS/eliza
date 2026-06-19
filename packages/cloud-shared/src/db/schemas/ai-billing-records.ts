import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { creditTransactions } from "./credit-transactions";
import { organizations } from "./organizations";
import { usageRecords } from "./usage-records";
import { users } from "./users";

/**
 * Durable join record for AI inference billing.
 *
 * Usage rows describe model usage and cost. Credit transactions describe ledger
 * movement. This table ties both sides to one request/idempotency key so
 * reconciliation can prove billed usage, ledger movement, pricing source, and
 * provider metadata all refer to the same inference.
 */
export const aiBillingRecords = pgTable(
  "ai_billing_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    usage_record_id: uuid("usage_record_id")
      .notNull()
      .references(() => usageRecords.id, { onDelete: "cascade" }),
    reservation_transaction_id: uuid("reservation_transaction_id").references(
      () => creditTransactions.id,
      { onDelete: "set null" },
    ),
    settlement_transaction_ids: jsonb("settlement_transaction_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    idempotency_key: text("idempotency_key").notNull(),
    request_id: text("request_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    billing_source: text("billing_source"),
    pricing_snapshot_ids: jsonb("pricing_snapshot_ids").$type<string[]>().notNull().default([]),
    provider_request_id: text("provider_request_id"),
    provider_instance_id: text("provider_instance_id"),
    provider_endpoint: text("provider_endpoint"),
    usage_total_cost: numeric("usage_total_cost", { precision: 12, scale: 6 }).notNull(),
    ledger_total: numeric("ledger_total", { precision: 12, scale: 6 }).notNull(),
    status: text("status").notNull().default("recorded"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    org_created_idx: index("ai_billing_records_org_created_idx").on(
      table.organization_id,
      table.created_at,
    ),
    provider_model_idx: index("ai_billing_records_provider_model_idx").on(
      table.provider,
      table.model,
    ),
    provider_instance_idx: index("ai_billing_records_provider_instance_idx").on(
      table.provider_instance_id,
    ),
    usage_record_unique: uniqueIndex("ai_billing_records_usage_record_unique").on(
      table.usage_record_id,
    ),
    org_idempotency_unique: uniqueIndex("ai_billing_records_org_idempotency_unique").on(
      table.organization_id,
      table.idempotency_key,
    ),
  }),
);

export type AiBillingRecord = InferSelectModel<typeof aiBillingRecords>;
export type NewAiBillingRecord = InferInsertModel<typeof aiBillingRecords>;
