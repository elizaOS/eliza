ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "lifecycle_revision" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint

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
EXECUTE FUNCTION advance_agent_sandbox_lifecycle_revision();
