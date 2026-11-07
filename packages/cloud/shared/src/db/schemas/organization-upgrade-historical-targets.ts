/** Immutable evidence of a historical target, never a current entitlement projection. */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizationUpgradeInvoiceOrigins } from "./organization-upgrade-invoice-origins";
import { organizations } from "./organizations";
import { billingSubscriptionCommands } from "./subscription-billing-operations";
export const organizationUpgradeHistoricalTargets = pgTable(
  "organization_upgrade_historical_targets",
  {
    command_id: uuid("command_id").primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    provider_event_id: text("provider_event_id").notNull(),
    event_type: text("event_type").notNull(),
    api_version: text("api_version").notNull(),
    livemode: boolean("livemode").notNull(),
    invoice_id: text("invoice_id").notNull(),
    event_created_at: timestamp("event_created_at", { withTimezone: true }).notNull(),
    observed_at: timestamp("observed_at", { withTimezone: true }).notNull(),
    evidence_digest: text("evidence_digest").notNull(),
    raw_subscription: jsonb("raw_subscription").$type<Record<string, unknown>>().notNull(),
  },
  (t) => ({
    command: foreignKey({
      name: "organization_upgrade_target_command_fk",
      columns: [t.command_id, t.organization_id],
      foreignColumns: [billingSubscriptionCommands.id, billingSubscriptionCommands.organization_id],
    }).onDelete("restrict"),
    origin: foreignKey({
      name: "organization_upgrade_target_origin_fk",
      columns: [t.command_id],
      foreignColumns: [organizationUpgradeInvoiceOrigins.command_id],
    }).onDelete("restrict"),
    event: uniqueIndex("organization_upgrade_target_event_idx").on(t.livemode, t.provider_event_id),
    tenant: index("organization_upgrade_target_tenant_idx").on(t.organization_id, t.observed_at),
    shape: check(
      "organization_upgrade_target_shape",
      sql`${t.provider_event_id} ~ '^evt_[A-Za-z0-9]+$' AND ${t.invoice_id} ~ '^in_[A-Za-z0-9]+$' AND ${t.event_type} IN ('customer.subscription.updated','customer.subscription.pending_update_applied') AND ${t.api_version}='2024-11-20.acacia' AND ${t.evidence_digest} ~ '^[a-f0-9]{64}$' AND ${t.observed_at}>=${t.event_created_at} AND jsonb_typeof(${t.raw_subscription})='object'`,
    ),
  }),
);
