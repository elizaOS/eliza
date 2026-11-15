/** Selection hints for the existing Stripe cron's legacy queue adoption. */
import { sql } from "drizzle-orm";
import { bigint, check, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const stripeLegacyAdoptionCursors = pgTable(
  "stripe_legacy_adoption_cursors",
  {
    source_key: text("source_key").primaryKey(),
    cursor_digest: text("cursor_digest"),
    revision: bigint("revision", { mode: "bigint" }).notNull().default(0n),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    digest_check: check(
      "stripe_legacy_adoption_cursor_digest_check",
      sql`${table.cursor_digest} IS NULL OR ${table.cursor_digest} ~ '^[0-9a-f]{64}$'`,
    ),
    revision_check: check(
      "stripe_legacy_adoption_cursor_revision_check",
      sql`${table.revision} >= 0`,
    ),
  }),
);
