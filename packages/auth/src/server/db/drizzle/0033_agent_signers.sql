CREATE TABLE IF NOT EXISTS "agent_signers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" varchar(64) NOT NULL,
  "agent_id" varchar(64) NOT NULL,
  "signer_type" varchar(32) NOT NULL,
  "subject_type" varchar(32) NOT NULL,
  "subject_id" varchar(255) NOT NULL,
  "address" varchar(128),
  "chain_family" "chain_family",
  "label" varchar(255),
  "permissions" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" varchar(32) DEFAULT 'active' NOT NULL,
  "created_by" varchar(255),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_signers_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade,
  CONSTRAINT "agent_signers_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "agent_signers_tenant_agent_idx"
  ON "agent_signers" ("tenant_id", "agent_id");

CREATE INDEX IF NOT EXISTS "agent_signers_agent_status_idx"
  ON "agent_signers" ("agent_id", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "agent_signers_agent_subject_idx"
  ON "agent_signers" ("agent_id", "subject_type", "subject_id");
