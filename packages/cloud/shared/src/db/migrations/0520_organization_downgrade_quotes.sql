-- Shared immutable quote storage now distinguishes scheduled downgrade review from upgrade review.
CREATE OR REPLACE FUNCTION guard_organization_plan_quote() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source record; command record;
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Plan quote audit terms cannot be deleted directly' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['consumed_by_command_id','consumed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['consumed_by_command_id','consumed_at']) THEN
  RAISE EXCEPTION 'Plan quote terms are immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.consumed_by_command_id IS NOT NULL AND ROW(NEW.consumed_by_command_id,NEW.consumed_at) IS DISTINCT FROM ROW(OLD.consumed_by_command_id,OLD.consumed_at) THEN
  RAISE EXCEPTION 'Plan quote already consumed' USING ERRCODE='23514';
 END IF;
 SELECT * INTO source FROM billing_subscriptions WHERE id=NEW.subscription_id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR source.billing_scope_id IS NOT NULL OR source.lifecycle_revision<>NEW.subscription_revision
 OR source.plan_key=NEW.target_plan_key OR source.catalog_version<>NEW.catalog_version
 OR ((NEW.review->>'kind') IS DISTINCT FROM 'upgrade_estimate' AND (NEW.review->>'kind') IS DISTINCT FROM 'downgrade_estimate')
 OR (NEW.review->>'subscriptionId') IS DISTINCT FROM NEW.subscription_id::text
 OR (NEW.review->>'expectedSubscriptionRevision') IS DISTINCT FROM NEW.subscription_revision::text
 OR (NEW.review->>'sourcePlanKey') IS DISTINCT FROM source.plan_key
 OR (NEW.review->>'targetPlanKey') IS DISTINCT FROM NEW.target_plan_key
 OR (NEW.review->>'catalogVersion') IS DISTINCT FROM NEW.catalog_version
 OR (NEW.review->>'expiresAt')::timestamptz IS DISTINCT FROM NEW.expires_at THEN
  RAISE EXCEPTION 'Plan quote source mismatch' USING ERRCODE='23514';
 END IF;
 IF NEW.review->>'kind'='downgrade_estimate' AND (
  NEW.provider_binding IS NULL
  OR jsonb_typeof(NEW.review->'amountDueNowCents') IS DISTINCT FROM 'number'
  OR (NEW.review->>'effectiveAt')::timestamptz IS DISTINCT FROM source.current_period_end
  OR (NEW.review->>'currentPeriodStart')::timestamptz IS DISTINCT FROM source.current_period_start
  OR (NEW.review->>'currentPeriodEnd')::timestamptz IS DISTINCT FROM source.current_period_end
  OR (NEW.review->>'amountDueNowCents') IS DISTINCT FROM '0'
 ) THEN
  RAISE EXCEPTION 'Downgrade review must retain the current paid period' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' AND (NEW.consumed_by_command_id IS NOT NULL OR NEW.expires_at<=clock_timestamp() OR NEW.created_at>clock_timestamp()) THEN
  RAISE EXCEPTION 'New plan quote must be live and unconsumed' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.consumed_by_command_id IS NULL AND NEW.consumed_by_command_id IS NOT NULL THEN
  SELECT * INTO command FROM billing_subscription_commands WHERE id=NEW.consumed_by_command_id AND organization_id=NEW.organization_id;
  IF NOT FOUND OR command.app_id IS NOT NULL OR command.billing_scope_id IS NOT NULL OR command.kind IS DISTINCT FROM (CASE WHEN NEW.review->>'kind'='upgrade_estimate' THEN 'upgrade' ELSE 'downgrade' END) OR command.status<>'PREPARED'
   OR ROW(command.requested_by_user_id,command.subscription_id,command.expected_subscription_revision,command.target_plan_key) IS DISTINCT FROM ROW(NEW.actor_id,NEW.subscription_id,NEW.subscription_revision,NEW.target_plan_key)
   OR NEW.expires_at<=clock_timestamp() OR NEW.consumed_at<NEW.created_at OR NEW.consumed_at>clock_timestamp() THEN
   RAISE EXCEPTION 'Plan quote requires its original live plan-change command' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
