-- Receipt and publication evidence is append-only, including direct TRUNCATE attempts.

DROP TRIGGER IF EXISTS "agent_activation_publications_immutable"
  ON "agent_activation_publications";
--> statement-breakpoint
CREATE TRIGGER "agent_activation_publications_immutable"
  BEFORE UPDATE OR DELETE ON "agent_activation_publications"
  FOR EACH ROW EXECUTE FUNCTION "reject_agent_restore_immutable_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_activation_publications_truncate_guard"
  ON "agent_activation_publications";
--> statement-breakpoint
CREATE TRIGGER "agent_activation_publications_truncate_guard"
  BEFORE TRUNCATE ON "agent_activation_publications"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_agent_restore_immutable_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_vault_key_seed_receipts_immutable"
  ON "agent_vault_key_seed_receipts";
--> statement-breakpoint
CREATE TRIGGER "agent_vault_key_seed_receipts_immutable"
  BEFORE UPDATE OR DELETE ON "agent_vault_key_seed_receipts"
  FOR EACH ROW EXECUTE FUNCTION "reject_agent_restore_immutable_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_vault_key_seed_receipts_truncate_guard"
  ON "agent_vault_key_seed_receipts";
--> statement-breakpoint
CREATE TRIGGER "agent_vault_key_seed_receipts_truncate_guard"
  BEFORE TRUNCATE ON "agent_vault_key_seed_receipts"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_agent_restore_immutable_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_receipts_immutable"
  ON "agent_backup_restore_receipts";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_receipts_immutable"
  BEFORE UPDATE OR DELETE ON "agent_backup_restore_receipts"
  FOR EACH ROW EXECUTE FUNCTION "reject_agent_restore_immutable_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_receipts_truncate_guard"
  ON "agent_backup_restore_receipts";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_receipts_truncate_guard"
  BEFORE TRUNCATE ON "agent_backup_restore_receipts"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_agent_restore_immutable_mutation"();
