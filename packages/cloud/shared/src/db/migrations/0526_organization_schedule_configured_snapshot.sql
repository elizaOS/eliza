-- Retain original verified state beyond the provider's finite event-history window.
-- Historical terminal commands stay unchanged; missing snapshots are unavailable evidence.
ALTER TABLE billing_subscription_commands ADD COLUMN organization_schedule_configuration_snapshot jsonb;
--> statement-breakpoint
ALTER TABLE billing_subscription_commands ADD CONSTRAINT organization_schedule_configuration_snapshot_shape CHECK (
 organization_schedule_configuration_snapshot IS NULL OR (
  organization_schedule_configuration_evidence IS NOT NULL
  AND jsonb_typeof(organization_schedule_configuration_snapshot)='object'
  AND NOT organization_schedule_configuration_snapshot ? 'lastResponse'
 ) IS TRUE
);
--> statement-breakpoint
CREATE FUNCTION guard_organization_schedule_configured_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot jsonb; proof jsonb; original_effect record;
BEGIN
 snapshot=NEW.organization_schedule_configuration_snapshot;
 proof=NEW.organization_schedule_configuration_evidence;
 IF TG_OP='UPDATE' AND OLD.organization_schedule_configuration_evidence IS NOT NULL THEN
  IF snapshot IS DISTINCT FROM OLD.organization_schedule_configuration_snapshot THEN
   RAISE EXCEPTION 'Original configured snapshot is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF proof IS NULL THEN
  IF snapshot IS NOT NULL THEN RAISE EXCEPTION 'Configured snapshot requires original publication' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.status<>'OUTCOME_UNKNOWN' OR NEW.status<>'APPLIED' OR snapshot IS NULL THEN
  RAISE EXCEPTION 'Configured publication requires its original snapshot' USING ERRCODE='23514';
 END IF;
 SELECT * INTO original_effect FROM organization_schedule_effects
 WHERE command_id=NEW.id AND organization_id=NEW.organization_id AND kind='schedule_configure';
 IF NOT FOUND OR (
  jsonb_typeof(snapshot)='object'
  AND snapshot->>'object'='subscription_schedule'
  AND snapshot->>'id'=proof->>'scheduleId'
  AND snapshot->>'customer'=original_effect.customer_id
  AND snapshot->>'subscription'=original_effect.subscription_id
  AND snapshot->'livemode'=to_jsonb(original_effect.livemode)
  AND snapshot->>'status'='active' AND snapshot->>'end_behavior'='release'
  AND jsonb_typeof(snapshot->'phases')='array' AND jsonb_array_length(snapshot->'phases')=2
  AND snapshot#>'{current_phase,start_date}'=original_effect.request_payload#>'{params,phases,0,start_date}'
  AND snapshot#>'{current_phase,end_date}'=proof->'effectiveAt'
  AND snapshot#>'{phases,0,start_date}'=snapshot#>'{current_phase,start_date}'
  AND snapshot#>'{phases,0,end_date}'=proof->'effectiveAt'
  AND snapshot#>'{phases,1,start_date}'=proof->'effectiveAt'
  AND snapshot#>>'{phases,0,items,0,price}'=original_effect.request_payload#>>'{params,phases,0,items,0,price}'
  AND snapshot#>>'{phases,1,items,0,price}'=original_effect.request_payload#>>'{params,phases,1,items,0,price}'
 ) IS NOT TRUE THEN
  RAISE EXCEPTION 'Configured snapshot requires original schedule scope and target' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER organization_schedule_configured_snapshot_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION guard_organization_schedule_configured_snapshot();
