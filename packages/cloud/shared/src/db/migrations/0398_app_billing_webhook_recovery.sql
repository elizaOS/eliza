ALTER TABLE webhook_events
 ADD COLUMN IF NOT EXISTS app_billing_trigger jsonb,
 ADD COLUMN IF NOT EXISTS app_billing_completed_at timestamptz,
 ADD COLUMN IF NOT EXISTS app_billing_next_attempt_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN IF NOT EXISTS app_billing_error_code text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS webhook_events_app_billing_due_idx ON webhook_events(app_billing_next_attempt_at) WHERE app_billing_trigger IS NOT NULL AND app_billing_completed_at IS NULL;
--> statement-breakpoint
ALTER TABLE app_billing_scopes
 ADD COLUMN IF NOT EXISTS command_reconcile_after timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN IF NOT EXISTS reconcile_after timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN IF NOT EXISTS reconcile_lease_token uuid,
 ADD COLUMN IF NOT EXISTS reconcile_lease_expires_at timestamptz,
 ADD COLUMN IF NOT EXISTS reconcile_error_code text;
--> statement-breakpoint
ALTER TABLE app_billing_scopes ADD CONSTRAINT app_billing_scopes_reconcile_lease_check CHECK ((reconcile_lease_token IS NULL)=(reconcile_lease_expires_at IS NULL));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_billing_scopes_reconcile_due_idx ON app_billing_scopes(reconcile_after);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_app_billing_scope_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (to_jsonb(OLD)-ARRAY['fenced_at','command_reconcile_after','reconcile_after','reconcile_lease_token','reconcile_lease_expires_at','reconcile_error_code']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['fenced_at','command_reconcile_after','reconcile_after','reconcile_lease_token','reconcile_lease_expires_at','reconcile_error_code'])) THEN RAISE EXCEPTION 'Billing scope identity is immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM apps a JOIN billing_merchants m ON m.organization_id=a.organization_id JOIN app_billing_accounts b ON b.app_id=a.id WHERE a.id=NEW.app_id AND a.organization_id=NEW.organization_id AND m.id=NEW.merchant_id AND m.livemode=NEW.livemode AND b.id=NEW.billing_account_id) THEN RAISE EXCEPTION 'Billing scope owner or mode mismatch'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS app_billing_scopes_authority ON app_billing_scopes;
--> statement-breakpoint
CREATE TRIGGER app_billing_scopes_authority BEFORE INSERT OR UPDATE OR DELETE ON app_billing_scopes FOR EACH ROW EXECUTE FUNCTION guard_app_billing_scope_reconciliation();

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_billing_scopes_command_reconcile_due_idx ON app_billing_scopes(command_reconcile_after);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_app_billing_webhook_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.app_billing_trigger IS NOT NULL AND OLD.app_billing_completed_at IS NULL THEN RAISE EXCEPTION 'Incomplete app billing trigger requires durable recovery'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND OLD.app_billing_trigger IS NOT NULL AND (OLD.event_id,OLD.provider,OLD.payload_hash,OLD.app_billing_trigger) IS DISTINCT FROM (NEW.event_id,NEW.provider,NEW.payload_hash,NEW.app_billing_trigger) THEN RAISE EXCEPTION 'Signed app billing trigger identity is immutable'; END IF;
 IF TG_OP='UPDATE' AND OLD.app_billing_completed_at IS NOT NULL AND OLD.app_billing_completed_at IS DISTINCT FROM NEW.app_billing_completed_at THEN RAISE EXCEPTION 'Completed app billing trigger is terminal'; END IF;
 IF NEW.app_billing_trigger IS NOT NULL AND (NEW.provider<>'stripe' OR NEW.app_billing_trigger->'event'->>'payloadDigest' IS DISTINCT FROM NEW.payload_hash OR NEW.event_id IS DISTINCT FROM 'stripe:'||(NEW.app_billing_trigger->>'merchantKey')||':'||(CASE WHEN (NEW.app_billing_trigger->'event'->>'livemode')::boolean THEN 'live' ELSE 'test' END)||':'||(NEW.app_billing_trigger->'event'->>'eventId')) THEN RAISE EXCEPTION 'Signed app billing trigger envelope mismatch'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER webhook_events_app_billing_authority BEFORE INSERT OR UPDATE OR DELETE ON webhook_events FOR EACH ROW EXECUTE FUNCTION guard_app_billing_webhook_trigger();
