// Defines the inference pending charges Drizzle table shape used by cloud repositories and services.
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * Retired pending-charge ledger of the deleted optimistic inference lane
 * (#9899). Nothing writes, settles or sweeps it any more: Worker inference is
 * fenced by the organization Durable Object lease and settles under its
 * alarm. The table is kept only until a drop migration, and must hold no
 * `pending` rows when that runs.
 */
export const inferencePendingCharges = pgTable(
  "inference_pending_charges",
  {
    /** The request id — the idempotency key. PK ⇒ exactly-once settlement. */
    request_id: text("request_id").primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Informational; not FK-constrained so a key rotation can't orphan a row. */
    api_key_id: uuid("api_key_id"),
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    billing_source: text("billing_source").notNull(),
    /** Pre-forward cost estimate; the in-flight amount the admission gate reserves. */
    estimated_cost_usd: numeric("estimated_cost_usd", { precision: 12, scale: 6 }).notNull(),
    /** The amount actually charged at settle (actual inline, estimate via sweep). */
    actual_cost_usd: numeric("actual_cost_usd", { precision: 12, scale: 6 }),
    status: text("status").notNull().default("pending"),
    enqueued_at: timestamp("enqueued_at").notNull().defaultNow(),
    settled_at: timestamp("settled_at"),
  },
  (table) => ({
    /** Age-ordered sweep over still-pending rows (oldest-first cursor, no cap). */
    pending_age_idx: index("inference_pending_charges_pending_age_idx")
      .on(table.enqueued_at)
      .where(sql`status = 'pending'`),
    /** Per-org in-flight SUM for the atomic admission gate. */
    org_pending_idx: index("inference_pending_charges_org_pending_idx")
      .on(table.organization_id)
      .where(sql`status = 'pending'`),
  }),
);

export type InferencePendingChargeRow = InferSelectModel<typeof inferencePendingCharges>;
export type NewInferencePendingChargeRow = InferInsertModel<typeof inferencePendingCharges>;
