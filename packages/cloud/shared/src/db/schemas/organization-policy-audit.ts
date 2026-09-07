/** Retains organization policy generation and actor evidence across override deletion. */
import { bigint, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
export const organizationPolicyAudit = pgTable(
  "organization_policy_audit",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    generation: bigint("generation", { mode: "bigint" }).notNull(),
    reason: text("reason").notNull(),
    actor: text("actor").notNull(),
    change: jsonb("change").$type<Record<string, string | number | boolean | null>>().notNull(),
    recorded_at: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    generation: uniqueIndex("organization_policy_audit_generation_idx").on(
      table.organization_id,
      table.generation,
    ),
  }),
);
