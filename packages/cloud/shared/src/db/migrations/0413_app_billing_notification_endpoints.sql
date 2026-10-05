CREATE TABLE IF NOT EXISTS app_billing_notification_endpoints (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 app_id uuid NOT NULL REFERENCES apps(id) ON DELETE RESTRICT,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 livemode boolean NOT NULL,
 endpoint_url text NOT NULL,
 enabled boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1,
 active_key_id uuid, active_secret text,
 pending_key_id uuid, pending_secret text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT app_billing_notification_endpoints_shape_check CHECK (
 revision>0 AND (active_key_id IS NULL)=(active_secret IS NULL) AND
 (pending_key_id IS NULL)=(pending_secret IS NULL) AND (NOT enabled OR active_key_id IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS app_billing_notification_endpoints_app_mode_idx ON app_billing_notification_endpoints(app_id,livemode);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_app_notification_endpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM apps a WHERE a.id=NEW.app_id AND a.organization_id=NEW.organization_id) THEN
  RAISE EXCEPTION 'Notification endpoint organization must own application';
 END IF;
 IF TG_OP='UPDATE' AND (OLD.id,OLD.app_id,OLD.organization_id,OLD.livemode) IS DISTINCT FROM (NEW.id,NEW.app_id,NEW.organization_id,NEW.livemode) THEN
  RAISE EXCEPTION 'Notification endpoint identity is immutable';
 END IF;
 IF NEW.active_secret IS NOT NULL AND NEW.active_secret NOT LIKE 'enc:v1:%' OR NEW.pending_secret IS NOT NULL AND NEW.pending_secret NOT LIKE 'enc:v1:%' THEN
  RAISE EXCEPTION 'Notification signing keys require encrypted storage';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS app_notification_endpoint_guard ON app_billing_notification_endpoints;
--> statement-breakpoint
CREATE TRIGGER app_notification_endpoint_guard BEFORE INSERT OR UPDATE ON app_billing_notification_endpoints FOR EACH ROW EXECUTE FUNCTION guard_app_notification_endpoint();
