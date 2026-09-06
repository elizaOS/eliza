-- Tamper-evident audit log: per-tenant HMAC chain.
--
-- Every write inserts the next event in the chain for its tenant_id. The hmac
-- column commits to the canonical encoding of the event PLUS the previous
-- row's hmac, so any mutation/deletion of historical rows breaks verification.
--
-- The HMAC key (STEWARD_AUDIT_HMAC_KEY) is held in app config separately from
-- DB credentials, so an attacker with DB-only write access cannot forge rows
-- that pass verification. See packages/api/src/services/audit.ts.
--
-- Concurrency: writers take a per-tenant pg_advisory_xact_lock to serialize
-- chain extensions for a given tenant. Cross-tenant writes do not contend.

CREATE TABLE IF NOT EXISTS "audit_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "tenant_id" varchar(64) NOT NULL,
  "seq" bigint NOT NULL,
  "prev_hash" bytea NOT NULL,
  "hmac" bytea NOT NULL,
  "actor_type" varchar(32) NOT NULL,
  "actor_id" varchar(255),
  "action" varchar(128) NOT NULL,
  "resource_type" varchar(64),
  "resource_id" varchar(255),
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "request_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "audit_events_tenant_seq_idx" ON "audit_events" USING btree ("tenant_id","seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_tenant_created_idx" ON "audit_events" USING btree ("tenant_id","created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_action_idx" ON "audit_events" USING btree ("action");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_actor_idx" ON "audit_events" USING btree ("actor_type","actor_id");
