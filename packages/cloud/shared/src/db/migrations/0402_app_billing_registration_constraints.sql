CREATE UNIQUE INDEX "app_billing_accounts_app_key_idx" ON "app_billing_accounts" USING btree ("app_id","external_account_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "app_billing_accounts_id_app_idx" ON "app_billing_accounts" USING btree ("id","app_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "app_billing_customers_binding_idx" ON "app_billing_customers" USING btree ("billing_account_id","merchant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "app_billing_customers_provider_idx" ON "app_billing_customers" USING btree ("merchant_id","stripe_customer_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "app_billing_members_member_idx" ON "app_billing_members" USING btree ("billing_account_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "app_billing_plan_revisions_key_idx" ON "app_billing_plan_revisions" USING btree ("app_id","product_family_key","plan_key","revision");
--> statement-breakpoint
CREATE UNIQUE INDEX "app_billing_plan_revisions_scope_idx" ON "app_billing_plan_revisions" USING btree ("id","app_id","merchant_id","product_family_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "app_billing_scopes_id_app_mode_idx" ON "app_billing_scopes" USING btree ("id","app_id","livemode");
--> statement-breakpoint
CREATE UNIQUE INDEX "app_billing_scopes_family_idx" ON "app_billing_scopes" USING btree ("billing_account_id","product_family_key","livemode");
--> statement-breakpoint
CREATE UNIQUE INDEX "app_billing_scopes_id_org_idx" ON "app_billing_scopes" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "app_billing_scopes_identity_idx" ON "app_billing_scopes" USING btree ("id","app_id","merchant_id","product_family_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "app_billing_seats_active_subject_idx" ON "app_billing_seats" USING btree ("billing_scope_id","subject") WHERE "app_billing_seats"."revoked_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "app_billing_seats_operation_idx" ON "app_billing_seats" USING btree ("billing_scope_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "app_subscription_outbox_transition_idx" ON "app_subscription_outbox" USING btree ("subscription_id","subscription_revision","kind");
--> statement-breakpoint
CREATE UNIQUE INDEX "app_subscription_paid_periods_invoice_idx" ON "app_subscription_paid_periods" USING btree ("merchant_key","livemode","stripe_invoice_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "app_subscription_trials_eligibility_idx" ON "app_subscription_trials" USING btree ("app_id","eligibility_principal_id","livemode");
--> statement-breakpoint
CREATE UNIQUE INDEX "app_subscription_trials_command_idx" ON "app_subscription_trials" USING btree ("command_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_merchants_id_mode_idx" ON "billing_merchants" USING btree ("id","livemode");
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_merchants_account_mode_idx" ON "billing_merchants" USING btree ("provider_account_key","livemode");
--> statement-breakpoint
ALTER TABLE "app_billing_accounts" ADD CONSTRAINT "app_billing_accounts_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_billing_accounts" ADD CONSTRAINT "app_billing_accounts_eligibility_principal_id_users_id_fk" FOREIGN KEY ("eligibility_principal_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_billing_customers" ADD CONSTRAINT "app_billing_customers_billing_account_id_app_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "app_billing_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_billing_customers" ADD CONSTRAINT "app_billing_customers_merchant_id_billing_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "billing_merchants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_billing_members" ADD CONSTRAINT "app_billing_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_billing_members" ADD CONSTRAINT "app_billing_members_account_fk" FOREIGN KEY ("billing_account_id","app_id") REFERENCES "app_billing_accounts"("id","app_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_billing_plan_revisions" ADD CONSTRAINT "app_billing_plan_revisions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_billing_plan_revisions" ADD CONSTRAINT "app_billing_plan_revisions_merchant_id_billing_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "billing_merchants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_billing_scopes" ADD CONSTRAINT "app_billing_scopes_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_billing_scopes" ADD CONSTRAINT "app_billing_scopes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_billing_scopes" ADD CONSTRAINT "app_billing_scopes_merchant_id_billing_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "billing_merchants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_billing_scopes" ADD CONSTRAINT "app_billing_scopes_merchant_mode_fk" FOREIGN KEY ("merchant_id","livemode") REFERENCES "billing_merchants"("id","livemode") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_billing_scopes" ADD CONSTRAINT "app_billing_scopes_account_fk" FOREIGN KEY ("billing_account_id","app_id") REFERENCES "app_billing_accounts"("id","app_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_billing_seats" ADD CONSTRAINT "app_billing_seats_billing_scope_id_app_billing_scopes_id_fk" FOREIGN KEY ("billing_scope_id") REFERENCES "app_billing_scopes"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_subscription_outbox" ADD CONSTRAINT "app_subscription_outbox_billing_scope_id_app_billing_scopes_id_fk" FOREIGN KEY ("billing_scope_id") REFERENCES "app_billing_scopes"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_subscription_paid_periods" ADD CONSTRAINT "app_subscription_paid_periods_billing_scope_id_app_billing_scopes_id_fk" FOREIGN KEY ("billing_scope_id") REFERENCES "app_billing_scopes"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_subscription_paid_periods" ADD CONSTRAINT "app_subscription_paid_periods_plan_revision_id_app_billing_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "app_billing_plan_revisions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_subscription_trials" ADD CONSTRAINT "app_subscription_trials_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_subscription_trials" ADD CONSTRAINT "app_subscription_trials_eligibility_principal_id_users_id_fk" FOREIGN KEY ("eligibility_principal_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_subscription_trials" ADD CONSTRAINT "app_subscription_trials_billing_scope_id_app_billing_scopes_id_fk" FOREIGN KEY ("billing_scope_id") REFERENCES "app_billing_scopes"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_subscription_trials" ADD CONSTRAINT "app_subscription_trials_plan_revision_id_app_billing_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "app_billing_plan_revisions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_subscription_trials" ADD CONSTRAINT "app_subscription_trials_scope_mode_fk" FOREIGN KEY ("billing_scope_id","app_id","livemode") REFERENCES "app_billing_scopes"("id","app_id","livemode") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_merchants" ADD CONSTRAINT "billing_merchants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict ON UPDATE no action;
