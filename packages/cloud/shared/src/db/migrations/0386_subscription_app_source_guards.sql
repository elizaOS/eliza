CREATE FUNCTION validate_subscription_app_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d jsonb := to_jsonb(NEW); sc record; m record; p record; sub record; parent_scope uuid; parent_org uuid; source_id uuid; trial record;
BEGIN
  IF TG_TABLE_NAME = 'billing_merchants' AND TG_OP = 'UPDATE' AND (to_jsonb(OLD) - 'enabled') IS DISTINCT FROM (d - 'enabled') THEN RAISE EXCEPTION 'Billing merchant identity is immutable'; END IF;
  IF TG_TABLE_NAME = 'billing_subscription_commands' AND TG_OP = 'UPDATE' AND ((to_jsonb(OLD)->>'target_plan_revision_id') IS DISTINCT FROM (d->>'target_plan_revision_id') OR (to_jsonb(OLD)->>'target_quantity') IS DISTINCT FROM (d->>'target_quantity')) THEN RAISE EXCEPTION 'App command target is immutable'; END IF;
  IF TG_TABLE_NAME = 'app_subscription_paid_periods' AND TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Settled paid period evidence is immutable'; END IF;
  IF TG_TABLE_NAME = 'app_subscription_outbox' AND TG_OP = 'UPDATE' AND (to_jsonb(OLD) - 'delivered_at') IS DISTINCT FROM (d - 'delivered_at') THEN RAISE EXCEPTION 'Subscription delivery identity is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD)->>'billing_scope_id') IS DISTINCT FROM (d->>'billing_scope_id') THEN RAISE EXCEPTION 'Billing scope cannot change'; END IF;
  IF d->>'billing_scope_id' IS NOT NULL THEN
    SELECT * INTO sc FROM app_billing_scopes WHERE id = (d->>'billing_scope_id')::uuid;
    SELECT * INTO m FROM billing_merchants WHERE id = sc.merchant_id;
    IF sc.id IS NULL OR m.id IS NULL OR (d ? 'organization_id' AND sc.organization_id <> (d->>'organization_id')::uuid) OR (d ? 'merchant_key' AND m.provider_account_key <> d->>'merchant_key') OR (d ? 'provider_environment' AND d->>'provider_environment' <> CASE WHEN m.livemode THEN 'live' ELSE 'test' END) OR (d ? 'livemode' AND m.livemode <> (d->>'livemode')::boolean) THEN RAISE EXCEPTION 'Billing merchant, environment or owner mismatch'; END IF;
    IF d->>'plan_revision_id' IS NOT NULL OR d->>'target_plan_revision_id' IS NOT NULL THEN
      SELECT * INTO p FROM app_billing_plan_revisions WHERE id = COALESCE(d->>'plan_revision_id',d->>'target_plan_revision_id')::uuid;
      IF p.id IS NULL OR (p.app_id,p.merchant_id,p.product_family_key) IS DISTINCT FROM (sc.app_id,sc.merchant_id,sc.product_family_key) THEN RAISE EXCEPTION 'Billing plan belongs to another scope'; END IF;
      IF d ? 'plan_key' AND d->>'plan_key' <> p.plan_key THEN RAISE EXCEPTION 'Billing plan key mismatch'; END IF;
    END IF;
    IF d ? 'stripe_customer_id' AND NOT EXISTS (SELECT 1 FROM app_billing_customers c WHERE c.billing_account_id = sc.billing_account_id AND c.merchant_id = sc.merchant_id AND c.stripe_customer_id = d->>'stripe_customer_id') THEN RAISE EXCEPTION 'Billing customer authority mismatch'; END IF;
    IF TG_TABLE_NAME = 'organization_entitlements' AND (d->>'entitlement_effective')::boolean AND (sc.fenced_at IS NOT NULL OR NOT m.enabled OR EXISTS (SELECT 1 FROM organizations o WHERE o.id = sc.organization_id AND (NOT o.is_active OR o.account_lifecycle_state <> 'active' OR o.paid_work_fenced_at IS NOT NULL)) OR NOT EXISTS (SELECT 1 FROM apps a JOIN app_billing_accounts b ON b.app_id = a.id WHERE a.id = sc.app_id AND a.is_active AND a.is_approved AND a.review_status = 'approved' AND b.id = sc.billing_account_id AND b.deleted_at IS NULL)) THEN RAISE EXCEPTION 'App subscription activation is fenced'; END IF;
  END IF;
  source_id := COALESCE(d->>'subscription_id',d->>'source_subscription_id',d->>'result_subscription_id')::uuid;
  IF source_id IS NOT NULL THEN
    SELECT * INTO sub FROM billing_subscriptions WHERE id = source_id;
    IF sub.id IS NULL OR sub.billing_scope_id IS DISTINCT FROM (d->>'billing_scope_id')::uuid OR (d ? 'organization_id' AND sub.organization_id <> (d->>'organization_id')::uuid) THEN RAISE EXCEPTION 'Subscription child source scope mismatch'; END IF;
    IF TG_TABLE_NAME = 'organization_entitlements' AND (d->>'source_subscription_revision')::bigint <> sub.lifecycle_revision THEN RAISE EXCEPTION 'Entitlement source revision is stale'; END IF;
  END IF;
  IF d->>'allowance_period_id' IS NOT NULL THEN
    SELECT billing_scope_id,organization_id INTO parent_scope,parent_org FROM subscription_allowance_periods WHERE id = (d->>'allowance_period_id')::uuid;
    IF parent_scope IS DISTINCT FROM (d->>'billing_scope_id')::uuid OR parent_org IS DISTINCT FROM (d->>'organization_id')::uuid THEN RAISE EXCEPTION 'Allowance child scope mismatch'; END IF;
  END IF;
  IF TG_TABLE_NAME = 'billing_funding_allocations' THEN
    SELECT billing_scope_id,organization_id INTO parent_scope,parent_org FROM billing_funding_reservations WHERE id = (d->>'reservation_id')::uuid;
    IF parent_scope IS DISTINCT FROM (d->>'billing_scope_id')::uuid OR parent_org IS DISTINCT FROM (d->>'organization_id')::uuid THEN RAISE EXCEPTION 'Funding child scope mismatch'; END IF;
  END IF;
  IF TG_TABLE_NAME = 'subscription_allowance_periods' AND d->>'grant_source' = 'trial_claim' THEN
    SELECT * INTO trial FROM app_subscription_trials WHERE id = (d->>'trial_claim_id')::uuid;
    IF trial.id IS NULL OR trial.billing_scope_id IS DISTINCT FROM (d->>'billing_scope_id')::uuid OR trial.starts_at <> (d->>'period_start')::timestamptz OR trial.ends_at <> (d->>'period_end')::timestamptz THEN RAISE EXCEPTION 'Trial allowance source mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ DECLARE tab text; BEGIN FOREACH tab IN ARRAY ARRAY['organization_subscription_authorities','billing_merchants','billing_subscriptions','billing_subscription_revisions','billing_subscription_commands','billing_subscription_event_receipts','billing_subscription_incidents','subscription_billing_fences','organization_entitlements','subscription_allowance_periods','subscription_allowance_transactions','billing_funding_reservations','billing_funding_allocations','app_subscription_paid_periods','app_subscription_outbox'] LOOP EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION validate_subscription_app_source()',tab || '_app_source',tab); END LOOP; END $$;
