import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Per-organization rate limit overrides.
 *
 * Nullable columns: NULL means "use the tier default."
 * Only non-null fields override the automatically computed tier limits.
 *
 * Note: A DB-level CHECK constraint (chk_rpm_positive) ensures RPM values are
 * either NULL or > 0. See migration 0063 — Drizzle doesn't support raw constraints.
 */
export const orgRateLimitOverrides = pgTable("org_rate_limit_overrides", {
  id: uuid("id").defaultRandom().primaryKey(),
  organization_id: uuid("organization_id")
    .notNull()
    .unique()
    .references(() => organizations.id, { onDelete: "cascade" }),
  completions_rpm: integer("completions_rpm"),
  embeddings_rpm: integer("embeddings_rpm"),
  standard_rpm: integer("standard_rpm"),
  strict_rpm: integer("strict_rpm"),
  note: text("note"),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export type OrgRateLimitOverride = InferSelectModel<typeof orgRateLimitOverrides>;
export type NewOrgRateLimitOverride = InferInsertModel<typeof orgRateLimitOverrides>;
