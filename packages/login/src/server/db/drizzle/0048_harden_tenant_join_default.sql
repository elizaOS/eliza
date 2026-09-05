-- Tenants must not be publicly self-joinable by default (PR #79 hardening).
-- The schema default is already 'invite'; this also backfills any legacy rows
-- that were created 'open' before the default flipped. Idempotent.
ALTER TABLE tenant_configs ALTER COLUMN join_mode SET DEFAULT 'invite';
--> statement-breakpoint
UPDATE tenant_configs SET join_mode = 'invite' WHERE join_mode = 'open';
