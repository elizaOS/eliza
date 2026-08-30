-- Keep alias tenant/deletion ownership identical to its command at commit.

CREATE OR REPLACE FUNCTION "billing_cancel_key_command_subject_consistency"() RETURNS trigger AS $$
DECLARE
  receipt_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'billing_cancel_commands' THEN
    receipt_id := NEW."id";
    IF EXISTS (
      SELECT 1 FROM "billing_cancel_commands" command
      JOIN "billing_cancel_command_keys" key ON key."command_id" = command."id"
      WHERE command."id" = receipt_id
        AND (key."organization_id" IS DISTINCT FROM command."organization_id"
          OR key."organization_deletion_request_id"
            IS DISTINCT FROM command."organization_deletion_request_id")
    ) THEN
      RAISE EXCEPTION 'billing cancel key and command subject authority must match'
        USING ERRCODE = '23514', CONSTRAINT = 'billing_cancel_key_command_subject_consistency';
    END IF;
  ELSE
    PERFORM 1 FROM "billing_cancel_command_keys" key
    JOIN "billing_cancel_commands" command ON command."id" = key."command_id"
    WHERE key."id" = NEW."id"
      AND key."organization_id" IS NOT DISTINCT FROM command."organization_id"
      AND key."organization_deletion_request_id"
        IS NOT DISTINCT FROM command."organization_deletion_request_id";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'billing cancel key and command subject authority must match'
        USING ERRCODE = '23514', CONSTRAINT = 'billing_cancel_key_command_subject_consistency';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "billing_cancel_command_keys_subject_consistency" ON "billing_cancel_command_keys";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "billing_cancel_command_keys_subject_consistency"
  AFTER INSERT OR UPDATE ON "billing_cancel_command_keys"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "billing_cancel_key_command_subject_consistency"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "billing_cancel_commands_subject_consistency" ON "billing_cancel_commands";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "billing_cancel_commands_subject_consistency"
  AFTER UPDATE ON "billing_cancel_commands"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "billing_cancel_key_command_subject_consistency"();
