CREATE TABLE "mobile_mail_leases" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL UNIQUE,
  "credential_id" uuid NOT NULL REFERENCES "api_keys"("id") ON DELETE CASCADE,
  "refresh_hash" text NOT NULL UNIQUE,
  "access_hash" text UNIQUE,
  "access_expires_at" timestamptz,
  "idle_expires_at" timestamptz NOT NULL,
  "initial_delivery" jsonb,
  "offered_refresh_hash" text UNIQUE,
  "offered_access_hash" text UNIQUE,
  "offered_access_expires_at" timestamptz,
  "offered_delivery" jsonb,
  "revoked_at" timestamptz,
  CONSTRAINT "mobile_mail_leases_access_complete" CHECK (
    ("access_hash" IS NULL) = ("access_expires_at" IS NULL)
  ),
  CONSTRAINT "mobile_mail_leases_offer_complete" CHECK (
    num_nonnulls("offered_refresh_hash", "offered_access_hash", "offered_access_expires_at", "offered_delivery") IN (0, 4)
  )
);
--> statement-breakpoint
CREATE INDEX "mobile_mail_leases_credential_idx" ON "mobile_mail_leases" ("credential_id");
--> statement-breakpoint
CREATE TABLE "spent_mobile_mail_refreshes" (
  "refresh_hash" text PRIMARY KEY,
  "lease_id" uuid NOT NULL REFERENCES "mobile_mail_leases"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "spent_mobile_mail_refreshes_lease_idx" ON "spent_mobile_mail_refreshes" ("lease_id");
--> statement-breakpoint
ALTER TABLE "mobile_app_auth_grants" ADD COLUMN "renewal_mail_lease_id" uuid;
