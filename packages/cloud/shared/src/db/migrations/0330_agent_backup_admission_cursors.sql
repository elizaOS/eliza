-- Adds durable fairness cursors to the existing backup tenant and source-node authorities.

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "backup_admission_cursor_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "docker_nodes"
  ADD COLUMN IF NOT EXISTS "backup_admission_cursor_at" timestamp with time zone;
