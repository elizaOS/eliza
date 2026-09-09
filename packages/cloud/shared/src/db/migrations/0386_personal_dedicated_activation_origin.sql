-- Preserve the original confirmed quote and job alongside the target commit.
-- Null origins are retained for legacy/adoption receipts; never backfill consent.
ALTER TABLE "personal_dedicated_upgrade_authorities"
  ADD COLUMN IF NOT EXISTS "originating_activation_quote_id" text,
  ADD COLUMN IF NOT EXISTS "originating_activation_quote_version" text,
  ADD COLUMN IF NOT EXISTS "originating_provision_job_id" uuid;
--> statement-breakpoint
ALTER TABLE "personal_dedicated_upgrade_authorities"
  DROP CONSTRAINT IF EXISTS "personal_dedicated_upgrade_authorities_activation_origin_check";
--> statement-breakpoint
ALTER TABLE "personal_dedicated_upgrade_authorities"
  ADD CONSTRAINT "personal_dedicated_upgrade_authorities_activation_origin_check" CHECK (
    (originating_activation_quote_id IS NULL
      AND originating_activation_quote_version IS NULL
      AND originating_provision_job_id IS NULL)
    OR (originating_activation_quote_id IS NOT NULL
      AND originating_activation_quote_id ~ '^[a-f0-9]{64}$'
      AND originating_activation_quote_version IS NOT NULL
      AND originating_activation_quote_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
      AND originating_provision_job_id IS NOT NULL)
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION preserve_personal_dedicated_activation_origin()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.originating_activation_quote_id, OLD.originating_activation_quote_version,
      OLD.originating_provision_job_id)
    IS DISTINCT FROM ROW(NEW.originating_activation_quote_id,
      NEW.originating_activation_quote_version, NEW.originating_provision_job_id)
    OR (OLD.originating_activation_quote_id IS NOT NULL AND
      ROW(OLD.organization_id, OLD.user_id, OLD.source_agent_id, OLD.dedicated_agent_id)
      IS DISTINCT FROM
      ROW(NEW.organization_id, NEW.user_id, NEW.source_agent_id, NEW.dedicated_agent_id))
  THEN
    RAISE EXCEPTION 'Dedicated activation origin is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS preserve_personal_dedicated_activation_origin
  ON "personal_dedicated_upgrade_authorities";
--> statement-breakpoint
CREATE TRIGGER preserve_personal_dedicated_activation_origin
  BEFORE UPDATE ON "personal_dedicated_upgrade_authorities"
  FOR EACH ROW EXECUTE FUNCTION preserve_personal_dedicated_activation_origin();
