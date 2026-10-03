-- A fresh OAuth reconnect installs a new revision-bound credential and can
-- therefore terminalize refresh attempts tied to the superseded credential.
ALTER TABLE "provider_google_credential_lifecycles"
  DROP CONSTRAINT "provider_google_lifecycle_state_check";
--> statement-breakpoint
ALTER TABLE "provider_google_credential_lifecycles"
  ADD CONSTRAINT "provider_google_lifecycle_state_check"
  CHECK ("state" IN ('inflight', 'credential_staged', 'revocation_pending', 'adopted', 'revoked', 'needs_attention', 'superseded'));
