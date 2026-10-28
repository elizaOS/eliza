/** Escrow ownership and request receipts backed by the canonical funding ledger. */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { billingFundingReservations } from "./billing-funding-reservations";
import { organizations } from "./organizations";

export const inferenceFundingBudgetGrants = pgTable(
  "inference_funding_budget_grants",
  {
    id: uuid("id").primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    funding_reservation_id: uuid("funding_reservation_id").notNull(),
    request_digest: text("request_digest").notNull(),
    policy_generation: text("policy_generation").notNull(),
    policy_epoch: text("policy_epoch").notNull(),
    amount: numeric("amount", { precision: 16, scale: 6 }).notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closed_at: timestamp("closed_at", { withTimezone: true }),
    seal_sequence: integer("seal_sequence"),
    seal_amount: numeric("seal_amount", { precision: 16, scale: 6 }),
    seal_signature: text("seal_signature"),
  },
  (t) => ({
    tenant: uniqueIndex("inference_funding_budget_grants_id_org_idx").on(t.id, t.organization_id),
    reservation: uniqueIndex("inference_funding_budget_grants_reservation_idx").on(
      t.funding_reservation_id,
    ),
    reservationTenant: foreignKey({
      columns: [t.funding_reservation_id, t.organization_id],
      foreignColumns: [billingFundingReservations.id, billingFundingReservations.organization_id],
    }).onDelete("restrict"),
    shape: check(
      "inference_funding_budget_grants_shape",
      sql`${t.amount} > 0 AND ${t.request_digest} ~ '^[0-9a-f]{64}$' AND ${t.policy_generation} ~ '^(0|[1-9][0-9]*)$' AND ${t.policy_epoch} ~ '^(0|[1-9][0-9]*)$' AND ${t.expires_at} > ${t.created_at} AND ((${t.closed_at} IS NULL AND ${t.seal_sequence} IS NULL AND ${t.seal_amount} IS NULL AND ${t.seal_signature} IS NULL) OR (${t.closed_at} IS NOT NULL AND ${t.seal_sequence} >= 0 AND ${t.seal_amount} >= 0 AND ${t.seal_amount} <= ${t.amount} AND ${t.seal_signature} ~ '^[0-9a-f]{64}$'))`,
    ),
  }),
);

export const inferenceFundingBudgetReceipts = pgTable(
  "inference_funding_budget_receipts",
  {
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    request_id: text("request_id").notNull(),
    request_digest: text("request_digest").notNull(),
    amount: numeric("amount", { precision: 16, scale: 6 }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    request: uniqueIndex("inference_funding_budget_receipts_org_request_idx").on(
      t.organization_id,
      t.request_id,
    ),
    shape: check(
      "inference_funding_budget_receipts_shape",
      sql`length(${t.request_id}) BETWEEN 1 AND 128 AND ${t.request_digest} ~ '^[0-9a-f]{64}$' AND ${t.amount} >= 0`,
    ),
  }),
);

export const inferenceFundingBudgetConsumptions = pgTable(
  "inference_funding_budget_consumptions",
  {
    organization_id: uuid("organization_id").notNull(),
    request_id: text("request_id").notNull(),
    grant_id: uuid("grant_id").notNull(),
    sequence: integer("sequence").notNull(),
    amount: numeric("amount", { precision: 16, scale: 6 }).notNull(),
  },
  (t) => ({
    sequence: uniqueIndex("inference_funding_budget_consumptions_sequence_idx").on(
      t.grant_id,
      t.sequence,
    ),
    request: uniqueIndex("inference_funding_budget_consumptions_request_idx").on(
      t.organization_id,
      t.request_id,
      t.grant_id,
    ),
    grantTenant: foreignKey({
      columns: [t.grant_id, t.organization_id],
      foreignColumns: [
        inferenceFundingBudgetGrants.id,
        inferenceFundingBudgetGrants.organization_id,
      ],
    }).onDelete("restrict"),
    receiptTenant: foreignKey({
      columns: [t.organization_id, t.request_id],
      foreignColumns: [
        inferenceFundingBudgetReceipts.organization_id,
        inferenceFundingBudgetReceipts.request_id,
      ],
    }).onDelete("restrict"),
    shape: check(
      "inference_funding_budget_consumptions_shape",
      sql`${t.sequence} > 0 AND ${t.amount} > 0`,
    ),
  }),
);
