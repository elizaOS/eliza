CREATE TABLE "connector_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"account_key" text NOT NULL,
	"external_id" text,
	"display_name" text,
	"username" text,
	"email" text,
	"role" text DEFAULT 'OWNER' NOT NULL,
	"purpose" jsonb DEFAULT '["messaging"]'::jsonb NOT NULL,
	"access_gate" text DEFAULT 'open' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sync_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_account_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"credential_type" text NOT NULL,
	"vault_ref" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_account_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"agent_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_flows" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"account_id" uuid,
	"redirect_uri" text,
	"code_verifier_ref" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by" text
);
--> statement-breakpoint
ALTER TABLE "connector_accounts" ADD CONSTRAINT "connector_accounts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_account_credentials" ADD CONSTRAINT "connector_account_credentials_account_id_connector_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connector_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_account_credentials" ADD CONSTRAINT "connector_account_credentials_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_account_audit_events" ADD CONSTRAINT "connector_account_audit_events_account_id_connector_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connector_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_account_audit_events" ADD CONSTRAINT "connector_account_audit_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_flows" ADD CONSTRAINT "oauth_flows_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_flows" ADD CONSTRAINT "oauth_flows_account_id_connector_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connector_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_accounts_agent_provider_account_key_uniq" ON "connector_accounts" USING btree ("agent_id","provider","account_key");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_accounts_agent_provider_external_uniq" ON "connector_accounts" USING btree ("agent_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "connector_accounts_agent_provider_idx" ON "connector_accounts" USING btree ("agent_id","provider");--> statement-breakpoint
CREATE INDEX "connector_accounts_status_idx" ON "connector_accounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "connector_accounts_updated_idx" ON "connector_accounts" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_account_credentials_account_type_uniq" ON "connector_account_credentials" USING btree ("account_id","credential_type");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_account_credentials_agent_provider_ref_uniq" ON "connector_account_credentials" USING btree ("agent_id","provider","vault_ref");--> statement-breakpoint
CREATE INDEX "connector_account_credentials_agent_provider_idx" ON "connector_account_credentials" USING btree ("agent_id","provider");--> statement-breakpoint
CREATE INDEX "connector_account_credentials_expires_idx" ON "connector_account_credentials" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "connector_account_audit_agent_provider_idx" ON "connector_account_audit_events" USING btree ("agent_id","provider");--> statement-breakpoint
CREATE INDEX "connector_account_audit_account_idx" ON "connector_account_audit_events" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "connector_account_audit_action_idx" ON "connector_account_audit_events" USING btree ("action");--> statement-breakpoint
CREATE INDEX "connector_account_audit_created_idx" ON "connector_account_audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "oauth_flows_agent_provider_idx" ON "oauth_flows" USING btree ("agent_id","provider");--> statement-breakpoint
CREATE INDEX "oauth_flows_account_idx" ON "oauth_flows" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "oauth_flows_expires_idx" ON "oauth_flows" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_flows_consumed_idx" ON "oauth_flows" USING btree ("consumed_at");
