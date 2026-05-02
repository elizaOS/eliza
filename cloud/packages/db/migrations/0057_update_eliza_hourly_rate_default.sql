-- Update eliza_sandboxes hourly_rate default from $0.02 to $0.01.
-- Applies the new rate to any sandboxes created after this migration.
-- Existing rows keep their stored rate; the cron will record the live
-- rate on each billing cycle via the hourly_rate column.

ALTER TABLE "eliza_sandboxes"
  ALTER COLUMN "hourly_rate" SET DEFAULT '0.0100';
