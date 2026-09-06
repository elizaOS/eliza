-- Persist the cloud-owned identity records consumed by the agent identity API.
CREATE TABLE IF NOT EXISTS "agent_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL CONSTRAINT "agent_identities_organization_id_organizations_id_fk" REFERENCES "organizations"("id") ON DELETE CASCADE,
  "sandbox_agent_id" uuid NOT NULL CONSTRAINT "agent_identities_sandbox_agent_id_agent_sandboxes_id_fk" REFERENCES "agent_sandboxes"("id") ON DELETE CASCADE,
  "standard" text DEFAULT 'erc-8004' NOT NULL,
  "chain_id" integer NOT NULL,
  "registry_address" text NOT NULL,
  "token_id" text NOT NULL,
  "agent_uri" text NOT NULL,
  "uri_ipfs" text,
  "owner_wallet_address" text NOT NULL,
  "tx_hash" text NOT NULL,
  "block_number" text,
  "status" text DEFAULT 'confirmed' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_identities_sandbox_idx"
  ON "agent_identities" ("sandbox_agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_identities_organization_idx"
  ON "agent_identities" ("organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_identities_chain_registry_token_unique"
  ON "agent_identities" ("chain_id", "registry_address", "token_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_identities_sandbox_standard_chain_unique"
  ON "agent_identities" ("sandbox_agent_id", "standard", "chain_id");
