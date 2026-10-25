DO $$
DECLARE subject_id uuid;
BEGIN
  FOR subject_id IN
    SELECT organization_id FROM billing_merchants
    UNION SELECT organization_id FROM app_billing_scopes
    UNION SELECT organization_id FROM app_billing_application_slots
    UNION SELECT organization_id FROM billing_subscription_commands
    UNION SELECT organization_id FROM billing_subscriptions
    UNION SELECT organization_id FROM billing_subscription_revisions
    UNION SELECT organization_id FROM billing_subscription_event_receipts
    UNION SELECT organization_id FROM billing_subscription_incidents
    UNION SELECT organization_id FROM subscription_allowance_periods
    UNION SELECT organization_id FROM subscription_allowance_transactions
    UNION SELECT organization_id FROM billing_funding_reservations
    UNION SELECT organization_id FROM billing_funding_allocations
    UNION SELECT organization_id FROM credit_transactions
    ORDER BY 1
  LOOP
    IF subject_id IS NOT NULL THEN PERFORM ensure_billing_organization_subject(subject_id); END IF;
  END LOOP;
  FOR subject_id IN
    SELECT app_id FROM app_billing_accounts
    UNION SELECT app_id FROM app_billing_plan_revisions
    UNION SELECT app_id FROM app_billing_scopes
    UNION SELECT app_id FROM app_subscription_trials
    UNION SELECT app_id FROM app_billing_application_slots
    UNION SELECT app_id FROM billing_subscription_commands
    UNION SELECT app_id FROM app_billing_membership_operations
    ORDER BY 1
  LOOP
    IF subject_id IS NOT NULL THEN PERFORM ensure_billing_app_subject(subject_id); END IF;
  END LOOP;
  FOR subject_id IN
    SELECT client_registration_id FROM billing_subscription_commands
    UNION SELECT client_registration_id FROM app_billing_membership_operations
    ORDER BY 1
  LOOP
    IF subject_id IS NOT NULL THEN PERFORM ensure_billing_registration_subject(subject_id); END IF;
  END LOOP;
END $$;
