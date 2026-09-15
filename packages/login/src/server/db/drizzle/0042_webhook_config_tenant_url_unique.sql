CREATE UNIQUE INDEX IF NOT EXISTS "webhook_configs_tenant_url_idx"
ON "webhook_configs" USING btree ("tenant_id", "url");
