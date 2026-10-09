-- Align raw-SQL-backed ERC-8004 and policy-template tables with Drizzle schema.
-- Tables are created in 0013/0014; this migration adds named indexes and FKs
-- without rewriting those historical migrations.

ALTER TABLE "agent_registrations" ALTER COLUMN "tenant_id" TYPE varchar(64);
ALTER TABLE "agent_registrations" ALTER COLUMN "agent_id" TYPE varchar(64);
ALTER TABLE "reputation_cache" ALTER COLUMN "agent_id" TYPE varchar(64);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_registrations_tenant_agent_chain_idx"
  ON "agent_registrations" ("tenant_id", "agent_id", "chain_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_registrations_tenant_idx"
  ON "agent_registrations" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_registrations_agent_idx"
  ON "agent_registrations" ("agent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reputation_cache_agent_chain_idx"
  ON "reputation_cache" ("agent_id", "chain_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reputation_cache_agent_idx"
  ON "reputation_cache" ("agent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "registry_index_chain_id_idx"
  ON "registry_index" ("chain_id");
--> statement-breakpoint
ALTER TABLE "agent_registrations"
  ADD CONSTRAINT "agent_registrations_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "agent_registrations"
  ADD CONSTRAINT "agent_registrations_agent_id_agents_id_fk"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "reputation_cache"
  ADD CONSTRAINT "reputation_cache_agent_id_agents_id_fk"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;
