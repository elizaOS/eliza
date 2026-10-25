/** Records preserved pre-cutover compute receipts whose ledger binding cannot be validated. */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { containerBillingRecords } from "./containers";
import { organizations } from "./organizations";

export const containerBillingLegacyLedgerBindings = pgTable(
  "container_billing_legacy_ledger_bindings",
  {
    receipt_id: uuid("receipt_id")
      .primaryKey()
      .references(() => containerBillingRecords.id, { onDelete: "restrict" }),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    credit_transaction_id: uuid("credit_transaction_id"),
    classification: text("classification").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    classification_check: check(
      "container_billing_legacy_ledger_bindings_classification_check",
      sql`${table.classification} IN ('missing_reference', 'missing_transaction', 'tenant_mismatch')`,
    ),
    org_created_idx: index("container_billing_legacy_ledger_bindings_org_created_idx").on(
      table.organization_id,
      table.created_at,
    ),
  }),
);

export type ContainerBillingLegacyLedgerBinding = InferSelectModel<
  typeof containerBillingLegacyLedgerBindings
>;
export type NewContainerBillingLegacyLedgerBinding = InferInsertModel<
  typeof containerBillingLegacyLedgerBindings
>;
