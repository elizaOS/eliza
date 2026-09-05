-- Generated as a custom migration because the full schema diff currently fails
-- on existing BigInt defaults. Keep this new product's primary authority isolated.
CREATE TABLE IF NOT EXISTS "outreachr_delegations" (
  "token_hash" text PRIMARY KEY NOT NULL,
  "authorization_code_hash" text NOT NULL,
  "app_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "registration_digest" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "outreachr_delegations_authorization_code_hash_unique" UNIQUE("authorization_code_hash"),
  CONSTRAINT "outreachr_delegations_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE,
  CONSTRAINT "outreachr_delegations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "outreachr_delegations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreachr_delegations_expiry_idx"
  ON "outreachr_delegations" ("expires_at");
