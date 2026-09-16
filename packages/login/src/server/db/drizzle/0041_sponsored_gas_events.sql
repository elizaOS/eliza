CREATE TABLE IF NOT EXISTS "sponsored_gas_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" varchar(64) NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "agent_id" varchar(64) NOT NULL REFERENCES "agents"("id") ON DELETE cascade,
  "user_id" uuid,
  "tx_id" varchar(64) REFERENCES "transactions"("id") ON DELETE set null,
  "chain_family" "chain_family" DEFAULT 'evm' NOT NULL,
  "chain_id" integer,
  "caip2" varchar(64),
  "provider" varchar(64) NOT NULL,
  "mode" varchar(64) NOT NULL,
  "status" varchar(32) DEFAULT 'reserved' NOT NULL,
  "user_operation_hash" varchar(128),
  "tx_hash" varchar(128),
  "signature" varchar(128),
  "reserved_usd" numeric(18, 6),
  "actual_usd" numeric(18, 6),
  "gas_units" text,
  "gas_token" varchar(64),
  "request_hash" varchar(128),
  "error" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "sponsored_gas_events_tenant_created_idx"
  ON "sponsored_gas_events" ("tenant_id", "created_at");

CREATE INDEX IF NOT EXISTS "sponsored_gas_events_agent_created_idx"
  ON "sponsored_gas_events" ("agent_id", "created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "sponsored_gas_events_tenant_tx_id_idx"
  ON "sponsored_gas_events" ("tenant_id", "tx_id")
  WHERE "tx_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "agents_tenant_id_id_idx"
  ON "agents" ("tenant_id", "id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sponsored_gas_events_tenant_agent_fk'
  ) THEN
    ALTER TABLE "sponsored_gas_events"
      ADD CONSTRAINT "sponsored_gas_events_tenant_agent_fk"
      FOREIGN KEY ("tenant_id", "agent_id")
      REFERENCES "agents"("tenant_id", "id")
      ON DELETE cascade;
  END IF;
END $$;
