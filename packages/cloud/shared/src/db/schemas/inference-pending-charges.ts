// Defines the inference pending charges Drizzle table shape used by cloud repositories and services.
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * DB-backed pending-charge + settlement ledger for Tier-2 optimistic inference
 * billing (#9899).
 *
 * This is the durable, exactly-once replacement for the KV pending-charge
 * backstop (`iac:pending:<requestId>`). It exists to close the at-scale residuals
 * that a KV-only backstop cannot — they require a real database:
 *
 *   1. Hard concurrent-overdraw bound — admission accounts for every in-flight
 *      pending charge of the org under a row lock, so a burst can't collectively
 *      overdraw. KV has no per-org atomic accounting.
 *   2. Exactly-once settlement — `request_id` is the primary key and the settle
 *      is an atomic `UPDATE ... WHERE status = 'pending'` claim, so the inline
 *      settler and the cron sweep can never both charge one request. KV's
 *      get-then-delete is only near-atomic.
 *   3. Age-ordered sweep drain — the cron drains oldest-pending-first via an
 *      indexed `ORDER BY enqueued_at` cursor with no silent cap. KV scan is an
 *      unordered, bounded prefix scan.
 *
 * Lifecycle of a row:
 *   - `pending`     — admitted on the hot path; counted against the org balance.
 *   - `settled`     — the inline settler (or sweep) claimed it and the actual
 *                     (or estimated) cost was debited.
 *   - `uncollected` — claimed, but the debit was refused (balance would go
 *                     negative; the DB `CHECK(credit_balance >= 0)` forbids it).
 *                     Bounded over-spend, recorded for alerting/audit, never a
 *                     free-forever loop (the org drops to the safe path).
 *   - `corrupt`     — sweep found an invalid persisted estimate; the row is
 *                     terminal and auditable instead of being fabricated into a
 *                     debit amount.
 *
 * See `packages/cloud/api/docs/inference-hot-path.md` and
 * `lib/services/inference-billing-ledger.ts`.
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
