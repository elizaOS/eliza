ALTER TABLE app_billing_members ADD COLUMN livemode boolean;
--> statement-breakpoint
DROP INDEX app_billing_members_member_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX app_billing_members_member_idx ON app_billing_members(billing_account_id,user_id) WHERE livemode IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX app_billing_members_environment_idx ON app_billing_members(billing_account_id,user_id,livemode) WHERE livemode IS NOT NULL;
--> statement-breakpoint
CREATE TABLE app_billing_membership_states (
  billing_account_id uuid NOT NULL, app_id uuid NOT NULL, livemode boolean NOT NULL, revision bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (billing_account_id,livemode),
  CONSTRAINT app_billing_membership_states_account_fk FOREIGN KEY (billing_account_id,app_id) REFERENCES app_billing_accounts(id,app_id) ON DELETE RESTRICT,
  CONSTRAINT app_billing_membership_states_revision_check CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE TABLE app_billing_membership_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), app_id uuid NOT NULL, billing_account_id uuid NOT NULL, livemode boolean NOT NULL,
  client_registration_id uuid NOT NULL REFERENCES app_client_registrations(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL, request_digest text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_billing_membership_operations_account_fk FOREIGN KEY (billing_account_id,app_id) REFERENCES app_billing_accounts(id,app_id) ON DELETE RESTRICT,
  CONSTRAINT app_billing_membership_operations_digest_check CHECK (request_digest ~ '^[0-9a-f]{64}$' AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX app_billing_membership_operations_key_idx ON app_billing_membership_operations(billing_account_id,livemode,idempotency_key);
--> statement-breakpoint
CREATE FUNCTION validate_app_billing_membership_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_client_registrations c WHERE c.id=NEW.client_registration_id AND c.app_id=NEW.app_id AND (c.billing_environment='live')=NEW.livemode) THEN RAISE EXCEPTION 'Membership operation registration scope mismatch'; END IF;
  IF NOT COALESCE(NEW.result->>'appId'=NEW.app_id::text AND NEW.result->>'billingAccountId'=NEW.billing_account_id::text AND NEW.result->>'environment'=CASE WHEN NEW.livemode THEN 'live' ELSE 'test' END,false) THEN RAISE EXCEPTION 'Membership result scope mismatch'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER app_billing_membership_operations_scope BEFORE INSERT ON app_billing_membership_operations FOR EACH ROW EXECUTE FUNCTION validate_app_billing_membership_operation();
--> statement-breakpoint
CREATE TRIGGER app_billing_membership_operations_immutable BEFORE UPDATE OR DELETE ON app_billing_membership_operations FOR EACH ROW EXECUTE FUNCTION reject_subscription_append_only_mutation();
