/** Defines durable provider-call admissions serialized with organization lifecycle fences. */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const providerAdmissions = pgTable(
  "provider_admissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    operation_kind: text("operation_kind").notNull(),
    operation_id: uuid("operation_id").notNull(),
    admitted_at: timestamp("admitted_at", { withTimezone: true }).notNull(),
    released_at: timestamp("released_at", { withTimezone: true }),
  },
  (table) => ({
    operation_idx: uniqueIndex("provider_admissions_operation_idx").on(
      table.operation_kind,
      table.operation_id,
    ),
    active_organization_idx: index("provider_admissions_active_organization_idx").on(
      table.organization_id,
      table.released_at,
    ),
  }),
);

export type ProviderAdmission = InferSelectModel<typeof providerAdmissions>;
export type NewProviderAdmission = InferInsertModel<typeof providerAdmissions>;
