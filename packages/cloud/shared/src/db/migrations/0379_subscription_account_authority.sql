-- Retain account subscription identity through terminal lifecycle transitions.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS subscription_authority_id uuid;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS subscription_authority_state text NOT NULL DEFAULT 'none';
--> statement-breakpoint
-- The unique live-subscription constraint establishes identity without timestamp ordering.
UPDATE organizations o SET subscription_authority_id = s.id, subscription_authority_state = 'current'
FROM billing_subscriptions s
WHERE s.organization_id = o.id AND s.status IN ('pending','incomplete','active','grace','past_due','unpaid');
--> statement-breakpoint
-- A single historical source is unambiguous; multiple terminal sources require reconciliation.
UPDATE organizations o SET subscription_authority_id = s.id, subscription_authority_state = 'current'
FROM billing_subscriptions s
WHERE s.organization_id = o.id AND o.subscription_authority_state = 'none'
AND NOT EXISTS (SELECT 1 FROM billing_subscriptions other WHERE other.organization_id = o.id AND other.id <> s.id);
UPDATE organizations o SET subscription_authority_state = 'unavailable'
WHERE o.subscription_authority_state = 'none' AND EXISTS (SELECT 1 FROM billing_subscriptions s WHERE s.organization_id = o.id);
--> statement-breakpoint
ALTER TABLE organizations ADD CONSTRAINT organizations_subscription_authority_tenant_fk
FOREIGN KEY (subscription_authority_id, id) REFERENCES billing_subscriptions (id, organization_id) ON DELETE RESTRICT;
ALTER TABLE organizations ADD CONSTRAINT organizations_subscription_authority_check CHECK (
  (subscription_authority_state = 'current' AND subscription_authority_id IS NOT NULL)
  OR (subscription_authority_state IN ('none','unavailable') AND subscription_authority_id IS NULL)
);
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
