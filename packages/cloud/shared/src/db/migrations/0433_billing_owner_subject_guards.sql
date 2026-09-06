CREATE OR REPLACE FUNCTION guard_billing_owner_subject() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  live_column text;
  owner_id uuid;
  parent_app_id uuid;
  operational_id uuid;
  old_data jsonb;
  new_data jsonb;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Billing ownership history cannot be removed';
  END IF;
  live_column := CASE TG_TABLE_NAME
    WHEN 'billing_organization_subjects' THEN 'live_organization_id'
    WHEN 'billing_app_subjects' THEN 'live_app_id'
    WHEN 'billing_registration_subjects' THEN 'live_registration_id'
    ELSE NULL END;
  IF live_column IS NULL THEN RAISE EXCEPTION 'Unsupported billing ownership table'; END IF;
  new_data := to_jsonb(NEW);
  IF TG_OP='UPDATE' THEN
    old_data := to_jsonb(OLD);
    IF old_data=new_data THEN RETURN NEW; END IF;
    IF old_data-live_column <> new_data-live_column
      OR old_data->>live_column IS NULL OR new_data->>live_column IS NOT NULL THEN
      RAISE EXCEPTION 'Billing ownership history is immutable';
    END IF;
    IF TG_TABLE_NAME='billing_organization_subjects' THEN
      SELECT id INTO operational_id FROM organizations WHERE id=OLD.id;
    ELSIF TG_TABLE_NAME='billing_app_subjects' THEN
      SELECT id INTO operational_id FROM apps WHERE id=OLD.id;
    ELSE
      SELECT id INTO operational_id FROM app_client_registrations WHERE id=OLD.id;
    END IF;
    IF operational_id IS NOT NULL THEN RAISE EXCEPTION 'Live billing ownership cannot detach'; END IF;
    RETURN NEW;
  END IF;
  IF (new_data->>live_column)::uuid IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'Billing ownership requires its original live identity';
  END IF;
  owner_id := CASE WHEN TG_TABLE_NAME='billing_organization_subjects' THEN NEW.id
    ELSE (new_data->>'organization_id')::uuid END;
  PERFORM id FROM organizations WHERE id=owner_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Billing owner organization is unavailable'; END IF;
  IF TG_TABLE_NAME<>'billing_organization_subjects' THEN
    PERFORM id FROM billing_organization_subjects WHERE id=owner_id AND live_organization_id=owner_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Erased billing owner cannot acquire new history'; END IF;
    parent_app_id := CASE WHEN TG_TABLE_NAME='billing_app_subjects' THEN NEW.id
      ELSE (new_data->>'app_id')::uuid END;
    PERFORM id FROM apps WHERE id=parent_app_id AND organization_id=owner_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Billing app ownership does not match'; END IF;
    IF TG_TABLE_NAME='billing_registration_subjects' THEN
      PERFORM id FROM billing_app_subjects WHERE id=parent_app_id AND live_app_id=parent_app_id AND organization_id=owner_id FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Erased billing app cannot acquire new history'; END IF;
      PERFORM id FROM app_client_registrations WHERE id=NEW.id
        AND app_id=parent_app_id AND owner_organization_id=owner_id FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Billing registration ownership does not match'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER billing_organization_subjects_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_organization_subjects FOR EACH ROW EXECUTE FUNCTION guard_billing_owner_subject();
--> statement-breakpoint
CREATE TRIGGER billing_organization_subjects_truncate_guard BEFORE TRUNCATE ON billing_organization_subjects FOR EACH STATEMENT EXECUTE FUNCTION guard_billing_owner_subject();
--> statement-breakpoint
CREATE TRIGGER billing_app_subjects_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_app_subjects FOR EACH ROW EXECUTE FUNCTION guard_billing_owner_subject();
--> statement-breakpoint
CREATE TRIGGER billing_app_subjects_truncate_guard BEFORE TRUNCATE ON billing_app_subjects FOR EACH STATEMENT EXECUTE FUNCTION guard_billing_owner_subject();
--> statement-breakpoint
CREATE TRIGGER billing_registration_subjects_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_registration_subjects FOR EACH ROW EXECUTE FUNCTION guard_billing_owner_subject();
--> statement-breakpoint
CREATE TRIGGER billing_registration_subjects_truncate_guard BEFORE TRUNCATE ON billing_registration_subjects FOR EACH STATEMENT EXECUTE FUNCTION guard_billing_owner_subject();
