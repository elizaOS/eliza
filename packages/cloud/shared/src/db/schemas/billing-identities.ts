/** Retains opaque billing provenance independently of deletable login identities. These rows never confer membership or authentication authority. */
import { sql } from "drizzle-orm";
import { check, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

export const billingEligibilityPrincipals = pgTable("billing_eligibility_principals", {
  id: uuid("id").primaryKey(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const billingIdentitySubjects = pgTable(
  "billing_identity_subjects",
  {
    id: uuid("id").primaryKey(),
    live_user_id: uuid("live_user_id").references(() => users.id, { onDelete: "set null" }),
    eligibility_principal_id: uuid("eligibility_principal_id")
      .notNull()
      .references(() => billingEligibilityPrincipals.id, { onDelete: "restrict" }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    liveUser: uniqueIndex("billing_identity_subjects_live_user_idx").on(t.live_user_id),
    actorIdentity: check(
      "billing_identity_subjects_actor_identity_check",
      sql`${t.live_user_id} IS NULL OR ${t.live_user_id} = ${t.id}`,
    ),
  }),
);
