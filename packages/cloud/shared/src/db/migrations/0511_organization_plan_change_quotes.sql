-- Server-observed upgrade reviews, separate from app-buyer and checkout payloads.
CREATE TABLE organization_plan_change_quotes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL REFERENCES billing_identity_subjects(id) ON DELETE RESTRICT,
 subscription_id uuid NOT NULL,
 subscription_revision bigint NOT NULL,
 target_plan_key text NOT NULL,
 catalog_version text NOT NULL,
 source_digest text NOT NULL,
 review_digest text NOT NULL,
 review jsonb NOT NULL,
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 consumed_by_command_id uuid,
 consumed_at timestamptz,
 CONSTRAINT organization_plan_quote_source_fk FOREIGN KEY(subscription_id,organization_id)
 REFERENCES billing_subscriptions(id,organization_id) ON DELETE RESTRICT,
 CONSTRAINT organization_plan_quote_command_fk FOREIGN KEY(consumed_by_command_id,organization_id)
 REFERENCES billing_subscription_commands(id,organization_id) ON DELETE RESTRICT,
 CONSTRAINT organization_plan_quote_shape CHECK(subscription_revision>0
 AND target_plan_key IN ('plus_monthly','pro_monthly')
 AND source_digest ~ '^[a-f0-9]{64}$' AND review_digest ~ '^[a-f0-9]{64}$'
 AND expires_at>created_at AND (consumed_by_command_id IS NULL)=(consumed_at IS NULL))
);
--> statement-breakpoint
CREATE INDEX organization_plan_quote_tenant_idx ON organization_plan_change_quotes(organization_id,created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX organization_plan_quote_consumed_idx ON organization_plan_change_quotes(consumed_by_command_id) WHERE consumed_by_command_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER organization_plan_quote_identity BEFORE INSERT ON organization_plan_change_quotes FOR EACH ROW EXECUTE FUNCTION anchor_billing_identity('actor_id','actor');
--> statement-breakpoint
CREATE FUNCTION guard_organization_plan_quote() RETURNS trigger LANGUAGE plpgsql AS $$
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
 OR (NEW.review->>'kind') IS DISTINCT FROM 'upgrade_estimate'
 OR (NEW.review->>'subscriptionId') IS DISTINCT FROM NEW.subscription_id::text
 OR (NEW.review->>'expectedSubscriptionRevision') IS DISTINCT FROM NEW.subscription_revision::text
 OR (NEW.review->>'sourcePlanKey') IS DISTINCT FROM source.plan_key
 OR (NEW.review->>'targetPlanKey') IS DISTINCT FROM NEW.target_plan_key
 OR (NEW.review->>'catalogVersion') IS DISTINCT FROM NEW.catalog_version
 OR (NEW.review->>'expiresAt')::timestamptz IS DISTINCT FROM NEW.expires_at THEN
  RAISE EXCEPTION 'Plan quote source mismatch' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' AND (NEW.consumed_by_command_id IS NOT NULL OR NEW.expires_at<=clock_timestamp() OR NEW.created_at>clock_timestamp()) THEN
  RAISE EXCEPTION 'New plan quote must be live and unconsumed' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.consumed_by_command_id IS NULL AND NEW.consumed_by_command_id IS NOT NULL THEN
  SELECT * INTO command FROM billing_subscription_commands WHERE id=NEW.consumed_by_command_id AND organization_id=NEW.organization_id;
  IF NOT FOUND OR command.app_id IS NOT NULL OR command.billing_scope_id IS NOT NULL OR command.kind<>'upgrade' OR command.status<>'PREPARED'
   OR ROW(command.requested_by_user_id,command.subscription_id,command.expected_subscription_revision,command.target_plan_key) IS DISTINCT FROM ROW(NEW.actor_id,NEW.subscription_id,NEW.subscription_revision,NEW.target_plan_key)
   OR NEW.expires_at<=clock_timestamp() OR NEW.consumed_at<NEW.created_at OR NEW.consumed_at>clock_timestamp() THEN
   RAISE EXCEPTION 'Plan quote requires its original live upgrade command' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organization_plan_quote_guard BEFORE INSERT OR UPDATE OR DELETE ON organization_plan_change_quotes FOR EACH ROW EXECUTE FUNCTION guard_organization_plan_quote();
