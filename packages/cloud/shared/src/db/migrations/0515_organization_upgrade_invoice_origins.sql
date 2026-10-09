-- Original-request attribution is separate from generic app results and paid settlement.
CREATE TABLE organization_upgrade_invoice_origins (
 command_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 invoice_id text NOT NULL,
 evidence_kind text NOT NULL,
 provider_event_id text,
 provider_request_id text NOT NULL,
 provider_idempotency_key text NOT NULL,
 customer_id text NOT NULL,
 subscription_id text NOT NULL,
 livemode boolean NOT NULL,
 api_version text NOT NULL,
 invoice_created_at timestamptz NOT NULL,
 event_created_at timestamptz,
 observed_at timestamptz NOT NULL,
 evidence_digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT organization_upgrade_origin_command_fk FOREIGN KEY(command_id,organization_id)
 REFERENCES billing_subscription_commands(id,organization_id) ON DELETE RESTRICT,
 CONSTRAINT organization_upgrade_origin_shape CHECK (
 invoice_id ~ '^in_[A-Za-z0-9]+$'
 AND provider_request_id ~ '^req_[A-Za-z0-9]+$' AND customer_id ~ '^cus_[A-Za-z0-9]+$'
 AND subscription_id ~ '^sub_[A-Za-z0-9]+$' AND length(provider_idempotency_key)>0
 AND api_version='2024-11-20.acacia' AND evidence_digest ~ '^[a-f0-9]{64}$'
 AND observed_at>=invoice_created_at AND created_at>=observed_at
 AND ((evidence_kind='invoice_created_event' AND provider_event_id ~ '^evt_[A-Za-z0-9]+$' AND event_created_at>=invoice_created_at AND observed_at>=event_created_at) OR (evidence_kind='update_response' AND provider_event_id IS NULL AND event_created_at IS NULL)) IS TRUE)
);
--> statement-breakpoint
CREATE INDEX organization_upgrade_origin_tenant_idx ON organization_upgrade_invoice_origins(organization_id,created_at);
CREATE UNIQUE INDEX organization_upgrade_origin_invoice_idx ON organization_upgrade_invoice_origins(livemode,invoice_id);
CREATE UNIQUE INDEX organization_upgrade_origin_event_idx ON organization_upgrade_invoice_origins(livemode,provider_event_id);
--> statement-breakpoint
CREATE FUNCTION guard_organization_upgrade_invoice_origin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command record; quote record; source record;
BEGIN
 SELECT * INTO command FROM billing_subscription_commands WHERE id=NEW.command_id AND organization_id=NEW.organization_id FOR UPDATE;
 IF NOT FOUND OR command.kind<>'upgrade' OR command.app_id IS NOT NULL OR command.billing_scope_id IS NOT NULL
 OR command.merchant_key<>'platform' OR command.organization_upgrade_dispatch_state IS DISTINCT FROM 'started'
 OR command.status<>'OUTCOME_UNKNOWN' OR command.provider_idempotency_key<>NEW.provider_idempotency_key THEN
  RAISE EXCEPTION 'Original upgrade invoice requires its dispatched organization command' USING ERRCODE='23514';
 END IF;
 SELECT * INTO quote FROM organization_plan_change_quotes WHERE consumed_by_command_id=command.id;
 IF NOT FOUND OR quote.provider_binding IS NULL OR ROW(quote.organization_id,quote.actor_id,quote.subscription_id,quote.subscription_revision,quote.target_plan_key)
 IS DISTINCT FROM ROW(command.organization_id,command.requested_by_user_id,command.subscription_id,command.expected_subscription_revision,command.target_plan_key)
 OR (quote.provider_binding->>'livemode')::boolean IS DISTINCT FROM NEW.livemode
 OR NEW.invoice_created_at<to_timestamp((quote.review->>'prorationDate')::bigint) THEN
  RAISE EXCEPTION 'Original upgrade invoice requires the consumed original review' USING ERRCODE='23514';
 END IF;
 SELECT * INTO source FROM billing_subscription_revisions WHERE subscription_id=command.subscription_id
 AND organization_id=command.organization_id AND revision=command.expected_subscription_revision;
 IF NOT FOUND OR source.billing_scope_id IS NOT NULL OR source.merchant_key<>'platform' OR source.provider<>'stripe'
 OR ROW(source.stripe_customer_id,source.stripe_subscription_id,(source.provider_environment='live'))
 IS DISTINCT FROM ROW(NEW.customer_id,NEW.subscription_id,NEW.livemode) OR NEW.observed_at>clock_timestamp() THEN
  RAISE EXCEPTION 'Original upgrade invoice differs from its historical source' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organization_upgrade_invoice_origin_guard BEFORE INSERT ON organization_upgrade_invoice_origins
FOR EACH ROW EXECUTE FUNCTION guard_organization_upgrade_invoice_origin();
CREATE TRIGGER organization_upgrade_invoice_origin_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON organization_upgrade_invoice_origins
FOR EACH STATEMENT EXECUTE FUNCTION reject_subscription_append_only_mutation();
