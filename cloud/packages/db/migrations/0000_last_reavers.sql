CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE "public"."share_type" AS ENUM('app_share', 'character_share', 'invite_share');--> statement-breakpoint
CREATE TYPE "public"."social_platform" AS ENUM('x', 'farcaster', 'telegram', 'discord');--> statement-breakpoint
CREATE TYPE "public"."mcp_pricing_type" AS ENUM('free', 'credits', 'x402');--> statement-breakpoint
CREATE TYPE "public"."mcp_status" AS ENUM('draft', 'pending_review', 'live', 'suspended', 'deprecated');--> statement-breakpoint
CREATE TYPE "public"."redemption_network" AS ENUM('ethereum', 'base', 'bnb', 'solana');--> statement-breakpoint
CREATE TYPE "public"."redemption_status" AS ENUM('pending', 'approved', 'processing', 'completed', 'failed', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."earnings_source" AS ENUM('miniapp', 'agent', 'mcp');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('earning', 'redemption', 'adjustment', 'refund');--> statement-breakpoint
CREATE TYPE "public"."admin_role" AS ENUM('super_admin', 'moderator', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."moderation_action" AS ENUM('refused', 'warned', 'flagged_for_ban', 'banned');--> statement-breakpoint
CREATE TYPE "public"."user_mod_status" AS ENUM('clean', 'warned', 'spammer', 'scammer', 'banned');--> statement-breakpoint
CREATE TYPE "public"."agent_flag_type" AS ENUM('csam', 'self_harm', 'spam', 'scam', 'harassment', 'copyright', 'malware', 'other');--> statement-breakpoint
CREATE TYPE "public"."agent_reputation_status" AS ENUM('new', 'trusted', 'warned', 'restricted', 'banned');--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"credit_balance" numeric(10, 2) DEFAULT '100.00' NOT NULL,
	"webhook_url" text,
	"webhook_secret" text,
	"stripe_customer_id" text,
	"billing_email" text,
	"tax_id_type" text,
	"tax_id_value" text,
	"billing_address" jsonb,
	"stripe_payment_method_id" text,
	"stripe_default_payment_method" text,
	"auto_top_up_enabled" boolean DEFAULT false NOT NULL,
	"auto_top_up_amount" numeric(10, 2),
	"auto_top_up_threshold" numeric(10, 2) DEFAULT '0.00',
	"auto_top_up_subscription_id" text,
	"max_api_requests" integer DEFAULT 1000,
	"max_tokens_per_request" integer,
	"allowed_models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_providers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug"),
	CONSTRAINT "credit_balance_non_negative" CHECK ("organizations"."credit_balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "organization_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"inviter_user_id" uuid NOT NULL,
	"invited_email" text NOT NULL,
	"invited_role" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"accepted_at" timestamp,
	"accepted_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organization_invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"privy_user_id" text,
	"is_anonymous" boolean DEFAULT false NOT NULL,
	"anonymous_session_id" text,
	"email" text,
	"email_verified" boolean DEFAULT false,
	"wallet_address" text,
	"wallet_chain_type" text,
	"wallet_verified" boolean DEFAULT false NOT NULL,
	"name" text,
	"nickname" text,
	"work_function" text,
	"preferences" text,
	"response_notifications" boolean DEFAULT true,
	"email_notifications" boolean DEFAULT true,
	"organization_id" uuid,
	"role" text DEFAULT 'member' NOT NULL,
	"avatar" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	CONSTRAINT "users_privy_user_id_unique" UNIQUE("privy_user_id"),
	CONSTRAINT "users_anonymous_session_id_unique" UNIQUE("anonymous_session_id"),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_wallet_address_unique" UNIQUE("wallet_address")
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"session_token" text NOT NULL,
	"credits_used" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"requests_made" integer DEFAULT 0 NOT NULL,
	"tokens_consumed" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"last_activity_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"ip_address" text,
	"user_agent" text,
	"device_info" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_sessions_session_token_unique" UNIQUE("session_token")
);
--> statement-breakpoint
CREATE TABLE "anonymous_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_token" text NOT NULL,
	"user_id" uuid NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"messages_limit" integer DEFAULT 10 NOT NULL,
	"total_tokens_used" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp,
	"hourly_message_count" integer DEFAULT 0 NOT NULL,
	"hourly_reset_at" timestamp,
	"ip_address" text,
	"user_agent" text,
	"fingerprint" text,
	"signup_prompted_at" timestamp,
	"signup_prompt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"converted_at" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "anonymous_sessions_session_token_unique" UNIQUE("session_token")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"key" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rate_limit" integer DEFAULT 1000 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_unique" UNIQUE("key"),
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "cli_auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"user_id" uuid,
	"api_key_id" uuid,
	"api_key_plain" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"authenticated_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cli_auth_sessions_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "miniapp_auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"callback_url" text NOT NULL,
	"app_id" text,
	"user_id" uuid,
	"organization_id" uuid,
	"auth_token" text,
	"auth_token_hash" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"authenticated_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	CONSTRAINT "miniapp_auth_sessions_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"api_key_id" uuid,
	"type" text NOT NULL,
	"model" text,
	"provider" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"input_cost" numeric(10, 2) DEFAULT '0.00',
	"output_cost" numeric(10, 2) DEFAULT '0.00',
	"markup" numeric(10, 2) DEFAULT '0.00',
	"request_id" text,
	"duration_ms" integer,
	"is_successful" boolean DEFAULT true NOT NULL,
	"error_message" text,
	"ip_address" text,
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_quotas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"quota_type" text NOT NULL,
	"model_name" text,
	"period_type" text DEFAULT 'weekly' NOT NULL,
	"credits_limit" numeric(10, 2) NOT NULL,
	"current_usage" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"amount" numeric(10, 2) NOT NULL,
	"type" text NOT NULL,
	"description" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stripe_payment_intent_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"credits" numeric(10, 2) NOT NULL,
	"price_cents" integer NOT NULL,
	"stripe_price_id" text NOT NULL,
	"stripe_product_id" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "credit_packs_stripe_price_id_unique" UNIQUE("stripe_price_id")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"stripe_invoice_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_payment_intent_id" text,
	"amount_due" numeric(10, 2) NOT NULL,
	"amount_paid" numeric(10, 2) NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"status" text NOT NULL,
	"invoice_type" text NOT NULL,
	"invoice_number" text,
	"invoice_pdf" text,
	"hosted_invoice_url" text,
	"credits_added" numeric(10, 2),
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"due_date" timestamp,
	"paid_at" timestamp,
	CONSTRAINT "invoices_stripe_invoice_id_unique" UNIQUE("stripe_invoice_id")
);
--> statement-breakpoint
CREATE TABLE "generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"api_key_id" uuid,
	"type" text NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"prompt" text NOT NULL,
	"negative_prompt" text,
	"result" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"storage_url" text,
	"thumbnail_url" text,
	"content" text,
	"file_size" bigint,
	"mime_type" text,
	"parameters" jsonb,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dimensions" jsonb,
	"tokens" integer,
	"cost" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"credits" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"usage_record_id" uuid,
	"job_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"data" jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"api_key_id" uuid,
	"generation_id" uuid,
	"webhook_url" text,
	"webhook_status" text,
	"estimated_completion_at" timestamp,
	"scheduled_for" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_pricing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_cost_per_1k" numeric(10, 6) NOT NULL,
	"output_cost_per_1k" numeric(10, 6) NOT NULL,
	"input_cost_per_token" numeric(10, 6),
	"output_cost_per_token" numeric(10, 6),
	"is_active" boolean DEFAULT true NOT NULL,
	"effective_from" timestamp DEFAULT now() NOT NULL,
	"effective_until" timestamp,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_health" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'healthy' NOT NULL,
	"last_checked" timestamp DEFAULT now() NOT NULL,
	"response_time" integer,
	"error_rate" numeric(5, 4) DEFAULT '0',
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"sequence_number" integer NOT NULL,
	"model" text,
	"tokens" integer,
	"cost" numeric(10, 2) DEFAULT '0.00',
	"usage_record_id" uuid,
	"api_request" jsonb,
	"api_response" jsonb,
	"processing_time" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"model" text NOT NULL,
	"settings" jsonb DEFAULT '{"temperature":0.7,"maxTokens":2000,"topP":1,"frequencyPenalty":0,"presencePenalty":0,"systemPrompt":"You are a helpful AI assistant."}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"total_cost" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"last_message_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"username" text,
	"system" text,
	"bio" jsonb NOT NULL,
	"message_examples" jsonb DEFAULT '[]'::jsonb,
	"post_examples" jsonb DEFAULT '[]'::jsonb,
	"topics" jsonb DEFAULT '[]'::jsonb,
	"adjectives" jsonb DEFAULT '[]'::jsonb,
	"knowledge" jsonb DEFAULT '[]'::jsonb,
	"plugins" jsonb DEFAULT '[]'::jsonb,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" jsonb DEFAULT '{}'::jsonb,
	"style" jsonb DEFAULT '{}'::jsonb,
	"character_data" jsonb NOT NULL,
	"is_template" boolean DEFAULT false NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"avatar_url" text,
	"category" text,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"featured" boolean DEFAULT false NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"interaction_count" integer DEFAULT 0 NOT NULL,
	"popularity_score" integer DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'cloud' NOT NULL,
	"erc8004_registered" boolean DEFAULT false NOT NULL,
	"erc8004_network" text,
	"erc8004_agent_id" integer,
	"erc8004_agent_uri" text,
	"erc8004_tx_hash" text,
	"erc8004_registered_at" timestamp,
	"monetization_enabled" boolean DEFAULT false NOT NULL,
	"inference_markup_percentage" numeric(7, 2) DEFAULT '0.00' NOT NULL,
	"payout_wallet_address" text,
	"total_inference_requests" integer DEFAULT 0 NOT NULL,
	"total_creator_earnings" numeric(12, 4) DEFAULT '0.0000' NOT NULL,
	"total_platform_revenue" numeric(12, 4) DEFAULT '0.0000' NOT NULL,
	"a2a_enabled" boolean DEFAULT true NOT NULL,
	"mcp_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_voices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"elevenlabs_voice_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"clone_type" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sample_count" integer DEFAULT 0 NOT NULL,
	"total_audio_duration_seconds" integer,
	"audio_quality_score" numeric(3, 2),
	"usage_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"creation_cost" numeric(10, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_voices_elevenlabs_voice_id_unique" UNIQUE("elevenlabs_voice_id")
);
--> statement-breakpoint
CREATE TABLE "voice_cloning_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"job_type" text NOT NULL,
	"voice_name" text NOT NULL,
	"voice_description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"user_voice_id" uuid,
	"elevenlabs_voice_id" text,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_voice_id" uuid,
	"job_id" uuid,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"file_size" integer NOT NULL,
	"file_type" text NOT NULL,
	"blob_url" text NOT NULL,
	"duration_seconds" numeric(10, 2),
	"sample_rate" integer,
	"channels" integer,
	"quality_score" numeric(3, 2),
	"is_processed" boolean DEFAULT false NOT NULL,
	"transcription" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "containers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"project_name" text NOT NULL,
	"description" text,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"api_key_id" uuid,
	"character_id" uuid,
	"cloudformation_stack_name" text,
	"ecr_repository_uri" text,
	"ecr_image_tag" text,
	"ecs_cluster_arn" text,
	"ecs_service_arn" text,
	"ecs_task_definition_arn" text,
	"ecs_task_arn" text,
	"load_balancer_url" text,
	"is_update" text DEFAULT 'false' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"image_tag" text,
	"dockerfile_path" text,
	"environment_vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"desired_count" integer DEFAULT 1 NOT NULL,
	"cpu" integer DEFAULT 1792 NOT NULL,
	"memory" integer DEFAULT 1792 NOT NULL,
	"port" integer DEFAULT 3000 NOT NULL,
	"health_check_path" text DEFAULT '/health',
	"architecture" text DEFAULT 'arm64' NOT NULL,
	"last_deployed_at" timestamp,
	"last_health_check" timestamp,
	"deployment_log" text,
	"error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alb_priorities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"priority" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "alb_priorities_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "alb_priorities_priority_unique" UNIQUE("priority")
);
--> statement-breakpoint
CREATE TABLE "app_analytics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"period_type" text NOT NULL,
	"total_requests" integer DEFAULT 0 NOT NULL,
	"successful_requests" integer DEFAULT 0 NOT NULL,
	"failed_requests" integer DEFAULT 0 NOT NULL,
	"unique_users" integer DEFAULT 0 NOT NULL,
	"new_users" integer DEFAULT 0 NOT NULL,
	"total_input_tokens" integer DEFAULT 0 NOT NULL,
	"total_output_tokens" integer DEFAULT 0 NOT NULL,
	"total_cost" numeric(10, 2) DEFAULT '0.00',
	"total_credits_used" numeric(10, 2) DEFAULT '0.00',
	"chat_requests" integer DEFAULT 0 NOT NULL,
	"image_requests" integer DEFAULT 0 NOT NULL,
	"video_requests" integer DEFAULT 0 NOT NULL,
	"voice_requests" integer DEFAULT 0 NOT NULL,
	"agent_requests" integer DEFAULT 0 NOT NULL,
	"avg_response_time_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"signup_source" text,
	"referral_code_used" text,
	"ip_address" text,
	"user_agent" text,
	"total_requests" integer DEFAULT 0 NOT NULL,
	"total_credits_used" numeric(10, 2) DEFAULT '0.00',
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"slug" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"app_url" text NOT NULL,
	"allowed_origins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"api_key_id" uuid,
	"affiliate_code" text,
	"referral_bonus_credits" numeric(10, 2) DEFAULT '0.00',
	"total_requests" integer DEFAULT 0 NOT NULL,
	"total_users" integer DEFAULT 0 NOT NULL,
	"total_credits_used" numeric(10, 2) DEFAULT '0.00',
	"custom_pricing_enabled" boolean DEFAULT false NOT NULL,
	"monetization_enabled" boolean DEFAULT false NOT NULL,
	"inference_markup_percentage" numeric(7, 2) DEFAULT '0.00' NOT NULL,
	"purchase_share_percentage" numeric(5, 2) DEFAULT '10.00' NOT NULL,
	"platform_offset_amount" numeric(10, 2) DEFAULT '1.00' NOT NULL,
	"total_creator_earnings" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"total_platform_revenue" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"features_enabled" jsonb DEFAULT '{"chat":true,"image":false,"video":false,"voice":false,"agents":false,"embedding":false}'::jsonb NOT NULL,
	"rate_limit_per_minute" integer DEFAULT 60,
	"rate_limit_per_hour" integer DEFAULT 1000,
	"logo_url" text,
	"website_url" text,
	"contact_email" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_approved" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	CONSTRAINT "apps_slug_unique" UNIQUE("slug"),
	CONSTRAINT "apps_api_key_id_unique" UNIQUE("api_key_id"),
	CONSTRAINT "apps_affiliate_code_unique" UNIQUE("affiliate_code")
);
--> statement-breakpoint
CREATE TABLE "app_credit_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"credit_balance" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"total_purchased" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"total_spent" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_earnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"total_lifetime_earnings" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"total_inference_earnings" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"total_purchase_earnings" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"pending_balance" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"withdrawable_balance" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"total_withdrawn" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"last_withdrawal_at" timestamp,
	"payout_threshold" numeric(10, 2) DEFAULT '10.00' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_earnings_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"user_id" uuid,
	"type" text NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"description" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code" text NOT NULL,
	"total_referrals" integer DEFAULT 0 NOT NULL,
	"total_signup_earnings" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"total_qualified_earnings" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"total_commission_earnings" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "referral_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "referral_signups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referral_code_id" uuid NOT NULL,
	"referrer_user_id" uuid NOT NULL,
	"referred_user_id" uuid NOT NULL,
	"signup_bonus_credited" boolean DEFAULT false NOT NULL,
	"signup_bonus_amount" numeric(10, 2) DEFAULT '0.00',
	"qualified_at" timestamp,
	"qualified_bonus_credited" boolean DEFAULT false NOT NULL,
	"qualified_bonus_amount" numeric(10, 2) DEFAULT '0.00',
	"total_commission_earned" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_share_rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" "social_platform" NOT NULL,
	"share_type" "share_type" NOT NULL,
	"share_url" text,
	"share_intent_at" timestamp,
	"verified" boolean DEFAULT false NOT NULL,
	"credits_awarded" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"server_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"username" text,
	"system" text DEFAULT '',
	"bio" jsonb DEFAULT '[]'::jsonb,
	"message_examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"post_examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"adjectives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"knowledge" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plugins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"style" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cache" (
	"key" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "cache_key_agent_id_pk" PRIMARY KEY("key","agent_id")
);
--> statement-breakpoint
CREATE TABLE "channel_participants" (
	"channel_id" text NOT NULL,
	"entity_id" text NOT NULL,
	CONSTRAINT "channel_participants_channel_id_entity_id_pk" PRIMARY KEY("channel_id","entity_id")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"message_server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"source_type" text,
	"source_id" text,
	"topic" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entityId" uuid NOT NULL,
	"agentId" uuid NOT NULL,
	"roomId" uuid NOT NULL,
	"worldId" uuid,
	"sourceEntityId" uuid,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"dim_384" vector(384),
	"dim_512" vector(512),
	"dim_768" vector(768),
	"dim_1024" vector(1024),
	"dim_1536" vector(1536),
	"dim_3072" vector(3072),
	CONSTRAINT "embedding_source_check" CHECK ("memory_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"names" text[] DEFAULT '{}'::text[] NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "id_agent_id_unique" UNIQUE("id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "logs" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"entityId" uuid NOT NULL,
	"body" jsonb NOT NULL,
	"type" text NOT NULL,
	"roomId" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "long_term_memories" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"entity_id" varchar(36) NOT NULL,
	"category" text NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb,
	"embedding" real[],
	"confidence" real DEFAULT 1,
	"source" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp,
	"access_count" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "memory_access_logs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"memory_id" varchar(36) NOT NULL,
	"memory_type" text NOT NULL,
	"accessed_at" timestamp DEFAULT now() NOT NULL,
	"room_id" varchar(36),
	"relevance_score" real,
	"was_useful" integer
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"content" jsonb NOT NULL,
	"entityId" uuid,
	"agentId" uuid NOT NULL,
	"roomId" uuid,
	"worldId" uuid,
	"unique" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "fragment_metadata_check" CHECK (
            CASE 
                WHEN metadata->>'type' = 'fragment' THEN
                    metadata ? 'documentId' AND 
                    metadata ? 'position'
                ELSE true
            END
        ),
	CONSTRAINT "document_metadata_check" CHECK (
            CASE 
                WHEN metadata->>'type' = 'document' THEN
                    metadata ? 'timestamp'
                ELSE true
            END
        )
);
--> statement-breakpoint
CREATE TABLE "message_servers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "central_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"author_id" text NOT NULL,
	"content" text NOT NULL,
	"raw_message" jsonb,
	"in_reply_to_root_message_id" text,
	"source_type" text,
	"source_id" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"entityId" uuid,
	"roomId" uuid,
	"agentId" uuid,
	"roomState" text
);
--> statement-breakpoint
CREATE TABLE "relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sourceEntityId" uuid NOT NULL,
	"targetEntityId" uuid NOT NULL,
	"agentId" uuid NOT NULL,
	"tags" text[],
	"metadata" jsonb,
	CONSTRAINT "unique_relationship" UNIQUE("sourceEntityId","targetEntityId","agentId")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agentId" uuid,
	"source" text NOT NULL,
	"type" text NOT NULL,
	"message_server_id" uuid,
	"worldId" uuid,
	"name" text,
	"metadata" jsonb,
	"channel_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_summaries" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"agent_id" varchar(36) NOT NULL,
	"room_id" varchar(36) NOT NULL,
	"entity_id" varchar(36),
	"summary" text NOT NULL,
	"message_count" integer NOT NULL,
	"last_message_offset" integer DEFAULT 0 NOT NULL,
	"start_time" timestamp NOT NULL,
	"end_time" timestamp NOT NULL,
	"topics" jsonb,
	"metadata" jsonb,
	"embedding" real[],
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"roomId" uuid,
	"worldId" uuid,
	"entityId" uuid,
	"agentId" uuid NOT NULL,
	"tags" text[] DEFAULT '{}'::text[],
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "worlds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agentId" uuid NOT NULL,
	"name" text NOT NULL,
	"metadata" jsonb,
	"message_server_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eliza_room_characters" (
	"room_id" uuid PRIMARY KEY NOT NULL,
	"character_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"duration_ms" text,
	"container_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mcp_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"tool_name" text NOT NULL,
	"request_count" integer DEFAULT 1 NOT NULL,
	"credits_charged" numeric(10, 4) DEFAULT '0.0000',
	"x402_amount_usd" numeric(10, 6) DEFAULT '0.000000',
	"payment_type" text DEFAULT 'credits' NOT NULL,
	"creator_earnings" numeric(10, 4) DEFAULT '0.0000',
	"platform_earnings" numeric(10, 4) DEFAULT '0.0000',
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_mcps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text NOT NULL,
	"version" text DEFAULT '1.0.0' NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"endpoint_type" text DEFAULT 'container' NOT NULL,
	"container_id" uuid,
	"external_endpoint" text,
	"endpoint_path" text DEFAULT '/mcp',
	"transport_type" text DEFAULT 'streamable-http' NOT NULL,
	"mcp_version" text DEFAULT '2025-06-18',
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"category" text DEFAULT 'utilities' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"icon" text DEFAULT 'puzzle',
	"color" text DEFAULT '#6366F1',
	"pricing_type" "mcp_pricing_type" DEFAULT 'credits' NOT NULL,
	"credits_per_request" numeric(10, 4) DEFAULT '1.0000',
	"x402_price_usd" numeric(10, 6) DEFAULT '0.000100',
	"x402_enabled" boolean DEFAULT false NOT NULL,
	"creator_share_percentage" numeric(5, 2) DEFAULT '80.00' NOT NULL,
	"platform_share_percentage" numeric(5, 2) DEFAULT '20.00' NOT NULL,
	"total_requests" integer DEFAULT 0 NOT NULL,
	"total_credits_earned" numeric(12, 4) DEFAULT '0.0000',
	"total_x402_earned_usd" numeric(12, 6) DEFAULT '0.000000',
	"unique_users" integer DEFAULT 0 NOT NULL,
	"status" "mcp_status" DEFAULT 'draft' NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp,
	"verified_by" uuid,
	"documentation_url" text,
	"source_code_url" text,
	"support_email" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"erc8004_registered" boolean DEFAULT false NOT NULL,
	"erc8004_network" text,
	"erc8004_agent_id" integer,
	"erc8004_agent_uri" text,
	"erc8004_tx_hash" text,
	"erc8004_registered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	"published_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "eliza_token_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text NOT NULL,
	"price_usd" numeric(18, 8) NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redemption_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"date" timestamp NOT NULL,
	"daily_usd_total" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"redemption_count" numeric(5, 0) DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"app_id" uuid,
	"points_amount" numeric(12, 2) NOT NULL,
	"usd_value" numeric(12, 4) NOT NULL,
	"eliza_price_usd" numeric(18, 8) NOT NULL,
	"eliza_amount" numeric(24, 8) NOT NULL,
	"price_quote_expires_at" timestamp NOT NULL,
	"network" "redemption_network" NOT NULL,
	"payout_address" text NOT NULL,
	"address_signature" text,
	"status" "redemption_status" DEFAULT 'pending' NOT NULL,
	"processing_started_at" timestamp,
	"processing_worker_id" text,
	"tx_hash" text,
	"completed_at" timestamp,
	"failure_reason" text,
	"retry_count" numeric(3, 0) DEFAULT '0' NOT NULL,
	"requires_review" boolean DEFAULT false NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp,
	"review_notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redeemable_earnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"total_earned" numeric(18, 4) DEFAULT '0.0000' NOT NULL,
	"total_redeemed" numeric(18, 4) DEFAULT '0.0000' NOT NULL,
	"total_pending" numeric(18, 4) DEFAULT '0.0000' NOT NULL,
	"available_balance" numeric(18, 4) DEFAULT '0.0000' NOT NULL,
	"earned_from_miniapps" numeric(18, 4) DEFAULT '0.0000' NOT NULL,
	"earned_from_agents" numeric(18, 4) DEFAULT '0.0000' NOT NULL,
	"earned_from_mcps" numeric(18, 4) DEFAULT '0.0000' NOT NULL,
	"last_earning_at" timestamp,
	"last_redemption_at" timestamp,
	"version" numeric(10, 0) DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "redeemable_earnings_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "available_balance_non_negative" CHECK ("redeemable_earnings"."available_balance" >= 0),
	CONSTRAINT "totals_consistent" CHECK ("redeemable_earnings"."total_earned" >= "redeemable_earnings"."total_redeemed" + "redeemable_earnings"."total_pending")
);
--> statement-breakpoint
CREATE TABLE "redeemable_earnings_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entry_type" "ledger_entry_type" NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"balance_after" numeric(18, 4) NOT NULL,
	"earnings_source" "earnings_source",
	"source_id" uuid,
	"redemption_id" uuid,
	"description" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redeemed_earnings_tracking" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ledger_entry_id" uuid NOT NULL,
	"redemption_id" uuid NOT NULL,
	"amount_redeemed" numeric(18, 4) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "redeemed_earnings_tracking_ledger_entry_id_unique" UNIQUE("ledger_entry_id")
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"wallet_address" text NOT NULL,
	"role" "admin_role" DEFAULT 'moderator' NOT NULL,
	"granted_by" uuid,
	"granted_by_wallet" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	CONSTRAINT "admin_users_wallet_address_unique" UNIQUE("wallet_address")
);
--> statement-breakpoint
CREATE TABLE "moderation_violations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"room_id" text,
	"message_text" text NOT NULL,
	"categories" jsonb NOT NULL,
	"scores" jsonb NOT NULL,
	"action" "moderation_action" NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp,
	"review_notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_moderation_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "user_mod_status" DEFAULT 'clean' NOT NULL,
	"total_violations" integer DEFAULT 0 NOT NULL,
	"warning_count" integer DEFAULT 0 NOT NULL,
	"risk_score" real DEFAULT 0 NOT NULL,
	"banned_by" uuid,
	"banned_at" timestamp,
	"ban_reason" text,
	"last_violation_at" timestamp,
	"last_warning_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_moderation_status_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "agent_activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_reputation_id" uuid NOT NULL,
	"activity_type" text NOT NULL,
	"amount_usd" real,
	"details" jsonb,
	"is_successful" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_moderation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_reputation_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"flag_type" "agent_flag_type",
	"severity" text DEFAULT 'medium' NOT NULL,
	"description" text,
	"evidence" text,
	"detected_by" text DEFAULT 'auto' NOT NULL,
	"moderation_scores" jsonb,
	"admin_user_id" uuid,
	"admin_notes" text,
	"action_taken" text,
	"reputation_change" real DEFAULT 0 NOT NULL,
	"previous_score" real,
	"new_score" real,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"resolved_by" uuid,
	"resolution_notes" text
);
--> statement-breakpoint
CREATE TABLE "agent_reputation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_identifier" text NOT NULL,
	"chain_id" integer,
	"token_id" integer,
	"wallet_address" text,
	"organization_id" uuid,
	"status" "agent_reputation_status" DEFAULT 'new' NOT NULL,
	"total_deposited" real DEFAULT 0 NOT NULL,
	"total_spent" real DEFAULT 0 NOT NULL,
	"payment_count" integer DEFAULT 0 NOT NULL,
	"last_payment_at" timestamp,
	"total_requests" integer DEFAULT 0 NOT NULL,
	"successful_requests" integer DEFAULT 0 NOT NULL,
	"failed_requests" integer DEFAULT 0 NOT NULL,
	"last_request_at" timestamp,
	"total_violations" integer DEFAULT 0 NOT NULL,
	"csam_violations" integer DEFAULT 0 NOT NULL,
	"self_harm_violations" integer DEFAULT 0 NOT NULL,
	"other_violations" integer DEFAULT 0 NOT NULL,
	"last_violation_at" timestamp,
	"flag_count" integer DEFAULT 0 NOT NULL,
	"is_flagged_by_admin" boolean DEFAULT false NOT NULL,
	"flag_reason" text,
	"flagged_at" timestamp,
	"flagged_by" uuid,
	"reputation_score" real DEFAULT 50 NOT NULL,
	"trust_level" text DEFAULT 'neutral' NOT NULL,
	"confidence_score" real DEFAULT 0 NOT NULL,
	"banned_at" timestamp,
	"banned_by" uuid,
	"ban_reason" text,
	"ban_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_reputation_agent_identifier_unique" UNIQUE("agent_identifier")
);
--> statement-breakpoint
CREATE TABLE "agent_budget_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"budget_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"type" text NOT NULL,
	"amount" numeric(12, 4) NOT NULL,
	"balance_after" numeric(12, 4) NOT NULL,
	"daily_spent_after" numeric(10, 4),
	"description" text NOT NULL,
	"operation_type" text,
	"model" text,
	"tokens_used" numeric(12, 0),
	"source_type" text,
	"source_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"allocated_budget" numeric(12, 4) DEFAULT '0.0000' NOT NULL,
	"spent_budget" numeric(12, 4) DEFAULT '0.0000' NOT NULL,
	"daily_limit" numeric(10, 4),
	"daily_spent" numeric(10, 4) DEFAULT '0.0000' NOT NULL,
	"daily_reset_at" timestamp,
	"auto_refill_enabled" boolean DEFAULT false NOT NULL,
	"auto_refill_amount" numeric(10, 4),
	"auto_refill_threshold" numeric(10, 4),
	"last_refill_at" timestamp,
	"is_paused" boolean DEFAULT false NOT NULL,
	"pause_on_depleted" boolean DEFAULT true NOT NULL,
	"pause_reason" text,
	"paused_at" timestamp,
	"low_budget_threshold" numeric(10, 4) DEFAULT '5.0000',
	"low_budget_alert_sent" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_budgets_agent_id_unique" UNIQUE("agent_id")
);
--> statement-breakpoint
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_inviter_user_id_users_id_fk" FOREIGN KEY ("inviter_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anonymous_sessions" ADD CONSTRAINT "anonymous_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_auth_sessions" ADD CONSTRAINT "cli_auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "miniapp_auth_sessions" ADD CONSTRAINT "miniapp_auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "miniapp_auth_sessions" ADD CONSTRAINT "miniapp_auth_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_quotas" ADD CONSTRAINT "usage_quotas_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_usage_record_id_usage_records_id_fk" FOREIGN KEY ("usage_record_id") REFERENCES "public"."usage_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_usage_record_id_usage_records_id_fk" FOREIGN KEY ("usage_record_id") REFERENCES "public"."usage_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_characters" ADD CONSTRAINT "user_characters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_characters" ADD CONSTRAINT "user_characters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_voices" ADD CONSTRAINT "user_voices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_voices" ADD CONSTRAINT "user_voices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_cloning_jobs" ADD CONSTRAINT "voice_cloning_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_cloning_jobs" ADD CONSTRAINT "voice_cloning_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_cloning_jobs" ADD CONSTRAINT "voice_cloning_jobs_user_voice_id_user_voices_id_fk" FOREIGN KEY ("user_voice_id") REFERENCES "public"."user_voices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_samples" ADD CONSTRAINT "voice_samples_user_voice_id_user_voices_id_fk" FOREIGN KEY ("user_voice_id") REFERENCES "public"."user_voices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_samples" ADD CONSTRAINT "voice_samples_job_id_voice_cloning_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."voice_cloning_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_samples" ADD CONSTRAINT "voice_samples_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_samples" ADD CONSTRAINT "voice_samples_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "containers" ADD CONSTRAINT "containers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "containers" ADD CONSTRAINT "containers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "containers" ADD CONSTRAINT "containers_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "containers" ADD CONSTRAINT "containers_character_id_user_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."user_characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_analytics" ADD CONSTRAINT "app_analytics_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_users" ADD CONSTRAINT "app_users_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_users" ADD CONSTRAINT "app_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_credit_balances" ADD CONSTRAINT "app_credit_balances_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_credit_balances" ADD CONSTRAINT "app_credit_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_credit_balances" ADD CONSTRAINT "app_credit_balances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_earnings" ADD CONSTRAINT "app_earnings_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_earnings_transactions" ADD CONSTRAINT "app_earnings_transactions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_earnings_transactions" ADD CONSTRAINT "app_earnings_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_signups" ADD CONSTRAINT "referral_signups_referral_code_id_referral_codes_id_fk" FOREIGN KEY ("referral_code_id") REFERENCES "public"."referral_codes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_signups" ADD CONSTRAINT "referral_signups_referrer_user_id_users_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_signups" ADD CONSTRAINT "referral_signups_referred_user_id_users_id_fk" FOREIGN KEY ("referred_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_share_rewards" ADD CONSTRAINT "social_share_rewards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cache" ADD CONSTRAINT "cache_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_participants" ADD CONSTRAINT "channel_participants_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_message_server_id_message_servers_id_fk" FOREIGN KEY ("message_server_id") REFERENCES "public"."message_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_entityId_entities_id_fk" FOREIGN KEY ("entityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_agentId_agents_id_fk" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_roomId_rooms_id_fk" FOREIGN KEY ("roomId") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_worldId_worlds_id_fk" FOREIGN KEY ("worldId") REFERENCES "public"."worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_sourceEntityId_entities_id_fk" FOREIGN KEY ("sourceEntityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "fk_embedding_memory" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "logs_entityId_entities_id_fk" FOREIGN KEY ("entityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "logs_roomId_rooms_id_fk" FOREIGN KEY ("roomId") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "fk_room" FOREIGN KEY ("roomId") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "fk_user" FOREIGN KEY ("entityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_entityId_entities_id_fk" FOREIGN KEY ("entityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_agentId_agents_id_fk" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_roomId_rooms_id_fk" FOREIGN KEY ("roomId") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "fk_room" FOREIGN KEY ("roomId") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "fk_user" FOREIGN KEY ("entityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "fk_agent" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "central_messages" ADD CONSTRAINT "central_messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "central_messages" ADD CONSTRAINT "central_messages_in_reply_to_root_message_id_central_messages_id_fk" FOREIGN KEY ("in_reply_to_root_message_id") REFERENCES "public"."central_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_entityId_entities_id_fk" FOREIGN KEY ("entityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_roomId_rooms_id_fk" FOREIGN KEY ("roomId") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_agentId_agents_id_fk" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "fk_room" FOREIGN KEY ("roomId") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "fk_user" FOREIGN KEY ("entityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_sourceEntityId_entities_id_fk" FOREIGN KEY ("sourceEntityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_targetEntityId_entities_id_fk" FOREIGN KEY ("targetEntityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_agentId_agents_id_fk" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "fk_user_a" FOREIGN KEY ("sourceEntityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "fk_user_b" FOREIGN KEY ("targetEntityId") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_agentId_agents_id_fk" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agentId_agents_id_fk" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worlds" ADD CONSTRAINT "worlds_agentId_agents_id_fk" FOREIGN KEY ("agentId") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eliza_room_characters" ADD CONSTRAINT "eliza_room_characters_character_id_user_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."user_characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_agent_id_user_characters_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."user_characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_usage" ADD CONSTRAINT "mcp_usage_mcp_id_user_mcps_id_fk" FOREIGN KEY ("mcp_id") REFERENCES "public"."user_mcps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_usage" ADD CONSTRAINT "mcp_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_usage" ADD CONSTRAINT "mcp_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mcps" ADD CONSTRAINT "user_mcps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mcps" ADD CONSTRAINT "user_mcps_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mcps" ADD CONSTRAINT "user_mcps_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mcps" ADD CONSTRAINT "user_mcps_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redemption_limits" ADD CONSTRAINT "redemption_limits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_redemptions" ADD CONSTRAINT "token_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_redemptions" ADD CONSTRAINT "token_redemptions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_redemptions" ADD CONSTRAINT "token_redemptions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redeemable_earnings" ADD CONSTRAINT "redeemable_earnings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redeemable_earnings_ledger" ADD CONSTRAINT "redeemable_earnings_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_violations" ADD CONSTRAINT "moderation_violations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_violations" ADD CONSTRAINT "moderation_violations_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_moderation_status" ADD CONSTRAINT "user_moderation_status_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_moderation_status" ADD CONSTRAINT "user_moderation_status_banned_by_users_id_fk" FOREIGN KEY ("banned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_activity_log" ADD CONSTRAINT "agent_activity_log_agent_reputation_id_agent_reputation_id_fk" FOREIGN KEY ("agent_reputation_id") REFERENCES "public"."agent_reputation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_moderation_events" ADD CONSTRAINT "agent_moderation_events_agent_reputation_id_agent_reputation_id_fk" FOREIGN KEY ("agent_reputation_id") REFERENCES "public"."agent_reputation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_budget_transactions" ADD CONSTRAINT "agent_budget_transactions_budget_id_agent_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."agent_budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_budget_transactions" ADD CONSTRAINT "agent_budget_transactions_agent_id_user_characters_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."user_characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_budgets" ADD CONSTRAINT "agent_budgets_agent_id_user_characters_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."user_characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_budgets" ADD CONSTRAINT "agent_budgets_owner_org_id_organizations_id_fk" FOREIGN KEY ("owner_org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organizations_slug_idx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "organizations_stripe_customer_idx" ON "organizations" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX "organizations_auto_top_up_enabled_idx" ON "organizations" USING btree ("auto_top_up_enabled");--> statement-breakpoint
CREATE INDEX "organization_invites_org_id_idx" ON "organization_invites" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "organization_invites_email_idx" ON "organization_invites" USING btree ("invited_email");--> statement-breakpoint
CREATE INDEX "organization_invites_token_idx" ON "organization_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "organization_invites_status_idx" ON "organization_invites" USING btree ("status");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_wallet_address_idx" ON "users" USING btree ("wallet_address");--> statement-breakpoint
CREATE INDEX "users_wallet_chain_type_idx" ON "users" USING btree ("wallet_chain_type");--> statement-breakpoint
CREATE INDEX "users_organization_idx" ON "users" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "users_is_active_idx" ON "users" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "users_privy_user_id_idx" ON "users" USING btree ("privy_user_id");--> statement-breakpoint
CREATE INDEX "users_is_anonymous_idx" ON "users" USING btree ("is_anonymous");--> statement-breakpoint
CREATE INDEX "users_anonymous_session_idx" ON "users" USING btree ("anonymous_session_id");--> statement-breakpoint
CREATE INDEX "users_expires_at_idx" ON "users" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "users_work_function_idx" ON "users" USING btree ("work_function");--> statement-breakpoint
CREATE INDEX "user_sessions_user_id_idx" ON "user_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_sessions_org_id_idx" ON "user_sessions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "user_sessions_token_idx" ON "user_sessions" USING btree ("session_token");--> statement-breakpoint
CREATE INDEX "user_sessions_started_at_idx" ON "user_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "user_sessions_active_idx" ON "user_sessions" USING btree ("ended_at");--> statement-breakpoint
CREATE INDEX "anon_sessions_token_idx" ON "anonymous_sessions" USING btree ("session_token");--> statement-breakpoint
CREATE INDEX "anon_sessions_user_id_idx" ON "anonymous_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "anon_sessions_expires_at_idx" ON "anonymous_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "anon_sessions_ip_address_idx" ON "anonymous_sessions" USING btree ("ip_address");--> statement-breakpoint
CREATE INDEX "anon_sessions_is_active_idx" ON "anonymous_sessions" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "api_keys_key_idx" ON "api_keys" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_idx" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_key_prefix_idx" ON "api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE INDEX "api_keys_organization_idx" ON "api_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "api_keys_user_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "cli_auth_sessions_session_id_idx" ON "cli_auth_sessions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "cli_auth_sessions_status_idx" ON "cli_auth_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cli_auth_sessions_user_id_idx" ON "cli_auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "cli_auth_sessions_expires_at_idx" ON "cli_auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "usage_records_organization_idx" ON "usage_records" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "usage_records_user_idx" ON "usage_records" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "usage_records_api_key_idx" ON "usage_records" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "usage_records_type_idx" ON "usage_records" USING btree ("type");--> statement-breakpoint
CREATE INDEX "usage_records_provider_idx" ON "usage_records" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "usage_records_created_at_idx" ON "usage_records" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "usage_records_org_created_idx" ON "usage_records" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_records_org_type_created_idx" ON "usage_records" USING btree ("organization_id","type","created_at");--> statement-breakpoint
CREATE INDEX "usage_quotas_org_id_idx" ON "usage_quotas" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "usage_quotas_quota_type_idx" ON "usage_quotas" USING btree ("quota_type");--> statement-breakpoint
CREATE INDEX "usage_quotas_period_idx" ON "usage_quotas" USING btree ("period_start","period_end");--> statement-breakpoint
CREATE INDEX "usage_quotas_active_idx" ON "usage_quotas" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "credit_transactions_organization_idx" ON "credit_transactions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "credit_transactions_user_idx" ON "credit_transactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "credit_transactions_type_idx" ON "credit_transactions" USING btree ("type");--> statement-breakpoint
CREATE INDEX "credit_transactions_created_at_idx" ON "credit_transactions" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_transactions_stripe_payment_intent_idx" ON "credit_transactions" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE INDEX "credit_packs_stripe_price_idx" ON "credit_packs" USING btree ("stripe_price_id");--> statement-breakpoint
CREATE INDEX "credit_packs_active_idx" ON "credit_packs" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "credit_packs_sort_idx" ON "credit_packs" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "invoices_organization_idx" ON "invoices" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invoices_stripe_invoice_idx" ON "invoices" USING btree ("stripe_invoice_id");--> statement-breakpoint
CREATE INDEX "invoices_status_idx" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "generations_organization_idx" ON "generations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "generations_user_idx" ON "generations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "generations_api_key_idx" ON "generations" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "generations_type_idx" ON "generations" USING btree ("type");--> statement-breakpoint
CREATE INDEX "generations_status_idx" ON "generations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "generations_created_at_idx" ON "generations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "generations_org_type_status_idx" ON "generations" USING btree ("organization_id","type","status");--> statement-breakpoint
CREATE INDEX "jobs_type_idx" ON "jobs" USING btree ("type");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "jobs_scheduled_for_idx" ON "jobs" USING btree ("scheduled_for");--> statement-breakpoint
CREATE INDEX "jobs_organization_idx" ON "jobs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "model_pricing_provider_model_idx" ON "model_pricing" USING btree ("provider","model");--> statement-breakpoint
CREATE INDEX "model_pricing_active_idx" ON "model_pricing" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "provider_health_provider_idx" ON "provider_health" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "provider_health_status_idx" ON "provider_health" USING btree ("status");--> statement-breakpoint
CREATE INDEX "conv_messages_conversation_idx" ON "conversation_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "conv_messages_sequence_idx" ON "conversation_messages" USING btree ("conversation_id","sequence_number");--> statement-breakpoint
CREATE INDEX "conv_messages_created_idx" ON "conversation_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "conversations_organization_idx" ON "conversations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "conversations_user_idx" ON "conversations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "conversations_updated_idx" ON "conversations" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "conversations_status_idx" ON "conversations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "user_characters_organization_idx" ON "user_characters" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "user_characters_user_idx" ON "user_characters" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_characters_name_idx" ON "user_characters" USING btree ("name");--> statement-breakpoint
CREATE INDEX "user_characters_category_idx" ON "user_characters" USING btree ("category");--> statement-breakpoint
CREATE INDEX "user_characters_featured_idx" ON "user_characters" USING btree ("featured");--> statement-breakpoint
CREATE INDEX "user_characters_is_template_idx" ON "user_characters" USING btree ("is_template");--> statement-breakpoint
CREATE INDEX "user_characters_is_public_idx" ON "user_characters" USING btree ("is_public");--> statement-breakpoint
CREATE INDEX "user_characters_popularity_idx" ON "user_characters" USING btree ("popularity_score");--> statement-breakpoint
CREATE INDEX "user_characters_source_idx" ON "user_characters" USING btree ("source");--> statement-breakpoint
CREATE INDEX "user_characters_erc8004_idx" ON "user_characters" USING btree ("erc8004_registered");--> statement-breakpoint
CREATE INDEX "user_characters_erc8004_agent_idx" ON "user_characters" USING btree ("erc8004_network","erc8004_agent_id");--> statement-breakpoint
CREATE INDEX "user_characters_monetization_idx" ON "user_characters" USING btree ("monetization_enabled");--> statement-breakpoint
CREATE INDEX "user_voices_organization_idx" ON "user_voices" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "user_voices_user_idx" ON "user_voices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_voices_org_type_idx" ON "user_voices" USING btree ("organization_id","clone_type");--> statement-breakpoint
CREATE INDEX "user_voices_org_usage_idx" ON "user_voices" USING btree ("organization_id","usage_count","last_used_at");--> statement-breakpoint
CREATE INDEX "containers_organization_idx" ON "containers" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "containers_user_idx" ON "containers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "containers_status_idx" ON "containers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "containers_character_idx" ON "containers" USING btree ("character_id");--> statement-breakpoint
CREATE INDEX "containers_ecs_service_idx" ON "containers" USING btree ("ecs_service_arn");--> statement-breakpoint
CREATE INDEX "containers_ecr_repository_idx" ON "containers" USING btree ("ecr_repository_uri");--> statement-breakpoint
CREATE INDEX "containers_project_name_idx" ON "containers" USING btree ("project_name");--> statement-breakpoint
CREATE INDEX "containers_user_project_idx" ON "containers" USING btree ("user_id","project_name");--> statement-breakpoint
CREATE INDEX "app_analytics_app_id_idx" ON "app_analytics" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "app_analytics_period_idx" ON "app_analytics" USING btree ("period_start","period_end");--> statement-breakpoint
CREATE INDEX "app_analytics_period_type_idx" ON "app_analytics" USING btree ("period_type");--> statement-breakpoint
CREATE INDEX "app_analytics_app_period_idx" ON "app_analytics" USING btree ("app_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "app_users_app_user_idx" ON "app_users" USING btree ("app_id","user_id");--> statement-breakpoint
CREATE INDEX "app_users_app_id_idx" ON "app_users" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "app_users_user_id_idx" ON "app_users" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "app_users_first_seen_idx" ON "app_users" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "apps_slug_idx" ON "apps" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "apps_organization_idx" ON "apps" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "apps_created_by_idx" ON "apps" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "apps_affiliate_code_idx" ON "apps" USING btree ("affiliate_code");--> statement-breakpoint
CREATE INDEX "apps_is_active_idx" ON "apps" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "apps_created_at_idx" ON "apps" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "app_credit_balances_app_user_idx" ON "app_credit_balances" USING btree ("app_id","user_id");--> statement-breakpoint
CREATE INDEX "app_credit_balances_app_idx" ON "app_credit_balances" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "app_credit_balances_user_idx" ON "app_credit_balances" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "app_credit_balances_org_idx" ON "app_credit_balances" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_earnings_app_idx" ON "app_earnings" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "app_earnings_transactions_app_idx" ON "app_earnings_transactions" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "app_earnings_transactions_app_created_idx" ON "app_earnings_transactions" USING btree ("app_id","created_at");--> statement-breakpoint
CREATE INDEX "app_earnings_transactions_user_idx" ON "app_earnings_transactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "app_earnings_transactions_type_idx" ON "app_earnings_transactions" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_codes_user_idx" ON "referral_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "referral_codes_code_idx" ON "referral_codes" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_signups_referred_user_idx" ON "referral_signups" USING btree ("referred_user_id");--> statement-breakpoint
CREATE INDEX "referral_signups_referrer_idx" ON "referral_signups" USING btree ("referrer_user_id");--> statement-breakpoint
CREATE INDEX "referral_signups_code_idx" ON "referral_signups" USING btree ("referral_code_id");--> statement-breakpoint
CREATE INDEX "social_share_rewards_user_idx" ON "social_share_rewards" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "social_share_rewards_platform_idx" ON "social_share_rewards" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "social_share_rewards_user_platform_date_idx" ON "social_share_rewards" USING btree ("user_id","platform","created_at");--> statement-breakpoint
CREATE INDEX "idx_embedding_memory" ON "embeddings" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "long_term_memories_agent_entity_idx" ON "long_term_memories" USING btree ("agent_id","entity_id");--> statement-breakpoint
CREATE INDEX "long_term_memories_category_idx" ON "long_term_memories" USING btree ("category");--> statement-breakpoint
CREATE INDEX "long_term_memories_confidence_idx" ON "long_term_memories" USING btree ("confidence");--> statement-breakpoint
CREATE INDEX "long_term_memories_created_at_idx" ON "long_term_memories" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "memory_access_logs_memory_idx" ON "memory_access_logs" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "memory_access_logs_agent_idx" ON "memory_access_logs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "memory_access_logs_accessed_at_idx" ON "memory_access_logs" USING btree ("accessed_at");--> statement-breakpoint
CREATE INDEX "idx_memories_type_room" ON "memories" USING btree ("type","roomId");--> statement-breakpoint
CREATE INDEX "idx_memories_world_id" ON "memories" USING btree ("worldId");--> statement-breakpoint
CREATE INDEX "idx_memories_metadata_type" ON "memories" USING btree (((metadata->>'type')));--> statement-breakpoint
CREATE INDEX "idx_memories_document_id" ON "memories" USING btree (((metadata->>'documentId')));--> statement-breakpoint
CREATE INDEX "idx_fragments_order" ON "memories" USING btree (((metadata->>'documentId')),((metadata->>'position')));--> statement-breakpoint
CREATE INDEX "idx_participants_user" ON "participants" USING btree ("entityId");--> statement-breakpoint
CREATE INDEX "idx_participants_room" ON "participants" USING btree ("roomId");--> statement-breakpoint
CREATE INDEX "idx_relationships_users" ON "relationships" USING btree ("sourceEntityId","targetEntityId");--> statement-breakpoint
CREATE INDEX "session_summaries_agent_room_idx" ON "session_summaries" USING btree ("agent_id","room_id");--> statement-breakpoint
CREATE INDEX "session_summaries_entity_idx" ON "session_summaries" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "session_summaries_start_time_idx" ON "session_summaries" USING btree ("start_time");--> statement-breakpoint
CREATE INDEX "agent_events_agent_idx" ON "agent_events" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_events_organization_idx" ON "agent_events" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "agent_events_event_type_idx" ON "agent_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "agent_events_level_idx" ON "agent_events" USING btree ("level");--> statement-breakpoint
CREATE INDEX "agent_events_created_at_idx" ON "agent_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "agent_events_agent_created_idx" ON "agent_events" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "mcp_usage_mcp_id_idx" ON "mcp_usage" USING btree ("mcp_id");--> statement-breakpoint
CREATE INDEX "mcp_usage_organization_idx" ON "mcp_usage" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "mcp_usage_user_idx" ON "mcp_usage" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mcp_usage_created_at_idx" ON "mcp_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "mcp_usage_mcp_org_idx" ON "mcp_usage" USING btree ("mcp_id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_mcps_slug_org_idx" ON "user_mcps" USING btree ("slug","organization_id");--> statement-breakpoint
CREATE INDEX "user_mcps_organization_idx" ON "user_mcps" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "user_mcps_created_by_idx" ON "user_mcps" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "user_mcps_container_idx" ON "user_mcps" USING btree ("container_id");--> statement-breakpoint
CREATE INDEX "user_mcps_category_idx" ON "user_mcps" USING btree ("category");--> statement-breakpoint
CREATE INDEX "user_mcps_status_idx" ON "user_mcps" USING btree ("status");--> statement-breakpoint
CREATE INDEX "user_mcps_is_public_idx" ON "user_mcps" USING btree ("is_public");--> statement-breakpoint
CREATE INDEX "user_mcps_created_at_idx" ON "user_mcps" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "user_mcps_erc8004_registered_idx" ON "user_mcps" USING btree ("erc8004_registered");--> statement-breakpoint
CREATE INDEX "eliza_token_prices_network_source_idx" ON "eliza_token_prices" USING btree ("network","source");--> statement-breakpoint
CREATE INDEX "eliza_token_prices_expires_idx" ON "eliza_token_prices" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "redemption_limits_user_date_idx" ON "redemption_limits" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "token_redemptions_user_idx" ON "token_redemptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "token_redemptions_app_idx" ON "token_redemptions" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "token_redemptions_status_idx" ON "token_redemptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "token_redemptions_status_created_idx" ON "token_redemptions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "token_redemptions_network_idx" ON "token_redemptions" USING btree ("network");--> statement-breakpoint
CREATE INDEX "token_redemptions_payout_idx" ON "token_redemptions" USING btree ("payout_address");--> statement-breakpoint
CREATE UNIQUE INDEX "token_redemptions_pending_user_idx" ON "token_redemptions" USING btree ("user_id","status") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "redeemable_earnings_user_idx" ON "redeemable_earnings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "redeemable_earnings_ledger_user_idx" ON "redeemable_earnings_ledger" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "redeemable_earnings_ledger_user_created_idx" ON "redeemable_earnings_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "redeemable_earnings_ledger_type_idx" ON "redeemable_earnings_ledger" USING btree ("entry_type");--> statement-breakpoint
CREATE INDEX "redeemable_earnings_ledger_redemption_idx" ON "redeemable_earnings_ledger" USING btree ("redemption_id");--> statement-breakpoint
CREATE INDEX "redeemable_earnings_ledger_source_idx" ON "redeemable_earnings_ledger" USING btree ("earnings_source","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "redeemed_tracking_ledger_idx" ON "redeemed_earnings_tracking" USING btree ("ledger_entry_id");--> statement-breakpoint
CREATE INDEX "redeemed_tracking_redemption_idx" ON "redeemed_earnings_tracking" USING btree ("redemption_id");--> statement-breakpoint
CREATE INDEX "admin_users_wallet_address_idx" ON "admin_users" USING btree ("wallet_address");--> statement-breakpoint
CREATE INDEX "admin_users_user_id_idx" ON "admin_users" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "admin_users_role_idx" ON "admin_users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "admin_users_is_active_idx" ON "admin_users" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "moderation_violations_user_id_idx" ON "moderation_violations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "moderation_violations_action_idx" ON "moderation_violations" USING btree ("action");--> statement-breakpoint
CREATE INDEX "moderation_violations_created_at_idx" ON "moderation_violations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "moderation_violations_room_id_idx" ON "moderation_violations" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "user_moderation_status_user_id_idx" ON "user_moderation_status" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_moderation_status_status_idx" ON "user_moderation_status" USING btree ("status");--> statement-breakpoint
CREATE INDEX "user_moderation_status_risk_score_idx" ON "user_moderation_status" USING btree ("risk_score");--> statement-breakpoint
CREATE INDEX "user_moderation_status_total_violations_idx" ON "user_moderation_status" USING btree ("total_violations");--> statement-breakpoint
CREATE INDEX "agent_activity_reputation_id_idx" ON "agent_activity_log" USING btree ("agent_reputation_id");--> statement-breakpoint
CREATE INDEX "agent_activity_type_idx" ON "agent_activity_log" USING btree ("activity_type");--> statement-breakpoint
CREATE INDEX "agent_activity_created_at_idx" ON "agent_activity_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "agent_mod_events_reputation_id_idx" ON "agent_moderation_events" USING btree ("agent_reputation_id");--> statement-breakpoint
CREATE INDEX "agent_mod_events_event_type_idx" ON "agent_moderation_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "agent_mod_events_flag_type_idx" ON "agent_moderation_events" USING btree ("flag_type");--> statement-breakpoint
CREATE INDEX "agent_mod_events_severity_idx" ON "agent_moderation_events" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "agent_mod_events_created_at_idx" ON "agent_moderation_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_reputation_identifier_idx" ON "agent_reputation" USING btree ("agent_identifier");--> statement-breakpoint
CREATE INDEX "agent_reputation_chain_token_idx" ON "agent_reputation" USING btree ("chain_id","token_id");--> statement-breakpoint
CREATE INDEX "agent_reputation_wallet_address_idx" ON "agent_reputation" USING btree ("wallet_address");--> statement-breakpoint
CREATE INDEX "agent_reputation_organization_id_idx" ON "agent_reputation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "agent_reputation_status_idx" ON "agent_reputation" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agent_reputation_score_idx" ON "agent_reputation" USING btree ("reputation_score");--> statement-breakpoint
CREATE INDEX "agent_reputation_banned_at_idx" ON "agent_reputation" USING btree ("banned_at");--> statement-breakpoint
CREATE INDEX "agent_budget_txns_budget_idx" ON "agent_budget_transactions" USING btree ("budget_id");--> statement-breakpoint
CREATE INDEX "agent_budget_txns_agent_idx" ON "agent_budget_transactions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_budget_txns_type_idx" ON "agent_budget_transactions" USING btree ("type");--> statement-breakpoint
CREATE INDEX "agent_budget_txns_created_at_idx" ON "agent_budget_transactions" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_budgets_agent_idx" ON "agent_budgets" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_budgets_owner_org_idx" ON "agent_budgets" USING btree ("owner_org_id");--> statement-breakpoint
CREATE INDEX "agent_budgets_paused_idx" ON "agent_budgets" USING btree ("is_paused");