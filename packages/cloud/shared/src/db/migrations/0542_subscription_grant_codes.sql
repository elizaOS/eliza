-- Cloud-native subscription grant codes (for example the Alpha Phone six-month
-- Plus grant). They are not Stripe promotion codes: Stripe checkout keeps its
-- fail-closed rules. A redeemed code publishes a time-bounded `promo_grant`
-- entitlement and its non-rollover monthly allowance buckets. A paid
-- subscription keeps precedence for as long as it is effective.
CREATE TABLE subscription_grant_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- HMAC-SHA256 of the normalized code under a server pepper. Plaintext is never stored.
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  family text NOT NULL DEFAULT 'alpha_phone' CHECK (family ~ '^[a-z0-9_]{1,64}$'),
  plan_key text NOT NULL DEFAULT 'plus_monthly' CHECK (plan_key IN ('plus_monthly','pro_monthly')),
  catalog_version text NOT NULL DEFAULT 'v1' CHECK (length(btrim(catalog_version)) > 0),
  duration_days integer NOT NULL DEFAULT 183 CHECK (duration_days BETWEEN 1 AND 731),
  max_redemptions integer NOT NULL CHECK (max_redemptions > 0),
  redeemed_count integer NOT NULL DEFAULT 0 CHECK (redeemed_count >= 0 AND redeemed_count <= max_redemptions),
  expires_at timestamptz,
  label text CHECK (label IS NULL OR length(label) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);
--> statement-breakpoint
CREATE TABLE subscription_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  code_id uuid NOT NULL REFERENCES subscription_grant_codes(id) ON DELETE RESTRICT,
  family text NOT NULL CHECK (family ~ '^[a-z0-9_]{1,64}$'),
  plan_key text NOT NULL CHECK (plan_key IN ('plus_monthly','pro_monthly')),
  catalog_version text NOT NULL CHECK (length(btrim(catalog_version)) > 0),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Support revocation (for example a leaked or resold batch). A revoked grant
  -- stops serving at once and keeps the organization's slot in its family.
  revoked_at timestamptz,
  revoked_reason text,
  CONSTRAINT subscription_grants_window_check CHECK (ends_at > starts_at),
  CONSTRAINT subscription_grants_revocation_check CHECK (
    (revoked_at IS NULL) = (revoked_reason IS NULL)
    AND (revoked_reason IS NULL OR length(btrim(revoked_reason)) BETWEEN 1 AND 500)
  ),
  -- One free grant per organization for each code family.
  CONSTRAINT subscription_grants_org_family_idx UNIQUE (organization_id, family),
  CONSTRAINT subscription_grants_id_org_idx UNIQUE (id, organization_id)
);
--> statement-breakpoint
CREATE INDEX subscription_grants_org_window_idx ON subscription_grants (organization_id, ends_at);
--> statement-breakpoint
CREATE INDEX subscription_grants_code_idx ON subscription_grants (code_id);
--> statement-breakpoint
-- Grant terms are immutable. Two one-way changes are allowed: user_id becomes
-- NULL (the ON DELETE SET NULL action when the redeeming user is deleted), and
-- revoked_at/revoked_reason are set once.
CREATE FUNCTION guard_subscription_grant_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Subscription grant history cannot be deleted';
  END IF;
  IF (to_jsonb(NEW) - 'user_id' - 'revoked_at' - 'revoked_reason')
       IS DISTINCT FROM (to_jsonb(OLD) - 'user_id' - 'revoked_at' - 'revoked_reason')
     OR (NEW.user_id IS DISTINCT FROM OLD.user_id AND NEW.user_id IS NOT NULL)
     OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
       OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason)) THEN
    RAISE EXCEPTION 'Subscription grant terms are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER subscription_grants_immutable BEFORE UPDATE OR DELETE ON subscription_grants
  FOR EACH ROW EXECUTE FUNCTION guard_subscription_grant_record();
--> statement-breakpoint
ALTER TABLE organization_entitlements ADD COLUMN source_grant_id uuid;
--> statement-breakpoint
ALTER TABLE organization_entitlements
  ADD CONSTRAINT organization_entitlements_source_grant_tenant_fk
  FOREIGN KEY (source_grant_id, organization_id)
  REFERENCES subscription_grants(id, organization_id) ON DELETE RESTRICT;
--> statement-breakpoint
-- The paid and app-scope variants are unchanged and now also require no grant
-- source. The promo_grant variant is an organization (legacy-scope) row with no
-- Stripe source, a bounded window and the granted plan's active state.
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
    AND access = 'granted' AND source_subscription_id IS NULL AND source_subscription_revision IS NULL
    AND effective_until IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE subscription_allowance_periods ALTER COLUMN subscription_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE subscription_allowance_periods ALTER COLUMN subscription_revision DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE subscription_allowance_periods ADD COLUMN promo_grant_id uuid;
--> statement-breakpoint
ALTER TABLE subscription_allowance_periods
  ADD CONSTRAINT subscription_allowance_periods_promo_grant_tenant_fk
  FOREIGN KEY (promo_grant_id, organization_id)
  REFERENCES subscription_grants(id, organization_id) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX subscription_allowance_periods_promo_grant_period_idx
  ON subscription_allowance_periods (promo_grant_id, period_start)
  WHERE promo_grant_id IS NOT NULL;
--> statement-breakpoint
-- Stripe-sourced buckets keep their exact invoice/trial provenance and must name
-- their subscription source. A promo_grant bucket names only its grant.
ALTER TABLE subscription_allowance_periods
  DROP CONSTRAINT subscription_allowance_periods_invoice_id_check,
  ADD CONSTRAINT subscription_allowance_periods_invoice_id_check CHECK (
    (provider = 'stripe' AND provider_environment IN ('test', 'live')
      AND subscription_id IS NOT NULL AND subscription_revision IS NOT NULL AND promo_grant_id IS NULL
      AND (
        (grant_source = 'paid_invoice' AND stripe_invoice_id IS NOT NULL
          AND stripe_invoice_id ~ '^in_[A-Za-z0-9]+$' AND trial_claim_id IS NULL)
        OR (grant_source = 'trial_claim' AND billing_scope_id IS NOT NULL
          AND stripe_invoice_id IS NULL AND trial_claim_id IS NOT NULL)
      ))
    OR (grant_source = 'promo_grant' AND provider = 'eliza' AND provider_environment IN ('test', 'live')
      AND billing_scope_id IS NULL AND merchant_key = 'platform'
      AND subscription_id IS NULL AND subscription_revision IS NULL
      AND stripe_invoice_id IS NULL AND trial_claim_id IS NULL AND promo_grant_id IS NOT NULL)
  );
