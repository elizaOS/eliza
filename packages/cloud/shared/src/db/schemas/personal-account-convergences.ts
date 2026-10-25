/**
 * Durable receipts for explicitly verified phone + Telegram provisional-account convergence.
 *
 * The source account is deleted by the merge transaction, so this row retains
 * the exact source/target personal-Eliza addresses needed to finish or replay
 * the cross-Durable-Object history alias after a process or network failure.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

export const PERSONAL_ACCOUNT_CONVERGENCE_STATUSES = ["pending_alias", "complete"] as const;
export type PersonalAccountConvergenceStatus =
  (typeof PERSONAL_ACCOUNT_CONVERGENCE_STATUSES)[number];

export const personalAccountConvergences = pgTable(
  "personal_account_convergences",
  {
    token: text("token").primaryKey(),
    source_user_id: uuid("source_user_id").notNull(),
    source_organization_id: uuid("source_organization_id").notNull(),
    source_agent_id: text("source_agent_id").notNull(),
    target_user_id: uuid("target_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    target_organization_id: uuid("target_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    target_agent_id: text("target_agent_id").notNull(),
    phone_number: text("phone_number").notNull(),
    telegram_id: text("telegram_id").notNull(),
    steward_user_id: text("steward_user_id").notNull(),
    status: text("status")
      .$type<PersonalAccountConvergenceStatus>()
      .notNull()
      .default("pending_alias"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    phone_telegram_unique: uniqueIndex("personal_account_convergences_phone_telegram_unique").on(
      table.phone_number,
      table.telegram_id,
    ),
    target_unique: uniqueIndex("personal_account_convergences_target_unique").on(
      table.target_user_id,
    ),
    status_check: check(
      "personal_account_convergences_status_check",
      sql`${table.status} IN ('pending_alias', 'complete')`,
    ),
  }),
);

export type PersonalAccountConvergence = InferSelectModel<typeof personalAccountConvergences>;
export type NewPersonalAccountConvergence = InferInsertModel<typeof personalAccountConvergences>;
