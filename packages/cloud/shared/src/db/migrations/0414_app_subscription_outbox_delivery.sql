ALTER TABLE app_subscription_outbox
 ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'pending',
 ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS lease_token uuid,
 ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
 ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN IF NOT EXISTS error_code text,
 ADD COLUMN IF NOT EXISTS endpoint_revision integer;
--> statement-breakpoint
DROP TRIGGER IF EXISTS app_subscription_outbox_app_source ON app_subscription_outbox;
--> statement-breakpoint
UPDATE app_subscription_outbox SET state='delivered' WHERE delivered_at IS NOT NULL AND state='pending';
--> statement-breakpoint
ALTER TABLE app_subscription_outbox ADD CONSTRAINT app_subscription_outbox_delivery_check CHECK (
 attempts>=0 AND (lease_token IS NULL)=(lease_expires_at IS NULL) AND
 (state='processing')=(lease_token IS NOT NULL) AND (state='delivered')=(delivered_at IS NOT NULL) AND
 state IN ('pending','processing','delivered','terminal'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_subscription_outbox_due_idx ON app_subscription_outbox(next_attempt_at,created_at) WHERE state IN ('pending','processing');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_app_subscription_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (OLD.id,OLD.billing_scope_id,OLD.subscription_id,OLD.subscription_revision,OLD.kind,OLD.created_at) IS DISTINCT FROM (NEW.id,NEW.billing_scope_id,NEW.subscription_id,NEW.subscription_revision,NEW.kind,NEW.created_at) THEN RAISE EXCEPTION 'Subscription delivery identity is immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM billing_subscription_revisions r WHERE r.subscription_id=NEW.subscription_id AND r.revision=NEW.subscription_revision AND r.billing_scope_id=NEW.billing_scope_id) THEN RAISE EXCEPTION 'Subscription delivery source revision mismatch'; END IF;
 IF NEW.kind <> 'app.subscription.updated' THEN RAISE EXCEPTION 'Unsupported app subscription delivery kind'; END IF;
 IF TG_OP='UPDATE' AND OLD.state='delivered' AND OLD IS DISTINCT FROM NEW THEN RAISE EXCEPTION 'Delivered subscription hint is terminal'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER app_subscription_outbox_delivery_authority BEFORE INSERT OR UPDATE ON app_subscription_outbox FOR EACH ROW EXECUTE FUNCTION guard_app_subscription_delivery();
