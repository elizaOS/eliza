-- Separates user-controlled Discord configuration concurrency from heartbeat,
-- status, assignment, and event-count telemetry written to the same row.

ALTER TABLE "discord_connections"
  ADD COLUMN IF NOT EXISTS "configuration_revision" numeric DEFAULT 0 NOT NULL;

ALTER TABLE "discord_connections"
  ALTER COLUMN "configuration_revision"
  TYPE numeric USING "configuration_revision"::numeric;
