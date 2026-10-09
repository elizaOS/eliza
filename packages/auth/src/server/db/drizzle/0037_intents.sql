CREATE TABLE IF NOT EXISTS "intents" (
  "id" varchar(64) PRIMARY KEY NOT NULL,
  "tenant_id" varchar(64) NOT NULL,
  "agent_id" varchar(64),
  "intent_type" varchar(64) NOT NULL,
  "status" varchar(32) NOT NULL DEFAULT 'pending',
  "resource_type" varchar(64),
  "resource_id" varchar(255),
  "created_by_type" varchar(32) NOT NULL DEFAULT 'api',
  "created_by_id" varchar(255),
  "created_by_display_name" varchar(255),
  "authorization_details" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "execution_result" jsonb,
  "expires_at" timestamp with time zone,
  "authorized_by" varchar(255),
  "canceled_at" timestamp with time zone,
  "canceled_by" varchar(255),
  "cancellation_reason" text,
  "expired_at" timestamp with time zone,
  "expired_by" varchar(255),
  "rejected_at" timestamp with time zone,
  "rejected_by" varchar(255),
  "rejection_reason" text,
  "executed_by" varchar(255),
  "failed_at" timestamp with time zone,
  "failed_by" varchar(255),
  "failure_reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "authorized_at" timestamp with time zone,
  "executed_at" timestamp with time zone,
  CONSTRAINT "intents_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade,
  CONSTRAINT "intents_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "intents_tenant_status_idx"
  ON "intents" ("tenant_id", "status");

CREATE INDEX IF NOT EXISTS "intents_tenant_created_idx"
  ON "intents" ("tenant_id", "created_at");

CREATE INDEX IF NOT EXISTS "intents_agent_idx"
  ON "intents" ("agent_id");

CREATE INDEX IF NOT EXISTS "intents_resource_idx"
  ON "intents" ("resource_type", "resource_id");
