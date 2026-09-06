ALTER TABLE "billing_subscription_commands" DROP CONSTRAINT "billing_subscription_commands_intent_check";
--> statement-breakpoint
DROP INDEX "billing_subscription_commands_org_idempotency_idx";
--> statement-breakpoint
DROP INDEX "billing_subscription_commands_live_checkout_org_idx";
--> statement-breakpoint
DROP INDEX "billing_subscription_commands_live_scope_idx";
--> statement-breakpoint
ALTER TABLE "app_billing_accounts" ADD COLUMN "external_reference" text;
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD COLUMN "app_id" uuid;
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD COLUMN "livemode" boolean;
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD COLUMN "merchant_id" uuid;
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD COLUMN "client_registration_id" uuid;
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD COLUMN "request_payload" jsonb;
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD COLUMN "provider_result" jsonb;
--> statement-breakpoint
UPDATE billing_subscription_commands c SET app_id = s.app_id, livemode = s.livemode, merchant_id = s.merchant_id FROM app_billing_scopes s WHERE c.billing_scope_id = s.id;
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_subscription_commands_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_commands_scope_app_mode_fk" FOREIGN KEY ("billing_scope_id","app_id","livemode") REFERENCES "app_billing_scopes"("id","app_id","livemode") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_commands_merchant_mode_fk" FOREIGN KEY ("merchant_id","livemode") REFERENCES "billing_merchants"("id","livemode") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_commands_registration_app_fk" FOREIGN KEY ("client_registration_id","app_id") REFERENCES "app_client_registrations"("id","app_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_commands_admin_idempotency_idx" ON "billing_subscription_commands" USING btree ("app_id","livemode","idempotency_key") WHERE "billing_subscription_commands"."billing_scope_id" IS NULL AND "billing_subscription_commands"."app_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscription_commands_org_idempotency_idx" ON "billing_subscription_commands" USING btree ("organization_id","idempotency_key") WHERE "billing_subscription_commands"."billing_scope_id" IS NULL AND "billing_subscription_commands"."app_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscription_commands_live_checkout_org_idx" ON "billing_subscription_commands" USING btree ("organization_id") WHERE "billing_subscription_commands"."billing_scope_id" IS NULL AND "billing_subscription_commands"."app_id" IS NULL AND "billing_subscription_commands"."kind" = 'checkout' AND "billing_subscription_commands"."status" IN ('PREPARED','OUTCOME_UNKNOWN','SUCCEEDED');
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscription_commands_live_scope_idx" ON "billing_subscription_commands" USING btree ("billing_scope_id") WHERE "billing_subscription_commands"."billing_scope_id" IS NOT NULL AND "billing_subscription_commands"."kind" IN ('checkout','upgrade','downgrade','cancel','resume') AND "billing_subscription_commands"."status" IN ('PREPARED','OUTCOME_UNKNOWN','SUCCEEDED');
--> statement-breakpoint
ALTER TABLE "app_billing_accounts" ADD CONSTRAINT "app_billing_accounts_external_reference_check" CHECK ("app_billing_accounts"."external_reference" IS NULL OR length(btrim("app_billing_accounts"."external_reference")) BETWEEN 1 AND 200);
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_commands_app_identity_check" CHECK (("billing_subscription_commands"."app_id" IS NULL AND "billing_subscription_commands"."livemode" IS NULL AND "billing_subscription_commands"."merchant_id" IS NULL AND "billing_subscription_commands"."client_registration_id" IS NULL AND "billing_subscription_commands"."request_payload" IS NULL AND "billing_subscription_commands"."provider_result" IS NULL AND "billing_subscription_commands"."billing_scope_id" IS NULL) OR ("billing_subscription_commands"."app_id" IS NOT NULL AND "billing_subscription_commands"."livemode" IS NOT NULL AND ("billing_subscription_commands"."billing_scope_id" IS NULL OR "billing_subscription_commands"."merchant_id" IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_subscription_commands_intent_check" CHECK (("billing_subscription_commands"."kind" = 'checkout' AND "billing_subscription_commands"."subscription_id" IS NULL AND "billing_subscription_commands"."expected_subscription_revision" IS NULL AND "billing_subscription_commands"."target_plan_key" IS NOT NULL AND ("billing_subscription_commands"."billing_scope_id" IS NOT NULL AND "billing_subscription_commands"."target_plan_revision_id" IS NOT NULL OR "billing_subscription_commands"."target_plan_key" IN ('plus_monthly','pro_monthly'))) OR ("billing_subscription_commands"."kind" IN ('upgrade','downgrade') AND "billing_subscription_commands"."subscription_id" IS NOT NULL AND "billing_subscription_commands"."expected_subscription_revision" > 0 AND "billing_subscription_commands"."target_plan_key" IS NOT NULL AND ("billing_subscription_commands"."billing_scope_id" IS NOT NULL AND "billing_subscription_commands"."target_plan_revision_id" IS NOT NULL OR "billing_subscription_commands"."target_plan_key" IN ('plus_monthly','pro_monthly'))) OR ("billing_subscription_commands"."kind" IN ('cancel','resume') AND "billing_subscription_commands"."subscription_id" IS NOT NULL AND "billing_subscription_commands"."expected_subscription_revision" > 0 AND "billing_subscription_commands"."target_plan_key" IS NULL) OR ("billing_subscription_commands"."app_id" IS NOT NULL AND "billing_subscription_commands"."kind" IN ('portal','expire_checkout') AND "billing_subscription_commands"."target_plan_key" IS NULL AND "billing_subscription_commands"."target_plan_revision_id" IS NULL AND (("billing_subscription_commands"."subscription_id" IS NULL AND "billing_subscription_commands"."expected_subscription_revision" IS NULL) OR ("billing_subscription_commands"."subscription_id" IS NOT NULL AND "billing_subscription_commands"."expected_subscription_revision" > 0))) OR ("billing_subscription_commands"."app_id" IS NOT NULL AND "billing_subscription_commands"."billing_scope_id" IS NULL AND "billing_subscription_commands"."kind" IN ('merchant_create','merchant_adopt','merchant_platform','merchant_onboarding','plan_create','plan_adopt') AND "billing_subscription_commands"."subscription_id" IS NULL AND "billing_subscription_commands"."expected_subscription_revision" IS NULL AND "billing_subscription_commands"."target_plan_key" IS NULL AND "billing_subscription_commands"."target_plan_revision_id" IS NULL));
