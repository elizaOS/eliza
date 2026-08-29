-- Seed transport receipts are attempt-scoped from V1 onward. Preserve legacy
-- append-only rows as NULL, but require every new row to name the exact durable
-- replacement intent whose ID is bound into the receipt digest.

ALTER TABLE "agent_sandbox_replacement_attempts"
  ADD CONSTRAINT "agent_sandbox_replacement_attempts_seed_authority_unique"
  UNIQUE ("id", "organization_id", "agent_id", "restore_attempt_id");
--> statement-breakpoint
ALTER TABLE "agent_vault_key_seed_receipts"
  ADD COLUMN "replacement_attempt_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_vault_key_seed_receipts"
  DROP CONSTRAINT "agent_vault_key_seed_receipts_attempt_unique",
  ADD CONSTRAINT "agent_vault_key_seed_receipts_attempt_unique" UNIQUE
    ("organization_id", "restore_attempt_id", "replacement_attempt_id"),
  ADD CONSTRAINT "agent_vault_key_seed_receipts_replacement_authority_fkey"
    FOREIGN KEY (
      "replacement_attempt_id", "organization_id", "agent_id", "restore_attempt_id"
    ) REFERENCES "agent_sandbox_replacement_attempts"
      ("id", "organization_id", "agent_id", "restore_attempt_id")
    ON DELETE RESTRICT;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_vault_key_seed_receipt_replacement_attempt"()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF NEW."replacement_attempt_id" IS NULL THEN
    RAISE EXCEPTION 'new vault seed receipt requires exact replacement attempt authority';
  END IF;
  RETURN NEW;
END;
$guard$;
--> statement-breakpoint
CREATE TRIGGER "agent_vault_key_seed_receipts_guard_replacement_attempt"
  BEFORE INSERT ON "agent_vault_key_seed_receipts"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_agent_vault_key_seed_receipt_replacement_attempt"();
--> statement-breakpoint
-- Preserve immutable final receipts written before exact replacement attempts,
-- but make every new final receipt close over the same replacement as its seed.

ALTER TABLE "agent_vault_key_seed_receipts"
  ADD CONSTRAINT "agent_vault_key_seed_receipts_id_replacement_unique"
  UNIQUE ("id", "replacement_attempt_id");
--> statement-breakpoint
ALTER TABLE "agent_backup_restore_receipts"
  ADD COLUMN "replacement_attempt_id" uuid,
  ADD CONSTRAINT "agent_backup_restore_receipts_seed_replacement_fkey"
    FOREIGN KEY ("seed_receipt_id", "replacement_attempt_id")
    REFERENCES "agent_vault_key_seed_receipts" ("id", "replacement_attempt_id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "agent_backup_restore_receipts_replacement_authority_fkey"
    FOREIGN KEY (
      "replacement_attempt_id", "organization_id", "agent_id", "restore_attempt_id"
    ) REFERENCES "agent_sandbox_replacement_attempts"
      ("id", "organization_id", "agent_id", "restore_attempt_id")
    ON DELETE RESTRICT;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_backup_restore_receipt_exact_replacement"()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF NEW."replacement_attempt_id" IS NULL THEN
    RAISE EXCEPTION 'new final restore receipt requires exact replacement attempt authority';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "agent_sandbox_replacement_attempts" AS replacement
    JOIN "agent_vault_key_seed_receipts" AS seed
      ON seed."id" = NEW."seed_receipt_id"
      AND seed."replacement_attempt_id" = replacement."id"
      AND seed."organization_id" = NEW."organization_id"
      AND seed."agent_id" = NEW."agent_id"
      AND seed."restore_attempt_id" = NEW."restore_attempt_id"
      AND seed."backup_id" = NEW."backup_id"
      AND seed."operation_id" = NEW."operation_id"
      AND seed."source_activation_generation" = NEW."source_activation_generation"
      AND seed."source_lifecycle_revision" = NEW."source_lifecycle_revision"
      AND seed."manifest_sha256" = NEW."manifest_sha256"
      AND seed."target_activation_generation" = NEW."target_activation_generation"
      AND seed."receipt_digest" = NEW."seed_receipt_digest"
    JOIN "agent_activation_publications" AS publication
      ON publication."id" = NEW."activation_publication_id"
      AND publication."organization_id" = NEW."organization_id"
      AND publication."agent_id" = NEW."agent_id"
      AND publication."activation_generation" = NEW."target_activation_generation"
      AND publication."purpose" = NEW."activation_purpose"
      AND publication."backup_id" = NEW."backup_id"
      AND publication."backup_manifest_sha256" = NEW."manifest_sha256"
      AND publication."activation_receipt_sha256" = NEW."activation_receipt_sha256"
      AND seed."docker_node_record_id" = publication."docker_node_record_id"
      AND seed."node_incarnation" = publication."node_incarnation"
      AND seed."node_history_id" = publication."node_history_id"
    WHERE replacement."id" = NEW."replacement_attempt_id"
      AND replacement."organization_id" = NEW."organization_id"
      AND replacement."agent_id" = NEW."agent_id"
      AND replacement."operation_kind" = 'provision'
      AND replacement."activation_generation" = NEW."target_activation_generation"
      AND replacement."restore_attempt_id" = NEW."restore_attempt_id"
      AND replacement."restore_backup_id" = NEW."backup_id"
      AND replacement."restore_operation_id" = NEW."operation_id"
      AND replacement."restore_source_activation_generation" =
        NEW."source_activation_generation"
      AND replacement."restore_source_lifecycle_revision" =
        NEW."source_lifecycle_revision"
      AND replacement."restore_manifest_sha256" = NEW."manifest_sha256"
      AND replacement."state" = 'lifecycle_committed'
      AND replacement."locator_container_id" = publication."container_id"
      AND replacement."locator_node_id" = publication."node_id"
      AND replacement."locator_node_record_id" = publication."docker_node_record_id"
      AND replacement."locator_node_incarnation" = publication."node_incarnation"
      AND replacement."locator_node_history_id" = publication."node_history_id"
      AND replacement."locator_allocation_counted" = TRUE
  ) THEN
    RAISE EXCEPTION 'final restore receipt requires its exact adopted replacement chain';
  END IF;

  RETURN NEW;
END;
$guard$;
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_receipts_guard_exact_replacement"
  BEFORE INSERT ON "agent_backup_restore_receipts"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_agent_backup_restore_receipt_exact_replacement"();
