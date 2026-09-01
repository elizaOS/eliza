CREATE UNIQUE INDEX IF NOT EXISTS "connector_accounts_agent_provider_external_role_uniq"
	ON "connector_accounts" USING btree ("agent_id", "provider", "external_id", "role")
	WHERE "deleted_at" IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "connector_accounts_agent_provider_external_uniq";
