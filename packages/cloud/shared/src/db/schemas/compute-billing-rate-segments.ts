/** Immutable state and price transitions used to settle delayed compute billing intervals. */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { bigint, check, index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const computeBillingRateSegments = pgTable(
  "compute_billing_rate_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    workload_kind: text("workload_kind").$type<"agent" | "container">().notNull(),
    workload_id: uuid("workload_id").notNull(),
    lifecycle_revision: bigint("lifecycle_revision", { mode: "number" }).notNull(),
    billing_state: text("billing_state").notNull(),
    rate_per_hour: numeric("rate_per_hour", { precision: 16, scale: 6 }).notNull(),
    effective_at: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workload_time_idx: index("compute_billing_rate_segments_workload_time_idx").on(
      table.organization_id,
      table.workload_kind,
      table.workload_id,
      table.effective_at,
      table.id,
    ),
    kind_check: check(
      "compute_billing_rate_segments_kind_check",
      sql`${table.workload_kind} IN ('agent', 'container')`,
    ),
    rate_check: check("compute_billing_rate_segments_rate_check", sql`${table.rate_per_hour} >= 0`),
  }),
);

export type ComputeBillingRateSegment = InferSelectModel<typeof computeBillingRateSegments>;
export type NewComputeBillingRateSegment = InferInsertModel<typeof computeBillingRateSegments>;
