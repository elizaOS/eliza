CREATE TABLE "provider_x_credential_lifecycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"state" varchar(32) NOT NULL,
	"credential_secret_id" uuid,
	"expected_account_revision" integer NOT NULL,
	"last_error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_x_lifecycle_state_check" CHECK ("state" IN ('inflight', 'credential_staged', 'revocation_pending', 'adopted', 'revoked', 'needs_attention', 'superseded')),
	CONSTRAINT "provider_x_lifecycle_revision_check" CHECK ("expected_account_revision" >= 1),
	CONSTRAINT "provider_x_lifecycle_secret_state_check" CHECK (("state" = 'inflight' AND "credential_secret_id" IS NULL) OR ("state" IN ('credential_staged', 'revocation_pending') AND "credential_secret_id" IS NOT NULL) OR "state" = 'needs_attention' OR ("state" IN ('adopted', 'revoked', 'superseded') AND "credential_secret_id" IS NULL)),
	CONSTRAINT "provider_x_lifecycle_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "workspaces"("tenant_id", "id") ON DELETE cascade,
	CONSTRAINT "provider_x_lifecycle_account_fk" FOREIGN KEY ("tenant_id", "workspace_id", "provider_account_id") REFERENCES "provider_accounts"("tenant_id", "workspace_id", "id") ON DELETE cascade,
	CONSTRAINT "provider_x_lifecycle_secret_fk" FOREIGN KEY ("tenant_id", "credential_secret_id") REFERENCES "secrets"("tenant_id", "id") ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX "provider_x_lifecycle_account_state_idx" ON "provider_x_credential_lifecycles" USING btree ("tenant_id", "provider_account_id", "state");
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_x_lifecycle_active_refresh_idx" ON "provider_x_credential_lifecycles" USING btree ("tenant_id", "provider_account_id") WHERE "state" IN ('inflight', 'credential_staged', 'revocation_pending', 'needs_attention');
