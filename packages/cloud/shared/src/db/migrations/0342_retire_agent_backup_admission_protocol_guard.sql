-- Retires the writer fence until backup admission consumes the dedicated cursor authorities.

DROP TRIGGER IF EXISTS "agent_sandbox_backups_require_admission_protocol"
  ON "public"."agent_sandbox_backups";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."require_agent_backup_admission_protocol"();
