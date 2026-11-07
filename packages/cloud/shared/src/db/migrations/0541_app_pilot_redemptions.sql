-- Sponsored pilot admission is separate from Stripe subscription/payment authority.
-- This ledger does not itself publish entitlements or spendable allowance.
CREATE TABLE app_pilot_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE RESTRICT,
  plan_revision_id uuid NOT NULL REFERENCES app_billing_plan_revisions(id) ON DELETE RESTRICT,
  livemode boolean NOT NULL,
  code_digest text NOT NULL CHECK (code_digest ~ '^[0-9a-f]{64}$'),
  maximum_redemptions integer NOT NULL CHECK (maximum_redemptions > 0),
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL CHECK (closes_at > opens_at),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, livemode, code_digest)
);
--> statement-breakpoint
CREATE TABLE app_pilot_invitations (
  campaign_id uuid NOT NULL REFERENCES app_pilot_campaigns(id) ON DELETE RESTRICT,
  eligibility_principal_id uuid NOT NULL REFERENCES billing_eligibility_principals(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, eligibility_principal_id)
);
--> statement-breakpoint
CREATE TABLE app_pilot_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES app_pilot_campaigns(id) ON DELETE RESTRICT,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE RESTRICT,
  livemode boolean NOT NULL,
  eligibility_principal_id uuid NOT NULL REFERENCES billing_eligibility_principals(id) ON DELETE RESTRICT,
  billing_scope_id uuid NOT NULL REFERENCES app_billing_scopes(id) ON DELETE RESTRICT,
  plan_revision_id uuid NOT NULL REFERENCES app_billing_plan_revisions(id) ON DELETE RESTRICT,
  redeemed_by_user_id uuid NOT NULL REFERENCES billing_identity_subjects(id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (app_id, livemode, eligibility_principal_id),
  FOREIGN KEY (campaign_id, eligibility_principal_id)
    REFERENCES app_pilot_invitations(campaign_id, eligibility_principal_id) ON DELETE RESTRICT,
  CHECK (ends_at = ((starts_at AT TIME ZONE 'UTC') + interval '6 months') AT TIME ZONE 'UTC')
);
--> statement-breakpoint
CREATE INDEX app_pilot_redemptions_scope_idx ON app_pilot_redemptions(billing_scope_id);
CREATE INDEX app_pilot_redemptions_campaign_idx ON app_pilot_redemptions(campaign_id);
--> statement-breakpoint
CREATE FUNCTION guard_app_pilot_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Pilot history cannot be deleted';
  END IF;
  IF (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at')
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'Pilot terms are immutable; revocation cannot be undone';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER app_pilot_campaigns_immutable BEFORE UPDATE OR DELETE ON app_pilot_campaigns
  FOR EACH ROW EXECUTE FUNCTION guard_app_pilot_record();
CREATE TRIGGER app_pilot_invitations_immutable BEFORE UPDATE OR DELETE ON app_pilot_invitations
  FOR EACH ROW EXECUTE FUNCTION guard_app_pilot_record();
CREATE TRIGGER app_pilot_redemptions_immutable BEFORE UPDATE OR DELETE ON app_pilot_redemptions
  FOR EACH ROW EXECUTE FUNCTION guard_app_pilot_record();
