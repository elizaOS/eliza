ALTER TABLE "pii_scrub_markers"
  ADD COLUMN IF NOT EXISTS "inspection_scope" text DEFAULT 'declared_candidates' NOT NULL;
--> statement-breakpoint
ALTER TABLE "pii_scrub_markers"
  ADD COLUMN IF NOT EXISTS "candidate_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "pii_scrub_markers"
  DROP CONSTRAINT IF EXISTS "pii_scrub_markers_inspection_scope_check";
--> statement-breakpoint
ALTER TABLE "pii_scrub_markers"
  ADD CONSTRAINT "pii_scrub_markers_inspection_scope_check"
  CHECK ("inspection_scope" IN ('declared_candidates', 'server_discovery'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pii_scrub_markers_org_key_scope_idx"
  ON "pii_scrub_markers" ("organization_id", "marker_key", "inspection_scope");
--> statement-breakpoint
DROP INDEX IF EXISTS "pii_scrub_markers_org_key_idx";
