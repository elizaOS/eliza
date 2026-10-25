-- Retain reviewed renewal terms independently of legacy organization and app command payloads.
CREATE TABLE billing_subscription_renewal_reviews (
 command_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 payload jsonb NOT NULL,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT billing_renewal_review_command_tenant_fk FOREIGN KEY(command_id,organization_id)
  REFERENCES billing_subscription_commands(id,organization_id) ON DELETE RESTRICT,
 CONSTRAINT billing_renewal_review_payload_check CHECK ((jsonb_typeof(payload)='object'
  AND payload->>'kind'='renewal_estimate' AND payload->>'termsDigest' ~ '^[a-f0-9]{64}$'
  AND payload->>'expectedSubscriptionRevision' ~ '^[1-9][0-9]*$') IS TRUE)
);
--> statement-breakpoint
CREATE INDEX billing_renewal_review_tenant_idx ON billing_subscription_renewal_reviews(organization_id,command_id);
--> statement-breakpoint
CREATE FUNCTION guard_subscription_renewal_review_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command record;
BEGIN
 IF TG_OP <> 'INSERT' THEN
  RAISE EXCEPTION 'Reviewed renewal terms are immutable' USING ERRCODE='23514';
 END IF;
 SELECT * INTO command FROM billing_subscription_commands
 WHERE id=NEW.command_id AND organization_id=NEW.organization_id FOR UPDATE;
 IF NOT FOUND OR command.kind <> 'resume' OR command.app_id IS NOT NULL
  OR command.billing_scope_id IS NOT NULL OR command.status <> 'PREPARED'
  OR (NEW.payload->>'subscriptionId') IS DISTINCT FROM command.subscription_id::text
  OR (NEW.payload->>'expectedSubscriptionRevision') IS DISTINCT FROM command.expected_subscription_revision::text
  OR (NEW.payload->>'expiresAt')::timestamptz IS DISTINCT FROM NEW.expires_at
 THEN RAISE EXCEPTION 'Reviewed renewal terms require matching prepared organization undo' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER billing_renewal_review_receipt_guard BEFORE INSERT OR UPDATE OR DELETE
 ON billing_subscription_renewal_reviews FOR EACH ROW EXECUTE FUNCTION guard_subscription_renewal_review_receipt();
