CREATE SEQUENCE IF NOT EXISTS organization_spendable_revision_seq AS bigint;
--> statement-breakpoint
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS spendable_revision bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE FUNCTION advance_organization_spendable_revision_from_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.credit_balance IS DISTINCT FROM OLD.credit_balance THEN
    NEW.spendable_revision := nextval('organization_spendable_revision_seq');
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organizations_spendable_revision_trigger
BEFORE UPDATE OF credit_balance ON organizations
FOR EACH ROW
EXECUTE FUNCTION advance_organization_spendable_revision_from_balance();
--> statement-breakpoint
CREATE FUNCTION advance_organization_spendable_revision_from_allowance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_organization_id uuid;
BEGIN
  affected_organization_id := CASE WHEN TG_OP = 'DELETE'
    THEN OLD.organization_id ELSE NEW.organization_id END;

  IF TG_OP <> 'UPDATE'
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.granted_amount IS DISTINCT FROM OLD.granted_amount
    OR NEW.remaining_amount IS DISTINCT FROM OLD.remaining_amount
    OR NEW.state IS DISTINCT FROM OLD.state
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  THEN
    UPDATE organizations
      SET spendable_revision = nextval('organization_spendable_revision_seq')
      WHERE id = affected_organization_id;
    IF TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
      UPDATE organizations
        SET spendable_revision = nextval('organization_spendable_revision_seq')
        WHERE id = OLD.organization_id;
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER subscription_allowance_periods_spendable_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON subscription_allowance_periods
FOR EACH ROW
EXECUTE FUNCTION advance_organization_spendable_revision_from_allowance();
