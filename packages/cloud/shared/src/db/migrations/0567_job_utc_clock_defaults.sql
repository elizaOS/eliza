-- These columns store UTC without an offset. Change only future defaults;
-- historical timestamps do not carry enough evidence to reinterpret safely.
ALTER TABLE jobs
  ALTER COLUMN scheduled_for SET DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
  ALTER COLUMN created_at SET DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
  ALTER COLUMN updated_at SET DEFAULT (clock_timestamp() AT TIME ZONE 'UTC');
--> statement-breakpoint
ALTER TABLE job_execution_leases
  ALTER COLUMN heartbeat_at SET DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
  ALTER COLUMN created_at SET DEFAULT (clock_timestamp() AT TIME ZONE 'UTC');
