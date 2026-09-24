-- #203: durably journal one-time Google OAuth credentials for recovery.
-- The Google profile admission itself shipped in 0097; this migration only
-- adds the encrypted-handle lifecycle table used by connect/refresh recovery.
CREATE TABLE "provider_google_credential_lifecycles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" varchar(64) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "provider_account_id" uuid,
  "kind" varchar(32) NOT NULL,
  "state" varchar(32) NOT NULL,
  "credential_secret_id" uuid,
  "expected_account_revision" integer,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error_code" varchar(64),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "provider_google_lifecycle_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "workspaces"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "provider_google_lifecycle_account_fk" FOREIGN KEY ("tenant_id", "workspace_id", "provider_account_id") REFERENCES "provider_accounts"("tenant_id", "workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "provider_google_lifecycle_secret_fk" FOREIGN KEY ("tenant_id", "credential_secret_id") REFERENCES "secrets"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "provider_google_lifecycle_kind_check" CHECK ("kind" IN ('connect_exchange', 'refresh_rotation')),
  CONSTRAINT "provider_google_lifecycle_state_check" CHECK ("state" IN ('inflight', 'credential_staged', 'revocation_pending', 'adopted', 'revoked', 'needs_attention'))
);
--> statement-breakpoint
CREATE INDEX "provider_google_lifecycle_account_state_idx" ON "provider_google_credential_lifecycles" ("tenant_id", "provider_account_id", "state");
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_google_lifecycle_active_refresh_idx"
  ON "provider_google_credential_lifecycles" ("tenant_id", "provider_account_id")
  WHERE "kind" = 'refresh_rotation' AND "state" IN ('inflight', 'credential_staged');
