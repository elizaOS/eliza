// Defines the PII scrub done-marker Drizzle table shape used by cloud repositories and services.
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Content-addressed done-markers for the CLOUD lane of the async PII scrub
 * rails (#14808).
 *
 * One row per completed scrub item, keyed by the SAME marker-key shape the
 * LOCAL lane uses (`packages/core/src/security/pii-scrub-markers.ts`):
 *
 *     pii:<sha256(content)>:v<rulesetVersion>
 *
 * so work never duplicates across lanes or across re-enqueued jobs. Two
 * properties the job runner relies on:
 *
 *   1. **Content-addressed idempotency.** The key derives only from the
 *      content bytes + ruleset version. Re-enqueuing the SAME content under
 *      the SAME ruleset resolves to the SAME row, so a re-scrub no-ops before
 *      any model call. Changed content (new sha) or a bumped ruleset (new
 *      `v<...>`) produces a new key and is re-scrubbed.
 *
 *   2. **Crash-and-rerun with zero cursor state.** Markers are durable DB
 *      rows written ONLY after an item's scrub fully succeeded. A worker that
 *      dies mid-batch loses only in-flight items; on re-claim the drain skips
 *      every marked item. There is no offset/cursor to corrupt.
 *
 * Markers are **tenant-scoped** (`organization_id` + key unique): one org's
 * scrub can never mark content done for another org, and the marker table
 * never leaks cross-tenant "has org X scrubbed content with hash H" signals.
 *
 * Rows intentionally NEVER store the scrubbed content or any raw span — that
 * would re-introduce the PII the scrub exists to remove (mirrors the LOCAL
 * marker doc). Fields beyond the key are audit metadata only.
 */
export const piiScrubMarkers = pgTable(
  "pii_scrub_markers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Full marker key `pii:<sha256(content)>:v<rulesetVersion>`. */
    marker_key: text("marker_key").notNull(),
    /** Hex sha256 of the exact content that was scrubbed. */
    content_hash: text("content_hash").notNull(),
    /** Ruleset version the scrub was performed under. */
    ruleset_version: text("ruleset_version").notNull(),
    /** Model id that served the escalation, or `"tier0"` when no model ran. */
    model_id: text("model_id").notNull(),
    /** True when tier-0 detectors fully covered the item (zero model calls). */
    tier0_only: boolean("tier0_only").notNull(),
    /** The `jobs` row that completed this item (audit; not a FK — jobs may be pruned). */
    job_id: uuid("job_id"),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    org_key_unique: uniqueIndex("pii_scrub_markers_org_key_idx").on(
      table.organization_id,
      table.marker_key,
    ),
    org_idx: index("pii_scrub_markers_org_idx").on(table.organization_id),
    org_ruleset_idx: index("pii_scrub_markers_org_ruleset_idx").on(
      table.organization_id,
      table.ruleset_version,
    ),
  }),
);

export type PiiScrubMarker = InferSelectModel<typeof piiScrubMarkers>;
export type NewPiiScrubMarker = InferInsertModel<typeof piiScrubMarkers>;
