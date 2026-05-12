-- Index for hot list queries: organization credit history ordered DESC by created_at.
CREATE INDEX IF NOT EXISTS "credit_transactions_org_created_desc_idx"
  ON "credit_transactions" USING btree ("organization_id", "created_at" DESC);
