CREATE TABLE "agent_connector_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"platform_credential_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"role" text NOT NULL,
	"purposes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_gate" text DEFAULT 'open' NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"oauth_mode" text DEFAULT 'eliza_managed' NOT NULL,
	"execution_target" text DEFAULT 'cloud_broker' NOT NULL,
	"selected_products" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"owner_binding_id" uuid,
	"owner_identity_id" text,
	"authorized_by_user_id" uuid NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "agent_connector_bindings_role_check" CHECK ("role" IN ('OWNER','AGENT','TEAM')),
	CONSTRAINT "agent_connector_bindings_status_check" CHECK ("status" IN ('connected','pending','disabled','revoked','error')),
	CONSTRAINT "agent_connector_bindings_oauth_mode_check" CHECK ("oauth_mode" IN ('eliza_managed','bring_your_own')),
	CONSTRAINT "agent_connector_bindings_execution_target_check" CHECK ("execution_target" IN ('cloud_broker','agent_host'))
);
--> statement-breakpoint
ALTER TABLE "agent_connector_bindings" ADD CONSTRAINT "agent_connector_bindings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_connector_bindings" ADD CONSTRAINT "agent_connector_bindings_agent_id_user_characters_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."user_characters"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_connector_bindings" ADD CONSTRAINT "agent_connector_bindings_platform_credential_id_platform_credentials_id_fk" FOREIGN KEY ("platform_credential_id") REFERENCES "public"."platform_credentials"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_connector_bindings" ADD CONSTRAINT "agent_connector_bindings_owner_binding_id_agent_connector_bindings_id_fk" FOREIGN KEY ("owner_binding_id") REFERENCES "public"."agent_connector_bindings"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_connector_bindings" ADD CONSTRAINT "agent_connector_bindings_authorized_by_user_id_users_id_fk" FOREIGN KEY ("authorized_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_agent_connector_bindings_org_agent_provider" ON "agent_connector_bindings" USING btree ("organization_id","agent_id","provider");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_connector_bindings_active_credential" ON "agent_connector_bindings" USING btree ("agent_id","provider","platform_credential_id") WHERE "agent_connector_bindings"."deleted_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_connector_bindings_default_role" ON "agent_connector_bindings" USING btree ("agent_id","provider","role") WHERE "agent_connector_bindings"."deleted_at" IS NULL AND "agent_connector_bindings"."is_default" = true;
--> statement-breakpoint
CREATE INDEX "idx_agent_connector_bindings_credential" ON "agent_connector_bindings" USING btree ("platform_credential_id");
