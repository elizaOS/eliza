-- Authenticated historical target evidence is separate from current subscription authority.
CREATE TABLE organization_upgrade_historical_targets (
 command_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 provider_event_id text NOT NULL,
 event_type text NOT NULL,
 api_version text NOT NULL,
 livemode boolean NOT NULL,
 invoice_id text NOT NULL,
 event_created_at timestamptz NOT NULL,
 observed_at timestamptz NOT NULL,
 evidence_digest text NOT NULL,
 raw_subscription jsonb NOT NULL,
 CONSTRAINT organization_upgrade_target_command_fk FOREIGN KEY(command_id,organization_id)
 REFERENCES billing_subscription_commands(id,organization_id) ON DELETE RESTRICT,
 CONSTRAINT organization_upgrade_target_origin_fk FOREIGN KEY(command_id)
 REFERENCES organization_upgrade_invoice_origins(command_id) ON DELETE RESTRICT,
 CONSTRAINT organization_upgrade_target_shape CHECK (
 provider_event_id ~ '^evt_[A-Za-z0-9]+$' AND invoice_id ~ '^in_[A-Za-z0-9]+$'
 AND event_type IN ('customer.subscription.updated','customer.subscription.pending_update_applied')
 AND api_version='2024-11-20.acacia'
 AND evidence_digest ~ '^[a-f0-9]{64}$' AND observed_at>=event_created_at
 AND jsonb_typeof(raw_subscription)='object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX organization_upgrade_target_event_idx ON organization_upgrade_historical_targets(livemode,provider_event_id);
CREATE INDEX organization_upgrade_target_tenant_idx ON organization_upgrade_historical_targets(organization_id,observed_at);
--> statement-breakpoint
CREATE FUNCTION guard_organization_upgrade_historical_target() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command record; origin record; source record; quote record;
BEGIN
 SELECT * INTO command FROM billing_subscription_commands WHERE id=NEW.command_id AND organization_id=NEW.organization_id FOR UPDATE;
 IF NOT FOUND OR command.kind<>'upgrade' OR command.app_id IS NOT NULL OR command.billing_scope_id IS NOT NULL
 OR command.merchant_key<>'platform' OR command.organization_upgrade_dispatch_state IS DISTINCT FROM 'started'
 OR command.status NOT IN ('OUTCOME_UNKNOWN','APPLIED') THEN
 RAISE EXCEPTION 'Historical target requires original dispatched organization upgrade' USING ERRCODE='23514'; END IF;
 SELECT * INTO origin FROM organization_upgrade_invoice_origins WHERE command_id=command.id AND organization_id=command.organization_id;
 IF NOT FOUND OR ROW(origin.invoice_id,origin.livemode) IS DISTINCT FROM ROW(NEW.invoice_id,NEW.livemode)
 OR NEW.event_created_at<origin.invoice_created_at OR NEW.observed_at>clock_timestamp() THEN
 RAISE EXCEPTION 'Historical target requires original invoice origin' USING ERRCODE='23514'; END IF;
 SELECT * INTO source FROM billing_subscription_revisions WHERE subscription_id=command.subscription_id AND organization_id=command.organization_id AND revision=command.expected_subscription_revision;
 SELECT * INTO quote FROM organization_plan_change_quotes WHERE consumed_by_command_id=command.id AND organization_id=command.organization_id;
 IF source.id IS NULL OR quote.id IS NULL OR source.billing_scope_id IS NOT NULL OR source.merchant_key<>'platform'
 OR (NEW.event_created_at>=to_timestamp((quote.review->>'prorationDate')::bigint)
 AND NEW.event_created_at<source.current_period_end
 AND NEW.raw_subscription->>'id'=source.stripe_subscription_id
 AND NEW.raw_subscription->>'customer'=source.stripe_customer_id
 AND NEW.raw_subscription->>'latest_invoice'=origin.invoice_id
 AND (NEW.raw_subscription->>'livemode')::boolean=origin.livemode
 AND NEW.raw_subscription->>'status'='active'
 AND NEW.raw_subscription->'pending_update'='null'::jsonb
 AND (NEW.raw_subscription->>'cancel_at_period_end')::boolean=false
 AND to_timestamp((NEW.raw_subscription->>'current_period_start')::bigint)=source.current_period_start
 AND to_timestamp((NEW.raw_subscription->>'current_period_end')::bigint)=source.current_period_end
 AND NEW.raw_subscription#>>'{items,data,0,id}'=source.stripe_subscription_item_id
 AND NEW.raw_subscription#>>'{items,data,0,price,id}'=quote.provider_binding->>'targetPriceId') IS NOT TRUE THEN
 RAISE EXCEPTION 'Historical target differs from original reviewed period and target' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organization_upgrade_target_guard BEFORE INSERT ON organization_upgrade_historical_targets
FOR EACH ROW EXECUTE FUNCTION guard_organization_upgrade_historical_target();
CREATE TRIGGER organization_upgrade_target_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON organization_upgrade_historical_targets
FOR EACH STATEMENT EXECUTE FUNCTION reject_subscription_append_only_mutation();
