-- Preserve write-once provider receipts and allow only monotonic settlement
-- transitions after the exact placement has been persisted.

CREATE OR REPLACE FUNCTION "guard_agent_sandbox_replacement_attempt_state"()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF OLD."provider_succeeded_at" IS NOT NULL
    AND ROW(OLD."provider_succeeded_at", OLD."provider_receipt_digest")
      IS DISTINCT FROM ROW(NEW."provider_succeeded_at", NEW."provider_receipt_digest") THEN
    RAISE EXCEPTION 'replacement provider receipt is immutable';
  END IF;
  IF OLD."lifecycle_committed_at" IS NOT NULL
    AND ROW(OLD."lifecycle_committed_at", OLD."lifecycle_receipt_digest")
      IS DISTINCT FROM ROW(NEW."lifecycle_committed_at", NEW."lifecycle_receipt_digest") THEN
    RAISE EXCEPTION 'replacement lifecycle receipt is immutable';
  END IF;
  IF OLD."cleanup_proven_at" IS NOT NULL
    AND ROW(OLD."cleanup_proven_at", OLD."cleanup_receipt_digest")
      IS DISTINCT FROM ROW(NEW."cleanup_proven_at", NEW."cleanup_receipt_digest") THEN
    RAISE EXCEPTION 'replacement cleanup receipt is immutable';
  END IF;
  IF NOT (
    NEW."state" = OLD."state"
    OR (OLD."state" = 'in_flight_unresolved'
      AND NEW."state" IN ('provider_succeeded', 'cleanup_proven'))
    OR (OLD."state" = 'provider_succeeded'
      AND NEW."state" IN ('lifecycle_committed', 'cleanup_proven'))
  ) THEN
    RAISE EXCEPTION 'replacement attempt state transition is not monotonic';
  END IF;
  IF OLD."state" = 'in_flight_unresolved' AND NEW."state" = 'provider_succeeded'
    AND (OLD."locator_recorded_at" IS NULL OR OLD."locator_container_id" IS NULL) THEN
    RAISE EXCEPTION 'provider success requires previously durable exact placement';
  END IF;
  RETURN NEW;
END;
$guard$;
--> statement-breakpoint
CREATE TRIGGER "agent_sandbox_replacement_attempts_guard_state"
  BEFORE UPDATE ON "agent_sandbox_replacement_attempts"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_sandbox_replacement_attempt_state"();
