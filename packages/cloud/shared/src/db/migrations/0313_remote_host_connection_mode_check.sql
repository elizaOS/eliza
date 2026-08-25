-- Make the remote-host connection-mode allowlist honest in storage. Rows
-- enrolled before the endpoint validator could carry any free-form mode, so
-- first fail closed: every non-relay row is revoked (audit history retained,
-- current capability removed), then the constraint pins active rows to relay.
-- Revoked rows may keep their legacy mode value for audit.

UPDATE "remote_hosts"
SET
  "status" = 'revoked',
  "revoked_at" = COALESCE("revoked_at", NOW()),
  "updated_at" = NOW()
WHERE
  "connection_mode" <> 'relay';

--> statement-breakpoint
ALTER TABLE "remote_hosts"
  DROP CONSTRAINT IF EXISTS "remote_hosts_connection_mode_check";
--> statement-breakpoint
ALTER TABLE "remote_hosts"
  ADD CONSTRAINT "remote_hosts_connection_mode_check"
  CHECK ("connection_mode" = 'relay' OR "status" = 'revoked');
