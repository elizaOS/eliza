-- Index for hot list queries: org timeline ordered DESC by created_at.
-- Existing usage_records_org_created_idx is ASC and is not used by ORDER BY ... DESC scans.
CREATE INDEX IF NOT EXISTS "usage_records_org_created_desc_idx"
  ON "usage_records" USING btree ("organization_id", "created_at" DESC);
