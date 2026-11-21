ALTER TABLE subscription_commands
  ADD COLUMN stripe_plan_binding jsonb,
  ADD COLUMN stripe_invoice_id text,
  ADD COLUMN stripe_request_id text,
  DROP CONSTRAINT subscription_commands_status_check,
  ADD CONSTRAINT subscription_commands_status_check CHECK (
    status IN ('prepared', 'dispatched', 'unknown', 'awaiting_payment', 'succeeded', 'rejected')
  ),
  ADD CONSTRAINT subscription_upgrade_evidence CHECK (
    (stripe_invoice_id IS NULL AND stripe_request_id IS NULL)
    OR (stripe_invoice_id IS NOT NULL AND stripe_request_id IS NOT NULL AND stripe_plan_binding IS NOT NULL)
  );

CREATE UNIQUE INDEX subscription_upgrade_invoice_origin ON subscription_commands (stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL;
