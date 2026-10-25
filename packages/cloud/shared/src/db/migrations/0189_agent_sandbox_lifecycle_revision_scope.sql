-- Scope the lifecycle-revision counter to lifecycle writes.
--
-- 0187 added the counter with an unconditional BEFORE UPDATE trigger, so the
-- revision advanced on every write to the table. Inside one transaction that is
-- exactly right and makes the counter unforgeable. Across two it means something
-- weaker than the fences assume: `lifecycle_revision = $expected` reads as "did a
-- lifecycle operation intervene?" but asserts "did anything at all touch this
-- row?". The periodic billing writers touch the row and are not lifecycle
-- operations, so a billing cycle landing inside a cross-transaction fence turned
-- a successful warm claim into a terminal provisioning failure.
--
-- The WHEN clause is written as an EXCLUSION rather than a list of the columns
-- the fences read. That direction is deliberate: an under-specified positive list
-- silently stops advancing the counter for a genuine lifecycle write, which
-- reopens the ABA window the fence exists to close — worse than the bug being
-- fixed. Excluding instead means a column added later is compared by default, so
-- a new lifecycle column is covered the day it appears and only an explicit edit
-- here can widen the blind spot.
--
-- `lifecycle_revision` is deliberately NOT excluded. A writer touching only
-- billing columns while also setting the revision by hand makes the two sides
-- differ, so the trigger fires and the function overwrites the supplied value
-- with OLD + 1. Excluding it would leave exactly that forgery open.

CREATE OR REPLACE FUNCTION advance_agent_sandbox_lifecycle_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.lifecycle_revision := OLD.lifecycle_revision + 1;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS agent_sandboxes_lifecycle_revision_trigger ON "agent_sandboxes";
--> statement-breakpoint

CREATE TRIGGER agent_sandboxes_lifecycle_revision_trigger
BEFORE UPDATE ON "agent_sandboxes"
FOR EACH ROW
WHEN (
  to_jsonb(OLD) - ARRAY[
    'billing_status',
    'last_billed_at',
    'hourly_rate',
    'total_billed',
    'shutdown_warning_sent_at',
    'scheduled_shutdown_at',
    'updated_at'
  ]::text[]
  IS DISTINCT FROM
  to_jsonb(NEW) - ARRAY[
    'billing_status',
    'last_billed_at',
    'hourly_rate',
    'total_billed',
    'shutdown_warning_sent_at',
    'scheduled_shutdown_at',
    'updated_at'
  ]::text[]
)
EXECUTE FUNCTION advance_agent_sandbox_lifecycle_revision();
