ALTER TABLE "organization_entitlements" DROP CONSTRAINT IF EXISTS "organization_entitlements_pkey";
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD CONSTRAINT "organization_entitlements_pkey" PRIMARY KEY ("id");
--> statement-breakpoint
ALTER TABLE "billing_subscription_revisions" DROP CONSTRAINT IF EXISTS "billing_subscription_revisions_status_check";
--> statement-breakpoint
ALTER TABLE "billing_subscription_revisions" DROP CONSTRAINT IF EXISTS "billing_subscription_revisions_plan_check";
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" DROP CONSTRAINT IF EXISTS "billing_subscriptions_status_check";
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" DROP CONSTRAINT IF EXISTS "billing_subscriptions_plan_check";
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" DROP CONSTRAINT IF EXISTS "billing_subscription_commands_intent_check";
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" DROP CONSTRAINT IF EXISTS "billing_subscription_commands_status_shape_check";
--> statement-breakpoint
ALTER TABLE "organization_entitlements" DROP CONSTRAINT IF EXISTS "organization_entitlements_plan_state_check";
--> statement-breakpoint
ALTER TABLE "subscription_allowance_periods" DROP CONSTRAINT IF EXISTS "subscription_allowance_periods_invoice_id_check";
--> statement-breakpoint
ALTER TABLE "subscription_allowance_periods" DROP CONSTRAINT IF EXISTS "subscription_allowance_periods_plan_catalog_check";
--> statement-breakpoint
DROP INDEX IF EXISTS "billing_subscription_revisions_provider_event_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "billing_subscriptions_stripe_subscription_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "billing_subscriptions_stripe_item_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "billing_subscriptions_live_org_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "billing_subscription_commands_org_idempotency_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "billing_subscription_commands_provider_idempotency_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "billing_subscription_commands_live_checkout_org_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "billing_subscription_event_receipts_event_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "subscription_billing_fences_provider_event_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "subscription_allowance_periods_invoice_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "subscription_allowance_transactions_source_invoice_idx";
--> statement-breakpoint
ALTER TABLE "subscription_allowance_periods" ALTER COLUMN "stripe_invoice_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "billing_subscription_revisions" ADD CONSTRAINT "billing_subscription_revisions_plan_revision_id_app_billing_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "app_billing_plan_revisions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_subscription_revisions" ADD CONSTRAINT "billing_subscription_revisions_billing_scope_id_organization_id_app_billing_scopes_id_organization_id_fk" FOREIGN KEY ("billing_scope_id","organization_id") REFERENCES "app_billing_scopes"("id","organization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_plan_revision_id_app_billing_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "app_billing_plan_revisions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_billing_scope_id_organization_id_app_billing_scopes_id_organization_id_fk" FOREIGN KEY ("billing_scope_id","organization_id") REFERENCES "app_billing_scopes"("id","organization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_subscription_commands_billing_scope_id_organization_id_app_billing_scopes_id_organization_id_fk" FOREIGN KEY ("billing_scope_id","organization_id") REFERENCES "app_billing_scopes"("id","organization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_subscription_event_receipts" ADD CONSTRAINT "billing_subscription_event_receipts_billing_scope_id_organization_id_app_billing_scopes_id_organization_id_fk" FOREIGN KEY ("billing_scope_id","organization_id") REFERENCES "app_billing_scopes"("id","organization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_subscription_incidents" ADD CONSTRAINT "billing_subscription_incidents_billing_scope_id_organization_id_app_billing_scopes_id_organization_id_fk" FOREIGN KEY ("billing_scope_id","organization_id") REFERENCES "app_billing_scopes"("id","organization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_billing_fences" ADD CONSTRAINT "subscription_billing_fences_billing_scope_id_organization_id_app_billing_scopes_id_organization_id_fk" FOREIGN KEY ("billing_scope_id","organization_id") REFERENCES "app_billing_scopes"("id","organization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD CONSTRAINT "organization_entitlements_billing_scope_id_organization_id_app_billing_scopes_id_organization_id_fk" FOREIGN KEY ("billing_scope_id","organization_id") REFERENCES "app_billing_scopes"("id","organization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_allowance_periods" ADD CONSTRAINT "subscription_allowance_periods_billing_scope_id_organization_id_app_billing_scopes_id_organization_id_fk" FOREIGN KEY ("billing_scope_id","organization_id") REFERENCES "app_billing_scopes"("id","organization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_allowance_transactions" ADD CONSTRAINT "subscription_allowance_transactions_billing_scope_id_organization_id_app_billing_scopes_id_organization_id_fk" FOREIGN KEY ("billing_scope_id","organization_id") REFERENCES "app_billing_scopes"("id","organization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_funding_allocations" ADD CONSTRAINT "billing_funding_allocations_billing_scope_id_organization_id_app_billing_scopes_id_organization_id_fk" FOREIGN KEY ("billing_scope_id","organization_id") REFERENCES "app_billing_scopes"("id","organization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_funding_reservations" ADD CONSTRAINT "billing_funding_reservations_billing_scope_id_organization_id_app_billing_scopes_id_organization_id_fk" FOREIGN KEY ("billing_scope_id","organization_id") REFERENCES "app_billing_scopes"("id","organization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_live_scope_idx" ON "billing_subscriptions" USING btree ("billing_scope_id") WHERE "billing_subscriptions"."billing_scope_id" IS NOT NULL AND "billing_subscriptions"."status" IN ('pending','incomplete','trialing','active','grace','past_due','unpaid','paused');
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscription_commands_scope_idempotency_idx" ON "billing_subscription_commands" USING btree ("billing_scope_id","idempotency_key") WHERE "billing_subscription_commands"."billing_scope_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscription_commands_live_scope_idx" ON "billing_subscription_commands" USING btree ("billing_scope_id") WHERE "billing_subscription_commands"."billing_scope_id" IS NOT NULL AND "billing_subscription_commands"."kind" = 'checkout' AND "billing_subscription_commands"."status" IN ('PREPARED','OUTCOME_UNKNOWN','SUCCEEDED');
--> statement-breakpoint
CREATE UNIQUE INDEX "organization_entitlements_legacy_org_idx" ON "organization_entitlements" USING btree ("organization_id") WHERE "organization_entitlements"."billing_scope_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "organization_entitlements_scope_idx" ON "organization_entitlements" USING btree ("billing_scope_id") WHERE "organization_entitlements"."billing_scope_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscription_revisions_provider_event_idx" ON "billing_subscription_revisions" USING btree ("merchant_key","provider","provider_environment","provider_event_id") WHERE "billing_subscription_revisions"."provider_event_id" IS NOT NULL;
