CREATE OR REPLACE FUNCTION anchor_billing_owner_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source jsonb; owner_id uuid; parent_app_id uuid; registration_id uuid;
BEGIN
  source := to_jsonb(NEW);
  owner_id := (source->>TG_ARGV[0])::uuid;
  parent_app_id := (source->>TG_ARGV[1])::uuid;
  registration_id := (source->>TG_ARGV[2])::uuid;
  IF owner_id IS NOT NULL THEN PERFORM ensure_billing_organization_subject(owner_id); END IF;
  IF parent_app_id IS NOT NULL THEN
    IF owner_id IS NOT NULL THEN
      PERFORM id FROM apps WHERE id=parent_app_id AND organization_id=owner_id FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Financial source app ownership does not match'; END IF;
    END IF;
    PERFORM ensure_billing_app_subject(parent_app_id);
    IF owner_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM billing_app_subjects WHERE id=parent_app_id AND organization_id=owner_id)
      THEN RAISE EXCEPTION 'Financial source app ownership does not match'; END IF;
  END IF;
  IF registration_id IS NOT NULL THEN
    IF parent_app_id IS NULL THEN RAISE EXCEPTION 'Financial source registration requires an app'; END IF;
    PERFORM id FROM app_client_registrations WHERE id=registration_id AND app_id=parent_app_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Financial source registration ownership does not match'; END IF;
    PERFORM ensure_billing_registration_subject(registration_id);
    IF parent_app_id IS NULL OR NOT EXISTS(SELECT 1 FROM billing_registration_subjects WHERE id=registration_id AND app_id=parent_app_id)
      THEN RAISE EXCEPTION 'Financial source registration ownership does not match'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER billing_merchants_owner BEFORE INSERT ON billing_merchants FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','','');
--> statement-breakpoint
CREATE TRIGGER app_billing_accounts_owner BEFORE INSERT ON app_billing_accounts FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('','app_id','');
--> statement-breakpoint
CREATE TRIGGER app_billing_plan_revisions_owner BEFORE INSERT ON app_billing_plan_revisions FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('','app_id','');
--> statement-breakpoint
CREATE TRIGGER app_billing_scopes_owner BEFORE INSERT ON app_billing_scopes FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','app_id','');
--> statement-breakpoint
CREATE TRIGGER app_subscription_trials_owner BEFORE INSERT ON app_subscription_trials FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('','app_id','');
--> statement-breakpoint
CREATE TRIGGER app_billing_application_slots_owner BEFORE INSERT ON app_billing_application_slots FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','app_id','');
--> statement-breakpoint
CREATE TRIGGER billing_subscription_commands_owner BEFORE INSERT ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','app_id','client_registration_id');
--> statement-breakpoint
CREATE TRIGGER app_billing_membership_operations_owner BEFORE INSERT ON app_billing_membership_operations FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('','app_id','client_registration_id');
--> statement-breakpoint
CREATE TRIGGER billing_subscriptions_owner BEFORE INSERT ON billing_subscriptions FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','','');
--> statement-breakpoint
CREATE TRIGGER billing_subscription_revisions_owner BEFORE INSERT ON billing_subscription_revisions FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','','');
--> statement-breakpoint
CREATE TRIGGER billing_subscription_event_receipts_owner BEFORE INSERT ON billing_subscription_event_receipts FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','','');
--> statement-breakpoint
CREATE TRIGGER billing_subscription_incidents_owner BEFORE INSERT ON billing_subscription_incidents FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','','');
--> statement-breakpoint
CREATE TRIGGER subscription_allowance_periods_owner BEFORE INSERT ON subscription_allowance_periods FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','','');
--> statement-breakpoint
CREATE TRIGGER subscription_allowance_transactions_owner BEFORE INSERT ON subscription_allowance_transactions FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','','');
--> statement-breakpoint
CREATE TRIGGER billing_funding_reservations_owner BEFORE INSERT ON billing_funding_reservations FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','','');
--> statement-breakpoint
CREATE TRIGGER billing_funding_allocations_owner BEFORE INSERT ON billing_funding_allocations FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','','');
--> statement-breakpoint
CREATE TRIGGER credit_transactions_owner BEFORE INSERT ON credit_transactions FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','','');
