CREATE TABLE IF NOT EXISTS "agent_key_quorums" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" varchar(64) NOT NULL,
  "agent_id" varchar(64) NOT NULL,
  "name" varchar(255) NOT NULL,
  "threshold" integer NOT NULL,
  "member_signer_ids" text[] DEFAULT '{}' NOT NULL,
  "permissions" text[] DEFAULT '{}' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" varchar(32) DEFAULT 'active' NOT NULL,
  "created_by" varchar(255),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_key_quorums_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade,
  CONSTRAINT "agent_key_quorums_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "agent_key_quorums_tenant_agent_idx"
  ON "agent_key_quorums" ("tenant_id", "agent_id");

CREATE INDEX IF NOT EXISTS "agent_key_quorums_agent_status_idx"
  ON "agent_key_quorums" ("agent_id", "status");
