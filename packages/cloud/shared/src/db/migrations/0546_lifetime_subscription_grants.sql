-- Lifetime grants have no expiry. Existing bounded codes and grants retain their terms.
ALTER TABLE subscription_grant_codes ALTER COLUMN duration_days DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE subscription_grants ALTER COLUMN ends_at DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE organization_entitlements DROP CONSTRAINT organization_entitlements_plan_state_check;
--> statement-breakpoint
ALTER TABLE organization_entitlements ADD CONSTRAINT organization_entitlements_plan_state_check CHECK (
  (source_grant_id IS NULL AND (
    (billing_scope_id IS NOT NULL AND source_subscription_id IS NOT NULL AND source_subscription_revision IS NOT NULL
      AND state IN ('trialing','active','grace','past_due','unpaid','paused','canceled','incomplete','incomplete_expired')
      AND access IN ('granted','read_only','denied') AND entitlement_effective = (access = 'granted'))
    OR (billing_scope_id IS NULL AND plan_key IN ('free','plus_monthly','pro_monthly')
      AND state IN ('free','active','grace','past_due','unpaid') AND (
        (plan_key = 'free' AND state = 'free' AND entitlement_effective
          AND (source_subscription_id IS NULL) = (source_subscription_revision IS NULL))
        OR (plan_key <> 'free' AND state <> 'free' AND source_subscription_id IS NOT NULL
          AND source_subscription_revision IS NOT NULL
          AND (entitlement_effective = (state IN ('active','grace'))))))
  ))
  OR (source_grant_id IS NOT NULL AND billing_scope_id IS NULL
    AND plan_key IN ('plus_monthly','pro_monthly') AND state = 'active' AND entitlement_effective
    AND access = 'granted' AND source_subscription_id IS NULL AND source_subscription_revision IS NULL)
);
