CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
CREATE TABLE "subscription_allowance_periods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "subscription_id" uuid NOT NULL,
  "subscription_revision" bigint NOT NULL,
  "stripe_invoice_id" text NOT NULL,
  "plan_key" text NOT NULL,
  "catalog_version" text NOT NULL,
  "period_start" timestamptz NOT NULL,
  "period_end" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "state" text NOT NULL DEFAULT 'open',
  "granted_amount" numeric(16,6) NOT NULL,
  "remaining_amount" numeric(16,6) NOT NULL,
  "expired_amount" numeric(16,6) NOT NULL DEFAULT 0.000000,
  "clawed_back_amount" numeric(16,6) NOT NULL DEFAULT 0.000000,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "subscription_allowance_periods_subscription_tenant_fk" FOREIGN KEY (subscription_id, organization_id) REFERENCES billing_subscriptions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT "subscription_allowance_periods_revision_tenant_fk" FOREIGN KEY (subscription_id, organization_id, subscription_revision) REFERENCES billing_subscription_revisions(subscription_id, organization_id, revision) ON DELETE RESTRICT,
  CONSTRAINT "subscription_allowance_periods_invoice_id_check" CHECK (stripe_invoice_id ~ '^in_[A-Za-z0-9]+$'),
  CONSTRAINT "subscription_allowance_periods_period_check" CHECK (period_end > period_start AND expires_at = period_end),
  CONSTRAINT "subscription_allowance_periods_plan_catalog_check" CHECK (plan_key IN ('plus_monthly','pro_monthly') AND length(btrim(catalog_version)) > 0),
  CONSTRAINT "subscription_allowance_periods_state_check" CHECK (state IN ('open','expired','clawed_back','closed')),
  CONSTRAINT "subscription_allowance_periods_amounts_check" CHECK (granted_amount > 0 AND remaining_amount >= 0 AND expired_amount >= 0 AND clawed_back_amount >= 0 AND remaining_amount + expired_amount + clawed_back_amount <= granted_amount),
  CONSTRAINT "subscription_allowance_periods_terminal_amounts_check" CHECK ((state = 'open') OR (state = 'expired' AND remaining_amount = 0 AND expired_amount > 0) OR (state = 'clawed_back' AND remaining_amount = 0 AND clawed_back_amount > 0) OR (state = 'closed' AND remaining_amount = 0)),
  CONSTRAINT "subscription_allowance_periods_revision_check" CHECK (subscription_revision > 0)
);
CREATE UNIQUE INDEX "subscription_allowance_periods_id_org_idx" ON "subscription_allowance_periods" (id, organization_id);
CREATE UNIQUE INDEX "subscription_allowance_periods_invoice_idx" ON "subscription_allowance_periods" (stripe_invoice_id);
CREATE UNIQUE INDEX "subscription_allowance_periods_period_idx" ON "subscription_allowance_periods" (subscription_id, period_start, period_end);
CREATE INDEX "subscription_allowance_periods_org_period_idx" ON "subscription_allowance_periods" (organization_id, period_end);
--> statement-breakpoint
ALTER TABLE "subscription_allowance_periods" ADD CONSTRAINT "subscription_allowance_periods_no_overlap" EXCLUDE USING gist (subscription_id WITH =, tstzrange(period_start, period_end, '[)') WITH &&);
