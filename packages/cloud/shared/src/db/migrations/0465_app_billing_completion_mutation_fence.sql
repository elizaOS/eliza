-- Post-completion writes cannot invalidate evidence even if deferred constraints were forced early.
CREATE OR REPLACE FUNCTION fence_app_billing_completed_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evidence record;
BEGIN
  FOR evidence IN SELECT id FROM app_billing_completion_validations WHERE validation_xid=pg_current_xact_id() AND completed_at IS NOT NULL LOOP
    PERFORM require_app_billing_completion_link(evidence.id);
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
DO $$ DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['account_deletion_requests','account_deletion_phase_receipts','organizations','apps','app_billing_accounts','app_billing_scopes','app_billing_customers','app_billing_members','users','billing_merchants','app_billing_plan_revisions','billing_subscriptions','billing_subscription_revisions','billing_subscription_commands','billing_funding_reservations','app_subscription_trials','app_subscription_paid_periods','app_billing_deletion_dispositions','app_billing_customer_closures','app_billing_refund_observations','billing_identity_subjects'] LOOP
    EXECUTE format('CREATE TRIGGER zz_billing_completion_mutation_fence AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fence_app_billing_completed_transaction()',tab);
    EXECUTE format('CREATE TRIGGER zz_billing_completion_truncate_fence AFTER TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION fence_app_billing_completed_transaction()',tab);
  END LOOP;
END $$;
