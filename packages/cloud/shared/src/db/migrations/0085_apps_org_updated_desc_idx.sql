-- Index for hot list queries: org apps list ordered DESC by updated_at.
CREATE INDEX IF NOT EXISTS "apps_org_updated_desc_idx"
  ON "apps" USING btree ("organization_id", "updated_at" DESC);
