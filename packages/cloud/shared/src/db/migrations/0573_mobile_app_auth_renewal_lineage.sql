-- Key renewal records its lineage so a renewed mobile credential cannot
-- outlive the revocation of the credential it came from.
-- session_id names the owner's sign-in; every renewal grant copies it.
-- renewed_from_credential_id is the credential that asked for the renewal;
-- exchange and acknowledgement re-read it and refuse once it is not active.
-- Both nullable: a sign-in grant has no predecessor, and a grant issued before
-- these columns is its own session until its first renewal stamps it.
ALTER TABLE "mobile_app_auth_grants"
  ADD COLUMN IF NOT EXISTS "session_id" uuid,
  ADD COLUMN IF NOT EXISTS "renewed_from_credential_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mobile_app_auth_grants_session"
  ON "mobile_app_auth_grants" ("session_id")
  WHERE "session_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mobile_app_auth_grants_renewed_from"
  ON "mobile_app_auth_grants" ("renewed_from_credential_id")
  WHERE "renewed_from_credential_id" IS NOT NULL;
