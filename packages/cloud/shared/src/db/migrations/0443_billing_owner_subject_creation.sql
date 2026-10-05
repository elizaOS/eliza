CREATE OR REPLACE FUNCTION ensure_billing_organization_subject(subject_id uuid) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM organizations WHERE id=subject_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Billing owner organization is unavailable'; END IF;
  INSERT INTO billing_organization_subjects(id,live_organization_id)
    VALUES(subject_id,subject_id) ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM billing_organization_subjects WHERE id=subject_id AND live_organization_id=subject_id)
    THEN RAISE EXCEPTION 'Erased billing owner cannot acquire new history'; END IF;
  RETURN subject_id;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ensure_billing_app_subject(subject_id uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE owner_id uuid;
BEGIN
  SELECT organization_id INTO owner_id FROM apps WHERE id=subject_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Billing app is unavailable'; END IF;
  PERFORM ensure_billing_organization_subject(owner_id);
  PERFORM id FROM apps WHERE id=subject_id AND organization_id=owner_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Billing app ownership changed'; END IF;
  INSERT INTO billing_app_subjects(id,organization_id,live_app_id)
    VALUES(subject_id,owner_id,subject_id) ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM billing_app_subjects WHERE id=subject_id AND live_app_id=subject_id AND organization_id=owner_id)
    THEN RAISE EXCEPTION 'Erased or transferred billing app cannot acquire new history'; END IF;
  RETURN subject_id;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ensure_billing_registration_subject(subject_id uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE owner_id uuid; parent_app_id uuid;
BEGIN
  SELECT app_id,owner_organization_id INTO parent_app_id,owner_id FROM app_client_registrations WHERE id=subject_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Billing registration is unavailable'; END IF;
  PERFORM ensure_billing_app_subject(parent_app_id);
  PERFORM id FROM app_client_registrations WHERE id=subject_id AND app_id=parent_app_id AND owner_organization_id=owner_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Billing registration ownership changed'; END IF;
  INSERT INTO billing_registration_subjects(id,app_id,organization_id,live_registration_id)
    VALUES(subject_id,parent_app_id,owner_id,subject_id) ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM billing_registration_subjects WHERE id=subject_id AND live_registration_id=subject_id AND app_id=parent_app_id AND organization_id=owner_id)
    THEN RAISE EXCEPTION 'Erased or transferred billing registration cannot acquire new history'; END IF;
  RETURN subject_id;
END $$;
