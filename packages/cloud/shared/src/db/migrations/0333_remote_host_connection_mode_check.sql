-- Revoke unsupported live connection modes before enforcing the v1 relay-only
-- contract. Revoked rows retain their historical mode for audit.

UPDATE "remote_hosts"
SET
  "status" = 'revoked',
  "revoked_at" = COALESCE("revoked_at", NOW()),
  "updated_at" = NOW()
WHERE "connection_mode" <> 'relay';

--> statement-breakpoint
UPDATE "remote_sessions"
SET
  "status" = 'revoked',
  "pairing_token_hash" = NULL,
  "ended_at" = NOW(),
  "updated_at" = NOW()
WHERE "host_id" IN (
  SELECT "id" FROM "remote_hosts" WHERE "connection_mode" <> 'relay'
)
AND "status" IN ('pending', 'claimed', 'activating', 'active');

--> statement-breakpoint
UPDATE "remote_command_envelopes"
SET
  "status" = 'cancelled',
  "claim_token" = NULL,
  "claim_expires_at" = NULL,
  "terminal_at" = NOW(),
  "updated_at" = NOW()
WHERE "host_id" IN (
  SELECT "id" FROM "remote_hosts" WHERE "connection_mode" <> 'relay'
)
AND "status" IN ('pending', 'claimed');

--> statement-breakpoint
UPDATE "remote_command_envelopes"
SET
  "status" = 'execution_ambiguous',
  "terminal_at" = NOW(),
  "updated_at" = NOW()
WHERE "host_id" IN (
  SELECT "id" FROM "remote_hosts" WHERE "connection_mode" <> 'relay'
)
AND "status" = 'started';

--> statement-breakpoint
ALTER TABLE "remote_hosts"
  DROP CONSTRAINT IF EXISTS "remote_hosts_connection_mode_check";
--> statement-breakpoint
ALTER TABLE "remote_hosts"
  ADD CONSTRAINT "remote_hosts_connection_mode_check"
  CHECK ("connection_mode" = 'relay' OR "status" = 'revoked');
