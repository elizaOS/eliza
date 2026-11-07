-- Add rooms.connector_server_id: the drizzle rooms schema gained the column
-- ("persist native connector server ids") without a matching journal entry,
-- so every database migrated from this journal fails any whole-row rooms
-- select with "column connector_server_id does not exist" — breaking, among
-- others, POST /api/my-agents/claim-affiliate-characters, whose claim sweep
-- returns success:false on a healthy database. Nullable text, matching the
-- schema field `serverId`.
ALTER TABLE "rooms" ADD COLUMN "connector_server_id" text;
