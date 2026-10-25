-- #20732: the restore coordinator carries a restore past quarantine creation.
-- Each post-create phase records write-once evidence (private roots, sealed
-- candidate, committed generation, previous route, serving ports, signed
-- attestation and probes) so a lost response replays instead of re-executing.
-- The route publication time is the single point after which rollback no
-- longer restores the previous runtime.
ALTER TABLE "agent_backup_restore_operations" ADD COLUMN IF NOT EXISTS "serving_state" jsonb;
--> statement-breakpoint
ALTER TABLE "agent_backup_restore_operations" ADD COLUMN IF NOT EXISTS "route_published_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_backup_restore_operations" DROP CONSTRAINT IF EXISTS "agent_backup_restore_operations_serving_state_check";
--> statement-breakpoint
ALTER TABLE "agent_backup_restore_operations" ADD CONSTRAINT "agent_backup_restore_operations_serving_state_check"
  CHECK ((
    ("serving_state" IS NULL OR jsonb_typeof("serving_state") = 'object')
    AND ("route_published_at" IS NULL
      OR "phase" IN ('published', 'finalized', 'failed_retryable', 'failed_terminal'))
  ) IS TRUE);
