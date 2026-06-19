CREATE TABLE "crypto_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"payment_address" text NOT NULL,
	"token_address" text,
	"token" text NOT NULL,
	"network" text NOT NULL,
	"expected_amount" text NOT NULL,
	"received_amount" text,
	"credits_to_add" text NOT NULL,
	"transaction_hash" text,
	"block_number" text,
	"status" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"confirmed_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE "app_builder_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sandbox_session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"files_affected" jsonb DEFAULT '[]'::jsonb,
	"tool_calls" jsonb DEFAULT '[]'::jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "app_sandbox_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"app_id" uuid,
	"sandbox_id" text,
	"sandbox_url" text,
	"status" text DEFAULT 'initializing' NOT NULL,
	"status_message" text,
	"app_name" text,
	"app_description" text,
	"initial_prompt" text,
	"template_type" text DEFAULT 'blank',
	"build_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"claude_session_id" text,
	"claude_messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"workflow_run_id" text,
	"workflow_status" text DEFAULT 'pending',
	"generated_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cpu_seconds_used" integer DEFAULT 0 NOT NULL,
	"memory_mb_peak" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"stopped_at" timestamp,
	"expires_at" timestamp,
	CONSTRAINT "app_sandbox_sessions_sandbox_id_unique" UNIQUE("sandbox_id")
);
--> statement-breakpoint
CREATE TABLE "app_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"preview_image_url" text,
	"git_repo_url" text NOT NULL,
	"git_branch" text DEFAULT 'main',
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"system_prompt" text,
	"example_prompts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_templates_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "crypto_payments" ADD CONSTRAINT "crypto_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crypto_payments" ADD CONSTRAINT "crypto_payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_builder_prompts" ADD CONSTRAINT "app_builder_prompts_sandbox_session_id_app_sandbox_sessions_id_fk" FOREIGN KEY ("sandbox_session_id") REFERENCES "public"."app_sandbox_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_sandbox_sessions" ADD CONSTRAINT "app_sandbox_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_sandbox_sessions" ADD CONSTRAINT "app_sandbox_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_sandbox_sessions" ADD CONSTRAINT "app_sandbox_sessions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crypto_payments_organization_id_idx" ON "crypto_payments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "crypto_payments_user_id_idx" ON "crypto_payments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "crypto_payments_payment_address_idx" ON "crypto_payments" USING btree ("payment_address");--> statement-breakpoint
CREATE INDEX "crypto_payments_status_idx" ON "crypto_payments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "crypto_payments_transaction_hash_unique_idx" ON "crypto_payments" USING btree ("transaction_hash");--> statement-breakpoint
CREATE INDEX "crypto_payments_network_idx" ON "crypto_payments" USING btree ("network");--> statement-breakpoint
CREATE INDEX "crypto_payments_created_at_idx" ON "crypto_payments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "crypto_payments_expires_at_idx" ON "crypto_payments" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "crypto_payments_metadata_gin_idx" ON "crypto_payments" USING gin ("metadata");--> statement-breakpoint
CREATE INDEX "app_builder_prompts_session_idx" ON "app_builder_prompts" USING btree ("sandbox_session_id");--> statement-breakpoint
CREATE INDEX "app_builder_prompts_created_at_idx" ON "app_builder_prompts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "app_sandbox_sessions_user_id_idx" ON "app_sandbox_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "app_sandbox_sessions_org_id_idx" ON "app_sandbox_sessions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "app_sandbox_sessions_app_id_idx" ON "app_sandbox_sessions" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "app_sandbox_sessions_sandbox_id_idx" ON "app_sandbox_sessions" USING btree ("sandbox_id");--> statement-breakpoint
CREATE INDEX "app_sandbox_sessions_status_idx" ON "app_sandbox_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "app_sandbox_sessions_created_at_idx" ON "app_sandbox_sessions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "app_templates_slug_idx" ON "app_templates" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "app_templates_category_idx" ON "app_templates" USING btree ("category");--> statement-breakpoint
CREATE INDEX "app_templates_is_active_idx" ON "app_templates" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "app_templates_is_featured_idx" ON "app_templates" USING btree ("is_featured");