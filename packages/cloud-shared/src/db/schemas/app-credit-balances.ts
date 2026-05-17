import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, numeric, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { apps } from "./apps";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * App credit balances table schema.
 *
 * Tracks credit balances for users within third-party apps.
 */
export const appCreditBalances = pgTable(
  "app_credit_balances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    credit_balance: numeric("credit_balance", { precision: 10, scale: 2 })
      .notNull()
      .default("0.00"),
    total_purchased: numeric("total_purchased", { precision: 10, scale: 2 })
      .notNull()
      .default("0.00"),
    total_spent: numeric("total_spent", { precision: 10, scale: 2 }).notNull().default("0.00"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    app_user_unique: uniqueIndex("app_credit_balances_app_user_idx").on(
      table.app_id,
      table.user_id,
    ),
    app_idx: index("app_credit_balances_app_idx").on(table.app_id),
    user_idx: index("app_credit_balances_user_idx").on(table.user_id),
    org_idx: index("app_credit_balances_org_idx").on(table.organization_id),
  }),
);

export type AppCreditBalance = InferSelectModel<typeof appCreditBalances>;
export type NewAppCreditBalance = InferInsertModel<typeof appCreditBalances>;
