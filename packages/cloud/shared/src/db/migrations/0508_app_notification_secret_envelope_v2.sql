-- Field encryption writes coordinate-bound secrets as `enc:v2:` envelopes.
-- Accept both encrypted envelope versions; plaintext is still rejected.
CREATE OR REPLACE FUNCTION guard_app_notification_endpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM apps a WHERE a.id=NEW.app_id AND a.organization_id=NEW.organization_id) THEN
  RAISE EXCEPTION 'Notification endpoint organization must own application';
 END IF;
 IF TG_OP='UPDATE' AND (OLD.id,OLD.app_id,OLD.organization_id,OLD.livemode) IS DISTINCT FROM (NEW.id,NEW.app_id,NEW.organization_id,NEW.livemode) THEN
  RAISE EXCEPTION 'Notification endpoint identity is immutable';
 END IF;
 IF NEW.active_secret IS NOT NULL AND NEW.active_secret NOT LIKE 'enc:v1:%' AND NEW.active_secret NOT LIKE 'enc:v2:%'
  OR NEW.pending_secret IS NOT NULL AND NEW.pending_secret NOT LIKE 'enc:v1:%' AND NEW.pending_secret NOT LIKE 'enc:v2:%' THEN
  RAISE EXCEPTION 'Notification signing keys require encrypted storage';
 END IF;
 RETURN NEW;
END $$;
