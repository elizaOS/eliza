-- Preserve existing financial actor UUIDs; only their link to an operational user is erasable.
CREATE OR REPLACE FUNCTION ensure_billing_identity_subject(subject_id uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE principal_id uuid;
BEGIN
  PERFORM id FROM users WHERE id=subject_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Billing identity requires an existing user'; END IF;
  SELECT eligibility_principal_id INTO principal_id FROM billing_identity_subjects WHERE id=subject_id AND live_user_id=subject_id;
  IF FOUND THEN RETURN principal_id; END IF;
  IF EXISTS(SELECT 1 FROM billing_identity_subjects WHERE id=subject_id) THEN RAISE EXCEPTION 'Erased billing actor cannot be reassigned'; END IF;
  INSERT INTO billing_eligibility_principals(id) VALUES(subject_id) ON CONFLICT DO NOTHING;
  INSERT INTO billing_identity_subjects(id,live_user_id,eligibility_principal_id) VALUES(subject_id,subject_id,subject_id) ON CONFLICT DO NOTHING;
  SELECT eligibility_principal_id INTO STRICT principal_id FROM billing_identity_subjects WHERE id=subject_id;
  RETURN principal_id;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION preserve_billing_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='billing_identity_subjects' AND TG_OP='UPDATE' THEN
    IF (to_jsonb(OLD)-'live_user_id') IS NOT DISTINCT FROM (to_jsonb(NEW)-'live_user_id')
      AND OLD.live_user_id IS NOT NULL AND NEW.live_user_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM users WHERE id=OLD.live_user_id)
    THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Billing identity provenance is immutable';
END $$;
--> statement-breakpoint
CREATE TRIGGER billing_identity_subjects_immutable BEFORE UPDATE OR DELETE ON billing_identity_subjects FOR EACH ROW EXECUTE FUNCTION preserve_billing_identity();
--> statement-breakpoint
CREATE TRIGGER billing_eligibility_principals_immutable BEFORE UPDATE OR DELETE ON billing_eligibility_principals FOR EACH ROW EXECUTE FUNCTION preserve_billing_identity();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION anchor_billing_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject_id uuid;
BEGIN
  subject_id := (to_jsonb(NEW)->>TG_ARGV[0])::uuid;
  IF subject_id IS NULL THEN RETURN NEW; END IF;
  IF TG_ARGV[1]='eligibility' AND EXISTS(SELECT 1 FROM billing_eligibility_principals WHERE id=subject_id) THEN RETURN NEW; END IF;
  PERFORM ensure_billing_identity_subject(subject_id);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER app_billing_accounts_identity BEFORE INSERT ON app_billing_accounts FOR EACH ROW EXECUTE FUNCTION anchor_billing_identity('eligibility_principal_id','eligibility');
--> statement-breakpoint
CREATE TRIGGER app_subscription_trials_identity BEFORE INSERT ON app_subscription_trials FOR EACH ROW EXECUTE FUNCTION anchor_billing_identity('eligibility_principal_id','eligibility');
--> statement-breakpoint
CREATE TRIGGER billing_subscription_commands_identity BEFORE INSERT ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION anchor_billing_identity('requested_by_user_id','actor');
--> statement-breakpoint
CREATE TRIGGER app_billing_membership_operations_identity BEFORE INSERT ON app_billing_membership_operations FOR EACH ROW EXECUTE FUNCTION anchor_billing_identity('actor_user_id','actor');
--> statement-breakpoint
CREATE TRIGGER app_billing_quotes_identity BEFORE INSERT ON app_billing_quotes FOR EACH ROW EXECUTE FUNCTION anchor_billing_identity('actor_user_id','actor');
--> statement-breakpoint
-- Install insert guards before scanning existing rows so concurrent financial writes cannot miss anchoring.
DO $$
DECLARE subject_id uuid;
BEGIN
  FOR subject_id IN
    SELECT eligibility_principal_id FROM app_billing_accounts
    UNION SELECT eligibility_principal_id FROM app_subscription_trials
    UNION SELECT requested_by_user_id FROM billing_subscription_commands
    UNION SELECT actor_user_id FROM app_billing_membership_operations WHERE actor_user_id IS NOT NULL
    UNION SELECT actor_user_id FROM app_billing_quotes
    ORDER BY 1
  LOOP PERFORM ensure_billing_identity_subject(subject_id); END LOOP;
END $$;
