-- Expand phase: the old worker may keep writing logical cleanup fences between
-- migration and restart, so every new authority column remains nullable.
ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "replacement_cleanup_node_record_id" uuid,
  ADD COLUMN IF NOT EXISTS "replacement_cleanup_node_incarnation" uuid,
  ADD COLUMN IF NOT EXISTS "replacement_cleanup_node_history_id" uuid,
  ADD COLUMN IF NOT EXISTS "replacement_cleanup_node_hostname" text,
  ADD COLUMN IF NOT EXISTS "replacement_cleanup_node_ssh_port" integer,
  ADD COLUMN IF NOT EXISTS "replacement_cleanup_node_ssh_user" text,
  ADD COLUMN IF NOT EXISTS "replacement_cleanup_node_host_key_fingerprint" text,
  ADD COLUMN IF NOT EXISTS "replacement_cleanup_secret_cleanup_version" integer;
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  ADD COLUMN IF NOT EXISTS "previous_cleanup_state" text,
  ADD COLUMN IF NOT EXISTS "previous_cleanup_proven_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "previous_cleanup_receipt_digest" text;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_replacement_previous_cleanup"()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF num_nonnulls(
      NEW."previous_cleanup_state", NEW."previous_cleanup_proven_at",
      NEW."previous_cleanup_receipt_digest"
    ) <> 0 THEN
      RAISE EXCEPTION 'previous cleanup authority must be acquired after insert'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    OLD."previous_cleanup_state", OLD."previous_cleanup_proven_at",
    OLD."previous_cleanup_receipt_digest"
  ) IS NOT DISTINCT FROM ROW(
    NEW."previous_cleanup_state", NEW."previous_cleanup_proven_at",
    NEW."previous_cleanup_receipt_digest"
  ) THEN
    RAISE EXCEPTION 'previous cleanup replay must not rewrite durable authority'
      USING ERRCODE = '55000';
  END IF;

  IF OLD."previous_cleanup_state" IS NULL THEN
    IF NEW."previous_cleanup_state" IS DISTINCT FROM 'pending'
      OR NEW."state" IS DISTINCT FROM 'lifecycle_committed'
      OR NEW."previous_placement_absent" IS DISTINCT FROM FALSE
      OR num_nonnulls(
        NEW."previous_cleanup_proven_at", NEW."previous_cleanup_receipt_digest"
      ) <> 0 THEN
      RAISE EXCEPTION 'previous cleanup must transition from null to pending at handoff'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD."previous_cleanup_state" = 'pending' THEN
    IF NEW."previous_cleanup_state" IS DISTINCT FROM 'released'
      OR NEW."state" IS DISTINCT FROM 'lifecycle_committed'
      OR NEW."previous_cleanup_proven_at" IS NULL
      OR NEW."previous_cleanup_receipt_digest" !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'previous cleanup must settle once with an exact receipt'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'released previous cleanup authority is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$guard$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_replacement_previous_cleanup_insert_guard"
  ON "agent_sandbox_replacement_attempts";
--> statement-breakpoint
CREATE TRIGGER "agent_replacement_previous_cleanup_insert_guard"
  BEFORE INSERT ON "agent_sandbox_replacement_attempts"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_replacement_previous_cleanup"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_replacement_previous_cleanup_update_guard"
  ON "agent_sandbox_replacement_attempts";
--> statement-breakpoint
CREATE TRIGGER "agent_replacement_previous_cleanup_update_guard"
  BEFORE UPDATE OF "previous_cleanup_state", "previous_cleanup_proven_at",
    "previous_cleanup_receipt_digest" ON "agent_sandbox_replacement_attempts"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_replacement_previous_cleanup"();
