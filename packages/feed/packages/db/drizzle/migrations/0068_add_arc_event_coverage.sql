-- Migration: Add arc_event_coverage table for DB-backed arc event dedup
-- Replaces in-memory NewsArticlePacingEngine.arcEventCoverage map so
-- duplicate-article prevention survives server restarts and cold starts.

CREATE TABLE IF NOT EXISTS "arc_event_coverage" (
  "id" serial PRIMARY KEY NOT NULL,
  "event_id" text NOT NULL,
  "org_id" text NOT NULL,
  "status" text NOT NULL,
  "article_id" text,
  "covered_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "arc_coverage_event_org_status" ON "arc_event_coverage" ("event_id", "org_id", "status");
CREATE INDEX IF NOT EXISTS "arc_coverage_event_status_idx" ON "arc_event_coverage" ("event_id", "status");
CREATE INDEX IF NOT EXISTS "arc_coverage_covered_at_idx" ON "arc_event_coverage" ("covered_at");
