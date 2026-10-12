-- Room connector server id: the plugin-sql rooms schema gained
-- connector_server_id (rooms.serverId) so a room can preserve the native
-- connector server id for room authorization, and the cloud rooms
-- repository selects and inserts that column through the shared table.
-- Cloud databases are provisioned only by this migration ledger, so the
-- column must be added here as well; without it every rooms read fails
-- with 42703 (column "connector_server_id" does not exist).
-- Additive: existing rooms keep NULL (no persisted connector server id).
ALTER TABLE "rooms" ADD COLUMN IF NOT EXISTS "connector_server_id" text;
