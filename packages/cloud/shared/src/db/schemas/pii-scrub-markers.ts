// Defines the PII scrub done-marker Drizzle table shape used by cloud repositories and services.
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Content-addressed done-markers for the CLOUD lane of the async PII scrub
 * rails (#14808).
 *
 * Full-content inspection uses `pii:<sha256(content)>:v<rulesetVersion>`.
 * Declared-candidate inspection appends `:declared:<sha256(inputs)>`, binding
 * the exact candidate list and context without retaining their raw PII.
 *
 *   1. **Inspection-bound idempotency.** Re-enqueuing the same content,
 *      ruleset, and declared inputs resumes the same work. New candidates or
 *      context require a new partial inspection; a full-content inspection
 *      can satisfy a declared-candidate request for that content/ruleset.
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
 *
 * A marker is an INSPECTION record, never a release authorization: it says a
 * job under `inspection_scope` processed the content without structural
 * failure. `declared_candidates` only judged caller-supplied candidate spans;
 * `server_discovery` required server-side discovery over the full content. A
 * weaker marker never satisfies a stronger job (one row per scope).
 */
export const PII_SCRUB_INSPECTION_SCOPES = ["declared_candidates", "server_discovery"] as const;
export type PiiScrubInspectionScope = (typeof PII_SCRUB_INSPECTION_SCOPES)[number];

export const piiScrubMarkers = pgTable(
  "pii_scrub_markers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Content/ruleset key, plus hashed declaration inputs for partial inspection. */
    marker_key: text("marker_key").notNull(),
    /** Hex sha256 of the exact content that was scrubbed. */
    content_hash: text("content_hash").notNull(),
    /** Ruleset version the scrub was performed under. */
    ruleset_version: text("ruleset_version").notNull(),
    /** Model id that served the escalation, or `"tier0"` when no model ran. */
    model_id: text("model_id").notNull(),
    /** True when tier-0 detectors fully covered the item (zero model calls). */
    tier0_only: boolean("tier0_only").notNull(),
    /** How thoroughly the content was inspected (see table doc). */
    inspection_scope: text("inspection_scope")
      .$type<PiiScrubInspectionScope>()
      .notNull()
      .default("declared_candidates"),
    /** Caller-declared candidate spans the item carried (observability). */
    candidate_count: integer("candidate_count").notNull().default(0),
    /** The `jobs` row that completed this item (audit; not a FK — jobs may be pruned). */
    job_id: uuid("job_id"),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    org_key_scope_unique: uniqueIndex("pii_scrub_markers_org_key_scope_idx").on(
      table.organization_id,
      table.marker_key,
      table.inspection_scope,
    ),
    inspection_scope_check: check(
      "pii_scrub_markers_inspection_scope_check",
      sql`${table.inspection_scope} IN ('declared_candidates', 'server_discovery')`,
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
