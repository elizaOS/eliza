-- Backfilled anchors retain actor and eligibility UUIDs after personal identity erasure.
ALTER TABLE "app_billing_accounts" DROP CONSTRAINT IF EXISTS "app_billing_accounts_eligibility_principal_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "app_subscription_trials" DROP CONSTRAINT IF EXISTS "app_subscription_trials_eligibility_principal_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" DROP CONSTRAINT IF EXISTS "billing_subscription_commands_requested_by_user_id_users_id_fk";
--> statement-breakpoint
-- The applied subscription migration used PostgreSQL's inline-FK name.
ALTER TABLE "billing_subscription_commands" DROP CONSTRAINT IF EXISTS "billing_subscription_commands_requested_by_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "app_billing_quotes" DROP CONSTRAINT IF EXISTS "app_billing_quotes_actor_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "app_billing_membership_operations" DROP CONSTRAINT IF EXISTS "app_billing_membership_operations_actor_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "app_billing_accounts" ADD CONSTRAINT "app_billing_accounts_eligibility_principal_id_billing_eligibility_principals_id_fk" FOREIGN KEY ("eligibility_principal_id") REFERENCES "public"."billing_eligibility_principals"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_subscription_trials" ADD CONSTRAINT "app_subscription_trials_eligibility_principal_id_billing_eligibility_principals_id_fk" FOREIGN KEY ("eligibility_principal_id") REFERENCES "public"."billing_eligibility_principals"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_subscription_commands_requested_by_user_id_billing_identity_subjects_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."billing_identity_subjects"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_billing_quotes" ADD CONSTRAINT "app_billing_quotes_actor_user_id_billing_identity_subjects_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."billing_identity_subjects"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_billing_membership_operations" ADD CONSTRAINT "app_billing_membership_operations_actor_user_id_billing_identity_subjects_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."billing_identity_subjects"("id") ON DELETE restrict ON UPDATE no action;
