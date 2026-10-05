-- Identify historical evidence separately from the fresh later-period observation.
ALTER TABLE billing_subscription_commands ADD COLUMN organization_upgrade_settlement_evidence jsonb;
--> statement-breakpoint
ALTER TABLE billing_subscription_commands ADD CONSTRAINT organization_upgrade_settlement_evidence_shape CHECK (
 organization_upgrade_settlement_evidence IS NULL OR (kind='upgrade' AND app_id IS NULL AND billing_scope_id IS NULL AND merchant_key='platform' AND status='APPLIED'
 AND organization_upgrade_settlement_evidence->>'kind'='historical_target_with_live_compatibility'
 AND organization_upgrade_settlement_evidence->>'eventId' ~ '^evt_[A-Za-z0-9]+$'
 AND organization_upgrade_settlement_evidence->>'eventDigest' ~ '^[a-f0-9]{64}$'
 AND organization_upgrade_settlement_evidence->>'liveDigest' ~ '^[a-f0-9]{64}$'
 AND jsonb_typeof(organization_upgrade_settlement_evidence->'livePeriodStart')='string'
 AND jsonb_typeof(organization_upgrade_settlement_evidence->'livePeriodEnd')='string'
 AND jsonb_typeof(organization_upgrade_settlement_evidence->'observedAt')='string') IS TRUE
);
--> statement-breakpoint
CREATE FUNCTION guard_organization_upgrade_settlement_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt record; source record; proof jsonb;
BEGIN
 proof=NEW.organization_upgrade_settlement_evidence;
 IF TG_OP='UPDATE' AND OLD.organization_upgrade_settlement_evidence IS NOT NULL THEN
  IF proof IS DISTINCT FROM OLD.organization_upgrade_settlement_evidence THEN RAISE EXCEPTION 'Historical settlement evidence is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF proof IS NULL THEN RETURN NEW; END IF;
 IF TG_OP<>'UPDATE' OR OLD.status<>'OUTCOME_UNKNOWN' OR NEW.status<>'APPLIED' THEN
  RAISE EXCEPTION 'Historical evidence belongs only to original atomic paid settlement' USING ERRCODE='23514'; END IF;
 SELECT * INTO receipt FROM organization_upgrade_historical_targets WHERE command_id=NEW.id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR ROW(receipt.provider_event_id,receipt.evidence_digest) IS DISTINCT FROM ROW(proof->>'eventId',proof->>'eventDigest') THEN
  RAISE EXCEPTION 'Historical settlement requires its exact immutable target receipt' USING ERRCODE='23514'; END IF;
 SELECT * INTO source FROM billing_subscription_revisions WHERE subscription_id=NEW.subscription_id AND organization_id=NEW.organization_id AND revision=NEW.expected_subscription_revision;
 IF NOT FOUND OR ((proof->>'livePeriodStart')::timestamptz>=source.current_period_end
 AND (proof->>'livePeriodStart')::timestamptz<=(proof->>'observedAt')::timestamptz
 AND (proof->>'observedAt')::timestamptz<(proof->>'livePeriodEnd')::timestamptz
 AND (proof->>'observedAt')::timestamptz<=clock_timestamp()) IS NOT TRUE THEN
  RAISE EXCEPTION 'Historical settlement requires a compatible later live period' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organization_upgrade_settlement_evidence_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands
FOR EACH ROW EXECUTE FUNCTION guard_organization_upgrade_settlement_evidence();
