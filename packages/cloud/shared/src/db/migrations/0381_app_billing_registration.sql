-- Only unconfigured registrations are introduced; infrastructure subscriptions and balances are untouched.
CREATE UNIQUE INDEX IF NOT EXISTS apps_billing_owner_idx ON apps(id, organization_id, created_by_user_id);
CREATE TABLE IF NOT EXISTS app_billing_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL,
  owner_organization_id uuid NOT NULL,
  infrastructure_payer_organization_id uuid NOT NULL,
  registered_by_user_id uuid NOT NULL,
  provider_environment text NOT NULL,
  merchant_state text NOT NULL DEFAULT 'unconfigured',
  policy_state text NOT NULL DEFAULT 'unconfigured',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_billing_registrations_owner_fk FOREIGN KEY (app_id, owner_organization_id, registered_by_user_id)
    REFERENCES apps(id, organization_id, created_by_user_id) ON DELETE CASCADE,
  CONSTRAINT app_billing_registrations_state_check CHECK (merchant_state = 'unconfigured' AND policy_state = 'unconfigured'
    AND provider_environment IN ('test','live') AND infrastructure_payer_organization_id = owner_organization_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS app_billing_registrations_app_environment_idx ON app_billing_registrations(app_id, provider_environment);
CREATE UNIQUE INDEX IF NOT EXISTS app_billing_registrations_id_app_idx ON app_billing_registrations(id, app_id);
CREATE TABLE IF NOT EXISTS app_subscriber_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id uuid NOT NULL,
  app_id uuid NOT NULL,
  subscriber_user_id uuid NOT NULL,
  account_kind text NOT NULL DEFAULT 'individual',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_subscriber_accounts_registration_fk FOREIGN KEY (registration_id, app_id)
    REFERENCES app_billing_registrations(id, app_id) ON DELETE CASCADE,
  CONSTRAINT app_subscriber_accounts_consent_fk FOREIGN KEY (app_id, subscriber_user_id)
    REFERENCES app_users(app_id, user_id) ON DELETE CASCADE,
  CONSTRAINT app_subscriber_accounts_kind_check CHECK (account_kind = 'individual')
);
CREATE UNIQUE INDEX IF NOT EXISTS app_subscriber_accounts_subscriber_idx ON app_subscriber_accounts(registration_id, subscriber_user_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_app_billing_identity_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'App billing identity is immutable; transfer and merchant policy are unconfigured';
END $$;
CREATE TRIGGER app_billing_registrations_immutable BEFORE UPDATE ON app_billing_registrations
  FOR EACH ROW EXECUTE FUNCTION reject_app_billing_identity_update();
CREATE TRIGGER app_subscriber_accounts_immutable BEFORE UPDATE ON app_subscriber_accounts
  FOR EACH ROW EXECUTE FUNCTION reject_app_billing_identity_update();
