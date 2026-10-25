CREATE SEQUENCE IF NOT EXISTS organization_balance_revision_seq AS bigint;
--> statement-breakpoint

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS balance_revision bigint NOT NULL
  DEFAULT 0;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION advance_organization_balance_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.credit_balance IS DISTINCT FROM OLD.credit_balance THEN
    NEW.balance_revision := nextval('organization_balance_revision_seq');
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS organizations_balance_revision_trigger ON organizations;
--> statement-breakpoint

CREATE TRIGGER organizations_balance_revision_trigger
BEFORE UPDATE OF credit_balance ON organizations
FOR EACH ROW
EXECUTE FUNCTION advance_organization_balance_revision();
