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
	CONSTRAINT "agent_connector_bindings_status_check" CHECK ("status" IN ('connected','pending','disabled','revoked','error'))
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
--> statement-breakpoint
-- Existing personal Google credentials can be bound automatically only when
-- the organization has exactly one agent. Multi-agent organizations must grant
-- access explicitly in the agent Connectors UI so migration cannot broaden a
-- user's credential to an unintended agent.
WITH "sole_agents" AS (
	SELECT "organization_id", (array_agg("id" ORDER BY "id"))[1] AS "agent_id"
	FROM "user_characters"
	GROUP BY "organization_id"
	HAVING count(*) = 1
), "eligible_google_credentials" AS (
	SELECT
		"credential".*,
		"sole_agents"."agent_id",
		row_number() OVER (
			PARTITION BY "sole_agents"."agent_id"
			ORDER BY "credential"."linked_at" NULLS LAST, "credential"."id"
		) AS "default_rank",
		coalesce("credential"."scopes", '[]'::jsonb) AS "effective_scopes"
	FROM "platform_credentials" AS "credential"
	INNER JOIN "sole_agents"
		ON "sole_agents"."organization_id" = "credential"."organization_id"
	WHERE "credential"."platform"::text = 'google'
		AND "credential"."status"::text = 'active'
		AND "credential"."user_id" IS NOT NULL
), "projected_google_bindings" AS (
	SELECT
		"credential".*,
		array_remove(ARRAY[
			CASE WHEN "effective_scopes" ?| ARRAY[
				'https://www.googleapis.com/auth/gmail.readonly',
				'https://www.googleapis.com/auth/gmail.modify',
				'https://www.googleapis.com/auth/gmail.compose',
				'https://mail.google.com/'
			] THEN 'gmail' END,
			CASE WHEN "effective_scopes" ?| ARRAY[
				'https://www.googleapis.com/auth/calendar.readonly',
				'https://www.googleapis.com/auth/calendar.events.readonly',
				'https://www.googleapis.com/auth/calendar.events',
				'https://www.googleapis.com/auth/calendar'
			] THEN 'calendar' END
		], NULL) AS "selected_products",
		array_remove(ARRAY[
			CASE WHEN "effective_scopes" ?| ARRAY[
				'https://www.googleapis.com/auth/gmail.readonly',
				'https://www.googleapis.com/auth/gmail.modify',
				'https://mail.google.com/'
			] THEN 'gmail.read' END,
			CASE WHEN "effective_scopes" ?| ARRAY[
				'https://www.googleapis.com/auth/gmail.modify',
				'https://mail.google.com/'
			] THEN 'gmail.manage' END,
			CASE WHEN "effective_scopes" ?| ARRAY[
				'https://www.googleapis.com/auth/gmail.compose',
				'https://www.googleapis.com/auth/gmail.modify',
				'https://mail.google.com/'
			] THEN 'gmail.draft' END,
			CASE WHEN "effective_scopes" ?| ARRAY[
				'https://www.googleapis.com/auth/calendar.readonly',
				'https://www.googleapis.com/auth/calendar.events.readonly',
				'https://www.googleapis.com/auth/calendar.events',
				'https://www.googleapis.com/auth/calendar'
			] THEN 'calendar.read' END
		], NULL) AS "allowed_capabilities"
	FROM "eligible_google_credentials" AS "credential"
)
INSERT INTO "agent_connector_bindings" (
	"organization_id",
	"agent_id",
	"platform_credential_id",
	"provider",
	"role",
	"purposes",
	"access_gate",
	"status",
	"selected_products",
	"allowed_capabilities",
	"is_default",
	"owner_identity_id",
	"authorized_by_user_id",
	"metadata"
)
SELECT
	"organization_id",
	"agent_id",
	"id",
	'google',
	'OWNER',
	'["automation", "calendar", "messaging"]'::jsonb,
	'owner_binding',
	'connected',
	to_jsonb("selected_products"),
	to_jsonb("allowed_capabilities"),
	"default_rank" = 1,
	"platform_user_id",
	"user_id",
	'{"migration":"0195-single-agent-google"}'::jsonb
FROM "projected_google_bindings"
WHERE cardinality("selected_products") > 0;
