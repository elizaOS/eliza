-- Pin the actual applied revision atomically; legacy rows remain unresolved until exact evidence is unique.
ALTER TABLE billing_subscription_commands ADD COLUMN IF NOT EXISTS result_subscription_revision bigint;
--> statement-breakpoint
ALTER TABLE billing_subscription_commands ADD CONSTRAINT billing_commands_result_revision_fk FOREIGN KEY (result_subscription_id,organization_id,result_subscription_revision) REFERENCES billing_subscription_revisions(subscription_id,organization_id,revision) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE billing_subscription_commands ADD CONSTRAINT billing_commands_result_revision_check CHECK (result_subscription_revision IS NULL OR (status='APPLIED' AND result_subscription_id IS NOT NULL AND result_subscription_revision>0));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_app_billing_applied_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.result_subscription_revision IS NOT NULL AND ROW(NEW.result_subscription_id,NEW.result_subscription_revision,NEW.provider_response_digest) IS DISTINCT FROM ROW(OLD.result_subscription_id,OLD.result_subscription_revision,OLD.provider_response_digest) THEN RAISE EXCEPTION 'Applied billing revision is immutable'; END IF;
  IF NEW.result_subscription_revision IS NOT NULL AND NOT EXISTS(SELECT 1 FROM billing_subscription_revisions r WHERE r.subscription_id=NEW.result_subscription_id AND r.organization_id=NEW.organization_id AND r.revision=NEW.result_subscription_revision AND r.provider_object_digest=NEW.provider_response_digest) THEN RAISE EXCEPTION 'Applied billing revision requires exact provider evidence'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER app_billing_applied_revision_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION guard_app_billing_applied_revision();
