-- Persist app -> tenant DB cluster placement so deploy retries reuse the
-- cluster slot claimed for the app instead of incrementing capacity again.
ALTER TABLE "app_databases"
  ADD COLUMN IF NOT EXISTS "tenant_db_cluster_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "app_databases"
    ADD CONSTRAINT "app_databases_tenant_db_cluster_id_tenant_db_clusters_id_fk"
    FOREIGN KEY ("tenant_db_cluster_id")
    REFERENCES "public"."tenant_db_clusters"("id")
    ON DELETE set null
    ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_databases_tenant_db_cluster_idx"
  ON "app_databases" USING btree ("tenant_db_cluster_id");
