CREATE TABLE "native_app_publishers" (
  "organization_id" uuid PRIMARY KEY REFERENCES "organizations"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE FUNCTION guard_native_app_publisher() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM organizations WHERE id = NEW.organization_id
    AND is_active AND account_lifecycle_state = 'active'
    AND paid_work_fenced_at IS NULL AND account_deletion_request_id IS NULL
    FOR UPDATE;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM users WHERE organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'native app publishers must be active memberless organizations'
      USING ERRCODE = '23514', CONSTRAINT = 'native_app_publishers_memberless';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER native_app_publishers_guard BEFORE INSERT OR UPDATE ON native_app_publishers
  FOR EACH ROW EXECUTE FUNCTION guard_native_app_publisher();
--> statement-breakpoint
CREATE FUNCTION guard_native_app_publisher_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.organization_id IS NOT NULL THEN
    PERFORM 1 FROM organizations WHERE id = NEW.organization_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM native_app_publishers WHERE organization_id = NEW.organization_id) THEN
      RAISE EXCEPTION 'native app publisher organizations cannot have user members'
        USING ERRCODE = '23514', CONSTRAINT = 'native_app_publishers_memberless';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER users_native_app_publisher_membership_guard
  BEFORE INSERT OR UPDATE OF organization_id ON users
  FOR EACH ROW EXECUTE FUNCTION guard_native_app_publisher_membership();
--> statement-breakpoint
CREATE FUNCTION guard_native_app_publisher_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NOT NEW.is_active OR NEW.account_lifecycle_state <> 'active'
      OR NEW.paid_work_fenced_at IS NOT NULL OR NEW.account_deletion_request_id IS NOT NULL)
    AND EXISTS (SELECT 1 FROM native_app_publishers WHERE organization_id = OLD.id) THEN
    RAISE EXCEPTION 'native app publisher organizations require explicit retirement'
      USING ERRCODE = '23514', CONSTRAINT = 'native_app_publishers_active';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER organizations_native_app_publisher_lifecycle_guard
  BEFORE UPDATE OF is_active, account_lifecycle_state, paid_work_fenced_at, account_deletion_request_id
  ON organizations FOR EACH ROW EXECUTE FUNCTION guard_native_app_publisher_lifecycle();
