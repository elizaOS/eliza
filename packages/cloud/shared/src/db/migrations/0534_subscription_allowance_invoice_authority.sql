-- The trial variant makes invoice IDs nullable. CHECK(NULL) otherwise admits a
-- paid-invoice grant without its invoice identity. Preserve existing rows and
-- fail migration on invalid historical data rather than inventing provenance.
ALTER TABLE subscription_allowance_periods
  DROP CONSTRAINT subscription_allowance_periods_invoice_id_check,
  ADD CONSTRAINT subscription_allowance_periods_invoice_id_check CHECK (
    provider = 'stripe' AND provider_environment IN ('test', 'live') AND (
      (grant_source = 'paid_invoice' AND stripe_invoice_id IS NOT NULL
        AND stripe_invoice_id ~ '^in_[A-Za-z0-9]+$' AND trial_claim_id IS NULL)
      OR (grant_source = 'trial_claim' AND billing_scope_id IS NOT NULL
        AND stripe_invoice_id IS NULL AND trial_claim_id IS NOT NULL)
    )
  );
