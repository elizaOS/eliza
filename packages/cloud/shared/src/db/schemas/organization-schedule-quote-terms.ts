/** Private immutable source/customer billing terms owned by the original downgrade quote. */
import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { OrganizationScheduleQuoteTerms } from "../../lib/services/organization-schedule-quote-terms";
import { organizationPlanChangeQuotes } from "./organization-plan-change-quotes";
import { organizations } from "./organizations";
export const organizationScheduleQuoteTerms = pgTable(
  "organization_schedule_quote_terms",
  {
    quote_id: uuid("quote_id")
      .primaryKey()
      .references(() => organizationPlanChangeQuotes.id, { onDelete: "restrict" }),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    snapshot: jsonb("snapshot").$type<OrganizationScheduleQuoteTerms>().notNull(),
    snapshot_digest: text("snapshot_digest").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    digest: check(
      "organization_schedule_quote_terms_snapshot_digest_check",
      sql`${t.snapshot_digest} ~ '^[a-f0-9]{64}$'`,
    ),
    shape: check(
      "organization_schedule_quote_terms_shape",
      sql`(jsonb_typeof(${t.snapshot})='object' AND ${t.snapshot}->>'version'='1' AND jsonb_typeof(${t.snapshot}->'subscription')='object' AND jsonb_typeof(${t.snapshot}->'customer')='object' AND (${t.snapshot}-ARRAY['version','subscription','customer'])='{}'::jsonb) IS TRUE`,
    ),
  }),
);
