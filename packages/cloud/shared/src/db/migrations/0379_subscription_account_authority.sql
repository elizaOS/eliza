-- Retain account identity without adding a reverse foreign key to the organization schema.
CREATE TABLE IF NOT EXISTS organization_subscription_authorities (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id uuid,
  state text NOT NULL DEFAULT 'none',
  CONSTRAINT organization_subscription_authorities_tenant_fk FOREIGN KEY (subscription_id, organization_id)
    REFERENCES billing_subscriptions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT organization_subscription_authorities_state_check CHECK (
    (state = 'current' AND subscription_id IS NOT NULL)
    OR (state IN ('none','unavailable') AND subscription_id IS NULL))
);
INSERT INTO organization_subscription_authorities (organization_id) SELECT id FROM organizations;
--> statement-breakpoint
-- The unique live-subscription constraint establishes identity without timestamp ordering.
UPDATE organization_subscription_authorities a SET subscription_id = s.id, state = 'current'
FROM billing_subscriptions s
WHERE s.organization_id = a.organization_id AND s.status IN ('pending','incomplete','active','grace','past_due','unpaid');
--> statement-breakpoint
-- A sole historical identity is unambiguous; multiple terminal sources require reconciliation.
UPDATE organization_subscription_authorities a SET subscription_id = s.id, state = 'current'
FROM billing_subscriptions s
WHERE s.organization_id = a.organization_id AND a.state = 'none'
AND NOT EXISTS (SELECT 1 FROM billing_subscriptions other WHERE other.organization_id = a.organization_id AND other.id <> s.id);
UPDATE organization_subscription_authorities a SET state = 'unavailable'
WHERE a.state = 'none' AND EXISTS (SELECT 1 FROM billing_subscriptions s WHERE s.organization_id = a.organization_id);
--> statement-breakpoint
CREATE FUNCTION seed_organization_subscription_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO organization_subscription_authorities (organization_id) VALUES (NEW.id);
  RETURN NEW;
END
$$;
CREATE TRIGGER organizations_seed_subscription_authority AFTER INSERT ON organizations
FOR EACH ROW EXECUTE FUNCTION seed_organization_subscription_authority();
--> statement-breakpoint
-- Terminal projections retain the authoritative transition that produced Free.
ALTER TABLE organization_entitlements DROP CONSTRAINT organization_entitlements_plan_state_check;
ALTER TABLE organization_entitlements ADD CONSTRAINT organization_entitlements_plan_state_check CHECK (
  plan_key IN ('free','plus_monthly','pro_monthly') AND state IN ('free','active','grace','past_due','unpaid')
  AND ((plan_key = 'free' AND state = 'free' AND entitlement_effective
        AND (source_subscription_id IS NULL) = (source_subscription_revision IS NULL))
    OR (plan_key <> 'free' AND state <> 'free' AND source_subscription_id IS NOT NULL
        AND source_subscription_revision IS NOT NULL AND (entitlement_effective = (state IN ('active','grace')))))
);
