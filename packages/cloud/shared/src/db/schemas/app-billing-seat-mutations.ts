/** Journals complete standalone seat requests so retries cannot mutate a later reassignment. */
import type { AppBillingSeat } from "@elizaos/cloud-sdk/app-billing";
import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { appBillingScopes } from "./app-billing";

export type AppBillingSeatMutationResult =
  | { kind: "assign"; seat: AppBillingSeat }
  | { kind: "revoke"; revoked: boolean };

export const appBillingSeatMutations = pgTable(
  "app_billing_seat_mutations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    billing_scope_id: uuid("billing_scope_id")
      .notNull()
      .references(() => appBillingScopes.id, { onDelete: "restrict" }),
    idempotency_key: text("idempotency_key").notNull(),
    request_digest: text("request_digest").notNull(),
    result: jsonb("result").$type<AppBillingSeatMutationResult>().notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    operation_unique: uniqueIndex("app_billing_seat_mutations_operation_idx").on(
      t.billing_scope_id,
      t.idempotency_key,
    ),
    identity_check: check(
      "app_billing_seat_mutations_identity_check",
      sql`${t.idempotency_key} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' AND ${t.request_digest} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);
