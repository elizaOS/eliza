CREATE TABLE "app_client_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"owner_organization_id" uuid NOT NULL,
	"billing_environment" text NOT NULL,
	"secret_hashes" jsonb NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"allowed_scopes" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_client_registrations_id_app_idx" UNIQUE("id","app_id"),
	CONSTRAINT "app_client_registrations_billing_environment_check" CHECK ("app_client_registrations"."billing_environment" IN ('test', 'live')),
	CONSTRAINT "app_client_registrations_revision_check" CHECK ("app_client_registrations"."revision" > 0)
);

--> statement-breakpoint
CREATE TABLE "app_delegations" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"authorization_code_hash" text NOT NULL,
	"client_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"consent_id" uuid NOT NULL,
	"organization_id" uuid,
	"registration_revision" integer NOT NULL,
	"scopes" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_delegations_authorization_code_hash_unique" UNIQUE("authorization_code_hash"),
	CONSTRAINT "app_delegations_digest_check" CHECK ("app_delegations"."token_hash" ~ '^[0-9a-f]{64}$' AND "app_delegations"."authorization_code_hash" ~ '^[0-9a-f]{64}$')
);

--> statement-breakpoint
ALTER TABLE "app_client_registrations" ADD CONSTRAINT "app_client_registrations_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_client_registrations" ADD CONSTRAINT "app_client_registrations_owner_organization_id_organizations_id_fk" FOREIGN KEY ("owner_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_delegations" ADD CONSTRAINT "app_delegations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_delegations" ADD CONSTRAINT "app_delegations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_delegations" ADD CONSTRAINT "app_delegations_client_app_fk" FOREIGN KEY ("client_id","app_id") REFERENCES "public"."app_client_registrations"("id","app_id") ON DELETE cascade ON UPDATE no action;
