/** Immutable original-invoice attribution. This receipt is not a paid-result or allowance grant. */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { billingSubscriptionCommands } from "./subscription-billing-operations";
export const organizationUpgradeInvoiceOrigins = pgTable(
  "organization_upgrade_invoice_origins",
  {
    command_id: uuid("command_id").primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    invoice_id: text("invoice_id").notNull(),
    evidence_kind: text("evidence_kind")
      .$type<"invoice_created_event" | "update_response">()
      .notNull(),
    provider_event_id: text("provider_event_id"),
    provider_request_id: text("provider_request_id").notNull(),
    provider_idempotency_key: text("provider_idempotency_key").notNull(),
    customer_id: text("customer_id").notNull(),
    subscription_id: text("subscription_id").notNull(),
    livemode: boolean("livemode").notNull(),
    api_version: text("api_version").notNull(),
    invoice_created_at: timestamp("invoice_created_at", { withTimezone: true }).notNull(),
    event_created_at: timestamp("event_created_at", { withTimezone: true }),
    observed_at: timestamp("observed_at", { withTimezone: true }).notNull(),
    evidence_digest: text("evidence_digest").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    command: foreignKey({
      name: "organization_upgrade_origin_command_fk",
      columns: [t.command_id, t.organization_id],
      foreignColumns: [billingSubscriptionCommands.id, billingSubscriptionCommands.organization_id],
    }).onDelete("restrict"),
    tenant: index("organization_upgrade_origin_tenant_idx").on(t.organization_id, t.created_at),
    invoice: uniqueIndex("organization_upgrade_origin_invoice_idx").on(t.livemode, t.invoice_id),
    event: uniqueIndex("organization_upgrade_origin_event_idx").on(t.livemode, t.provider_event_id),
    shape: check(
      "organization_upgrade_origin_shape",
      sql`${t.invoice_id} ~ '^in_[A-Za-z0-9]+$'  AND ${t.provider_request_id} ~ '^req_[A-Za-z0-9]+$' AND ${t.customer_id} ~ '^cus_[A-Za-z0-9]+$' AND ${t.subscription_id} ~ '^sub_[A-Za-z0-9]+$' AND length(${t.provider_idempotency_key})>0 AND ${t.api_version}='2024-11-20.acacia' AND ${t.evidence_digest} ~ '^[a-f0-9]{64}$' AND ${t.observed_at}>=${t.invoice_created_at} AND ((${t.evidence_kind}='invoice_created_event' AND ${t.provider_event_id} ~ '^evt_[A-Za-z0-9]+$' AND ${t.event_created_at}>=${t.invoice_created_at} AND ${t.observed_at}>=${t.event_created_at}) OR (${t.evidence_kind}='update_response' AND ${t.provider_event_id} IS NULL AND ${t.event_created_at} IS NULL)) IS TRUE AND ${t.created_at}>=${t.observed_at}`,
    ),
  }),
);
