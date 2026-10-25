-- Platform subscription allowance changes advance the organization balance
-- revision. Worker inference admission fences subscriber funding capacity
-- (purchased credit plus spendable allowance) by this revision, so an
-- allowance grant, reserve, release, or expiry must be observable as newer
-- even when the purchased credit balance itself did not change.
CREATE OR REPLACE FUNCTION advance_organization_revision_for_allowance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE organizations
  SET balance_revision = nextval('organization_balance_revision_seq')
  WHERE id = NEW.organization_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS subscription_allowance_transactions_balance_revision_trigger ON subscription_allowance_transactions;
--> statement-breakpoint
CREATE TRIGGER subscription_allowance_transactions_balance_revision_trigger
AFTER INSERT ON subscription_allowance_transactions
FOR EACH ROW
WHEN (NEW.billing_scope_id IS NULL)
EXECUTE FUNCTION advance_organization_revision_for_allowance();
