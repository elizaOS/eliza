-- Cloud schema/journal drift: the agent_identities drizzle schema (ERC-8004
-- agent identity registry) declares the table and its indexes, but no journal
-- entry created it, so journal-migrated databases (CI lanes, staging,
-- production) have no such relation. DDL matches the declared drizzle shape.
CREATE TABLE "agent_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sandbox_agent_id" uuid NOT NULL,
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
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_sandbox_agent_id_agent_sandboxes_id_fk" FOREIGN KEY ("sandbox_agent_id") REFERENCES "public"."agent_sandboxes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_identities_sandbox_idx" ON "agent_identities" USING btree ("sandbox_agent_id");
--> statement-breakpoint
CREATE INDEX "agent_identities_organization_idx" ON "agent_identities" USING btree ("organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_identities_chain_registry_token_unique" ON "agent_identities" USING btree ("chain_id","registry_address","token_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_identities_sandbox_standard_chain_unique" ON "agent_identities" USING btree ("sandbox_agent_id","standard","chain_id");
