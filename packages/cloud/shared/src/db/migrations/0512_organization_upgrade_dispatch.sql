-- Organization upgrade dispatch provenance is separate from app and cancellation commands.
ALTER TABLE billing_subscription_commands ADD COLUMN organization_upgrade_dispatch_state text;
--> statement-breakpoint
ALTER TABLE billing_subscription_commands ADD CONSTRAINT billing_commands_org_upgrade_dispatch_check
CHECK (organization_upgrade_dispatch_state IS NULL OR
 (app_id IS NULL AND billing_scope_id IS NULL AND kind='upgrade'
  AND organization_upgrade_dispatch_state IN ('ready','started')));
--> statement-breakpoint
CREATE FUNCTION guard_organization_upgrade_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE quote record;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.organization_upgrade_dispatch_state IS NOT NULL AND
   (NEW.organization_upgrade_dispatch_state<>'ready' OR NEW.status<>'PREPARED') THEN
   RAISE EXCEPTION 'Upgrade dispatch must begin unstarted' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF (OLD.organization_upgrade_dispatch_state IS NULL AND NEW.organization_upgrade_dispatch_state IS NOT NULL)
 OR (OLD.organization_upgrade_dispatch_state='ready' AND NEW.organization_upgrade_dispatch_state IS NULL)
 OR (OLD.organization_upgrade_dispatch_state='started' AND NEW.organization_upgrade_dispatch_state IS DISTINCT FROM 'started') THEN
  RAISE EXCEPTION 'Upgrade dispatch provenance cannot be reset or inferred' USING ERRCODE='23514';
 END IF;
 IF OLD.organization_upgrade_dispatch_state='ready' AND NEW.organization_upgrade_dispatch_state='started' THEN
  SELECT * INTO quote FROM organization_plan_change_quotes WHERE consumed_by_command_id=NEW.id;
  IF NOT FOUND OR ROW(quote.organization_id,quote.actor_id,quote.subscription_id,quote.subscription_revision,quote.target_plan_key)
   IS DISTINCT FROM ROW(NEW.organization_id,NEW.requested_by_user_id,NEW.subscription_id,NEW.expected_subscription_revision,NEW.target_plan_key)
   OR quote.expires_at<=clock_timestamp()
   OR NEW.status<>'OUTCOME_UNKNOWN' OR NEW.lease_token IS NULL
   OR NEW.lease_expires_at IS NULL OR NEW.lease_expires_at<=clock_timestamp() OR NEW.execution_generation<=0
   OR ROW(NEW.lease_token,NEW.execution_generation) IS DISTINCT FROM ROW(OLD.lease_token,OLD.execution_generation) THEN
   RAISE EXCEPTION 'Upgrade dispatch requires its live original review and execution lease' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER billing_commands_org_upgrade_dispatch_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands
FOR EACH ROW EXECUTE FUNCTION guard_organization_upgrade_dispatch();
