CREATE TYPE "public"."secret_actor_type" AS ENUM('user', 'api_key', 'system', 'deployment', 'workflow');--> statement-breakpoint
CREATE TYPE "public"."secret_audit_action" AS ENUM('created', 'read', 'updated', 'deleted', 'rotated');--> statement-breakpoint
CREATE TYPE "public"."secret_environment" AS ENUM('development', 'preview', 'production');--> statement-breakpoint
CREATE TYPE "public"."secret_project_type" AS ENUM('character', 'app', 'workflow', 'container', 'mcp');--> statement-breakpoint
CREATE TYPE "public"."secret_provider" AS ENUM('openai', 'anthropic', 'google', 'elevenlabs', 'fal', 'stripe', 'discord', 'telegram', 'twitter', 'github', 'slack', 'aws', 'vercel', 'custom');--> statement-breakpoint
CREATE TYPE "public"."secret_scope" AS ENUM('organization', 'project', 'environment');--> statement-breakpoint
CREATE TYPE "public"."reply_confirmation_status" AS ENUM('pending', 'confirmed', 'rejected', 'expired', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."social_engagement_type" AS ENUM('mention', 'reply', 'quote_tweet', 'repost', 'like', 'comment', 'follow');--> statement-breakpoint
CREATE TYPE "public"."domain_moderation_status" AS ENUM('clean', 'pending_review', 'flagged', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."domain_nameserver_mode" AS ENUM('vercel', 'external');--> statement-breakpoint
CREATE TYPE "public"."domain_registrar" AS ENUM('vercel', 'external');--> statement-breakpoint
CREATE TYPE "public"."domain_resource_type" AS ENUM('app', 'container', 'agent', 'mcp');--> statement-breakpoint
CREATE TYPE "public"."domain_status" AS ENUM('pending', 'active', 'expired', 'suspended', 'transferring');--> statement-breakpoint
CREATE TYPE "public"."domain_event_detected_by" AS ENUM('system', 'admin', 'user_report', 'automated_scan', 'health_monitor');--> statement-breakpoint
CREATE TYPE "public"."domain_event_severity" AS ENUM('info', 'low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."domain_event_type" AS ENUM('name_check', 'auto_flag', 'admin_flag', 'health_check', 'content_scan', 'user_report', 'suspension', 'reinstatement', 'dns_change', 'assignment_change', 'verification', 'renewal', 'expiration_warning');--> statement-breakpoint
CREATE TYPE "public"."platform_credential_status" AS ENUM('pending', 'active', 'expired', 'revoked', 'error');--> statement-breakpoint
CREATE TYPE "public"."platform_credential_type" AS ENUM('discord', 'telegram', 'twitter', 'gmail', 'slack', 'github', 'google', 'bluesky', 'reddit', 'facebook', 'instagram', 'tiktok', 'linkedin', 'mastodon', 'twilio', 'google_calendar');--> statement-breakpoint
CREATE TYPE "public"."org_agent_type" AS ENUM('community_manager', 'project_manager', 'dev_rel', 'liaison', 'social_media_manager');--> statement-breakpoint
CREATE TYPE "public"."org_checkin_frequency" AS ENUM('daily', 'weekdays', 'weekly', 'bi_weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."org_checkin_type" AS ENUM('standup', 'sprint', 'mental_health', 'project_status', 'retrospective');--> statement-breakpoint
CREATE TYPE "public"."org_platform_status" AS ENUM('active', 'disconnected', 'error', 'pending');--> statement-breakpoint
CREATE TYPE "public"."org_platform_type" AS ENUM('discord', 'telegram', 'slack', 'twitter');--> statement-breakpoint
CREATE TYPE "public"."org_todo_priority" AS ENUM('low', 'medium', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."org_todo_status" AS ENUM('pending', 'in_progress', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."seo_artifact_type" AS ENUM('keywords', 'meta', 'schema', 'serp_snapshot', 'health_report', 'indexnow_submission');--> statement-breakpoint
CREATE TYPE "public"."seo_provider" AS ENUM('dataforseo', 'serpapi', 'claude', 'indexnow', 'bing');--> statement-breakpoint
CREATE TYPE "public"."seo_provider_status" AS ENUM('pending', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."seo_request_status" AS ENUM('pending', 'in_progress', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."seo_request_type" AS ENUM('keyword_research', 'serp_snapshot', 'meta_generate', 'schema_generate', 'publish_bundle', 'index_now', 'health_check');--> statement-breakpoint
CREATE TABLE "app_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"request_type" text NOT NULL,
	"source" text DEFAULT 'api_key' NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"country" text,
	"city" text,
	"user_id" uuid,
	"model" text,
	"input_tokens" integer DEFAULT 0,
	"output_tokens" integer DEFAULT 0,
	"credits_used" numeric(10, 6) DEFAULT '0.00',
	"response_time_ms" integer,
	"status" text DEFAULT 'success' NOT NULL,
	"error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_secret_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"secret_name" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"provider" text NOT NULL,
	"provider_account_id" text,
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text,
	"token_type" text DEFAULT 'Bearer',
	"encryption_key_id" text NOT NULL,
	"encrypted_dek" text NOT NULL,
	"nonce" text NOT NULL,
	"auth_tag" text NOT NULL,
	"refresh_encrypted_dek" text,
	"refresh_nonce" text,
	"refresh_auth_tag" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"encrypted_provider_data" text,
	"provider_data_nonce" text,
	"provider_data_auth_tag" text,
	"last_used_at" timestamp,
	"last_refreshed_at" timestamp,
	"refresh_count" integer DEFAULT 0 NOT NULL,
	"is_valid" boolean DEFAULT true NOT NULL,
	"revoked_at" timestamp,
	"revoke_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret_id" uuid,
	"oauth_session_id" uuid,
	"organization_id" uuid NOT NULL,
	"action" "secret_audit_action" NOT NULL,
	"secret_name" text,
	"actor_type" "secret_actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"actor_email" text,
	"ip_address" text,
	"user_agent" text,
	"source" text,
	"request_id" text,
	"endpoint" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"secret_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_type" "secret_project_type" NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope" "secret_scope" DEFAULT 'organization' NOT NULL,
	"project_id" uuid,
	"project_type" text,
	"environment" "secret_environment",
	"name" text NOT NULL,
	"description" text,
	"provider" "secret_provider",
	"provider_metadata" jsonb,
	"encrypted_value" text NOT NULL,
	"encryption_key_id" text NOT NULL,
	"encrypted_dek" text NOT NULL,
	"nonce" text NOT NULL,
	"auth_tag" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"last_rotated_at" timestamp,
	"expires_at" timestamp,
	"created_by" uuid NOT NULL,
	"last_accessed_at" timestamp,
	"access_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"subdomain" text NOT NULL,
	"custom_domain" text,
	"custom_domain_verified" boolean DEFAULT false NOT NULL,
	"verification_records" jsonb DEFAULT '[]'::jsonb,
	"ssl_status" text DEFAULT 'pending' NOT NULL,
	"ssl_error" text,
	"vercel_project_id" text,
	"vercel_domain_id" text,
	"is_primary" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"verified_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "org_feed_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_platform" text NOT NULL,
	"source_account_id" text NOT NULL,
	"source_username" text,
	"credential_id" uuid,
	"monitor_mentions" boolean DEFAULT true NOT NULL,
	"monitor_replies" boolean DEFAULT true NOT NULL,
	"monitor_quote_tweets" boolean DEFAULT true NOT NULL,
	"monitor_reposts" boolean DEFAULT false NOT NULL,
	"monitor_likes" boolean DEFAULT false NOT NULL,
	"notification_channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"polling_interval_seconds" integer DEFAULT 60 NOT NULL,
	"min_follower_count" integer,
	"filter_keywords" jsonb DEFAULT '[]'::jsonb,
	"filter_mode" text DEFAULT 'include',
	"last_polled_at" timestamp with time zone,
	"last_seen_id" text,
	"poll_error_count" integer DEFAULT 0 NOT NULL,
	"last_poll_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "pending_reply_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"engagement_event_id" uuid,
	"target_platform" text NOT NULL,
	"target_post_id" text NOT NULL,
	"target_post_url" text,
	"source_platform" text NOT NULL,
	"source_channel_id" text NOT NULL,
	"source_server_id" text,
	"source_message_id" text NOT NULL,
	"source_user_id" text NOT NULL,
	"source_username" text,
	"source_user_display_name" text,
	"reply_content" text NOT NULL,
	"reply_media_urls" jsonb DEFAULT '[]'::jsonb,
	"status" "reply_confirmation_status" DEFAULT 'pending' NOT NULL,
	"confirmation_message_id" text,
	"confirmation_channel_id" text,
	"confirmed_by_user_id" text,
	"confirmed_by_username" text,
	"confirmed_at" timestamp with time zone,
	"rejection_reason" text,
	"sent_post_id" text,
	"sent_post_url" text,
	"sent_at" timestamp with time zone,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_engagement_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"feed_config_id" uuid NOT NULL,
	"event_type" "social_engagement_type" NOT NULL,
	"source_platform" text NOT NULL,
	"source_post_id" text NOT NULL,
	"source_post_url" text,
	"author_id" text NOT NULL,
	"author_username" text,
	"author_display_name" text,
	"author_avatar_url" text,
	"author_follower_count" integer,
	"author_verified" boolean DEFAULT false,
	"original_post_id" text,
	"original_post_url" text,
	"original_post_content" text,
	"content" text,
	"content_html" text,
	"media_urls" jsonb DEFAULT '[]'::jsonb,
	"processed_at" timestamp with time zone,
	"notification_sent_at" timestamp with time zone,
	"notification_channel_ids" jsonb DEFAULT '[]'::jsonb,
	"notification_message_ids" jsonb DEFAULT '{}'::jsonb,
	"raw_data" jsonb,
	"engagement_metrics" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_notification_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"engagement_event_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"channel_id" text NOT NULL,
	"server_id" text,
	"message_id" text NOT NULL,
	"thread_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"registrar" "domain_registrar" DEFAULT 'vercel' NOT NULL,
	"vercel_domain_id" text,
	"registered_at" timestamp,
	"expires_at" timestamp,
	"auto_renew" boolean DEFAULT true NOT NULL,
	"status" "domain_status" DEFAULT 'pending' NOT NULL,
	"registrant_info" jsonb,
	"resource_type" "domain_resource_type",
	"app_id" uuid,
	"container_id" uuid,
	"agent_id" uuid,
	"mcp_id" uuid,
	"nameserver_mode" "domain_nameserver_mode" DEFAULT 'vercel' NOT NULL,
	"dns_records" jsonb DEFAULT '[]'::jsonb,
	"ssl_status" text DEFAULT 'pending',
	"ssl_expires_at" timestamp,
	"verified" boolean DEFAULT false NOT NULL,
	"verification_token" text,
	"verified_at" timestamp,
	"moderation_status" "domain_moderation_status" DEFAULT 'clean' NOT NULL,
	"moderation_flags" jsonb DEFAULT '[]'::jsonb,
	"last_health_check" timestamp,
	"is_live" boolean DEFAULT false NOT NULL,
	"health_check_error" text,
	"content_hash" text,
	"last_content_scan_at" timestamp,
	"last_ai_scan_at" timestamp,
	"ai_scan_model" text,
	"content_scan_confidence" real,
	"content_scan_cache" jsonb,
	"suspended_at" timestamp,
	"suspension_reason" text,
	"suspension_notification" jsonb,
	"owner_notified_at" timestamp,
	"purchase_price" text,
	"renewal_price" text,
	"payment_method" text,
	"stripe_payment_intent_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "managed_domains_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE "domain_moderation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" uuid NOT NULL,
	"event_type" "domain_event_type" NOT NULL,
	"severity" "domain_event_severity" NOT NULL,
	"description" text NOT NULL,
	"detected_by" "domain_event_detected_by" NOT NULL,
	"admin_user_id" uuid,
	"evidence" jsonb,
	"action_taken" text,
	"previous_status" text,
	"new_status" text,
	"resolved_at" timestamp,
	"resolved_by" uuid,
	"resolution_notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_credential_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"app_id" uuid,
	"requesting_user_id" uuid,
	"platform" "platform_credential_type" NOT NULL,
	"requested_scopes" jsonb DEFAULT '[]'::jsonb,
	"oauth_state" text NOT NULL,
	"callback_url" text,
	"callback_type" text,
	"callback_context" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"credential_id" uuid,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "platform_credential_sessions_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "platform_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"app_id" uuid,
	"platform" "platform_credential_type" NOT NULL,
	"platform_user_id" text NOT NULL,
	"platform_username" text,
	"platform_display_name" text,
	"platform_avatar_url" text,
	"platform_email" text,
	"status" "platform_credential_status" DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"access_token_secret_id" uuid,
	"refresh_token_secret_id" uuid,
	"token_expires_at" timestamp,
	"scopes" jsonb DEFAULT '[]'::jsonb,
	"api_key_secret_id" uuid,
	"granted_permissions" jsonb DEFAULT '[]'::jsonb,
	"source_type" text,
	"source_context" jsonb,
	"profile_data" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"linked_at" timestamp,
	"last_used_at" timestamp,
	"last_refreshed_at" timestamp,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_checkin_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"responder_platform_id" text NOT NULL,
	"responder_platform" "org_platform_type" NOT NULL,
	"responder_name" text,
	"responder_avatar" text,
	"answers" jsonb NOT NULL,
	"sentiment_score" text,
	"blockers_detected" boolean DEFAULT false,
	"blockers" jsonb DEFAULT '[]'::jsonb,
	"source_message_id" text,
	"source_channel_id" text,
	"submitted_at" timestamp DEFAULT now() NOT NULL,
	"checkin_date" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_checkin_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"checkin_type" "org_checkin_type" DEFAULT 'standup' NOT NULL,
	"frequency" "org_checkin_frequency" DEFAULT 'weekdays' NOT NULL,
	"time_utc" text DEFAULT '09:00' NOT NULL,
	"timezone" text DEFAULT 'UTC',
	"checkin_channel_id" text NOT NULL,
	"report_channel_id" text,
	"questions" jsonb DEFAULT '["What did you accomplish yesterday?","What are you working on today?","Any blockers?"]'::jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp,
	"next_run_at" timestamp,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_platform_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connected_by" uuid NOT NULL,
	"platform" "org_platform_type" NOT NULL,
	"platform_bot_id" text NOT NULL,
	"platform_bot_username" text,
	"platform_bot_name" text,
	"status" "org_platform_status" DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"last_health_check" timestamp,
	"oauth_access_token_secret_id" uuid,
	"oauth_refresh_token_secret_id" uuid,
	"oauth_expires_at" timestamp,
	"oauth_scopes" jsonb DEFAULT '[]'::jsonb,
	"bot_token_secret_id" uuid,
	"metadata" jsonb,
	"connected_at" timestamp DEFAULT now() NOT NULL,
	"disconnected_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_platform_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"server_id" text NOT NULL,
	"server_name" text,
	"server_icon" text,
	"member_count" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"enabled_agents" jsonb DEFAULT '["community_manager","project_manager"]'::jsonb,
	"agent_settings" jsonb,
	"channel_mappings" jsonb,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_team_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"platform_user_id" text NOT NULL,
	"platform" "org_platform_type" NOT NULL,
	"display_name" text,
	"username" text,
	"avatar_url" text,
	"role" text,
	"is_admin" boolean DEFAULT false,
	"is_active" boolean DEFAULT true,
	"availability" jsonb,
	"total_checkins" text DEFAULT '0',
	"last_checkin_at" timestamp,
	"checkin_streak" text DEFAULT '0',
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_todos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"status" "org_todo_status" DEFAULT 'pending' NOT NULL,
	"priority" "org_todo_priority" DEFAULT 'medium' NOT NULL,
	"assignee_platform_id" text,
	"assignee_platform" "org_platform_type",
	"assignee_name" text,
	"due_date" timestamp,
	"source_platform" text,
	"source_server_id" text,
	"source_channel_id" text,
	"source_message_id" text,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"related_checkin_id" uuid,
	"related_project" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "ad_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connected_by_user_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_account_id" text NOT NULL,
	"account_name" text NOT NULL,
	"access_token_secret_id" uuid,
	"refresh_token_secret_id" uuid,
	"token_expires_at" timestamp,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"external_campaign_id" text,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"objective" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"budget_type" text NOT NULL,
	"budget_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"budget_currency" text DEFAULT 'USD' NOT NULL,
	"credits_allocated" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"credits_spent" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"start_date" timestamp,
	"end_date" timestamp,
	"targeting" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"total_spend" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"total_impressions" integer DEFAULT 0 NOT NULL,
	"total_clicks" integer DEFAULT 0 NOT NULL,
	"total_conversions" integer DEFAULT 0 NOT NULL,
	"app_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_creatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"external_creative_id" text,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"headline" text,
	"primary_text" text,
	"description" text,
	"call_to_action" text,
	"destination_url" text,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid,
	"credit_transaction_id" uuid,
	"type" text NOT NULL,
	"amount" numeric(12, 4) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"credits_amount" numeric(12, 4) NOT NULL,
	"description" text NOT NULL,
	"external_reference" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seo_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"type" "seo_artifact_type" NOT NULL,
	"provider" "seo_provider" NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seo_provider_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"provider" "seo_provider" NOT NULL,
	"operation" text NOT NULL,
	"status" "seo_provider_status" DEFAULT 'pending' NOT NULL,
	"external_id" text,
	"cost" numeric(10, 4) DEFAULT '0' NOT NULL,
	"request_payload" jsonb,
	"response_payload" jsonb,
	"error" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seo_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"app_id" uuid,
	"user_id" uuid,
	"api_key_id" uuid,
	"type" "seo_request_type" NOT NULL,
	"status" "seo_request_status" DEFAULT 'pending' NOT NULL,
	"page_url" text,
	"locale" text DEFAULT 'en-US' NOT NULL,
	"search_engine" text DEFAULT 'google' NOT NULL,
	"device" text DEFAULT 'desktop' NOT NULL,
	"environment" text DEFAULT 'production' NOT NULL,
	"agent_identifier" text,
	"keywords" jsonb DEFAULT '[]'::jsonb,
	"prompt_context" text,
	"idempotency_key" text,
	"total_cost" numeric(10, 4) DEFAULT '0' NOT NULL,
	"error" text,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_requests" ADD CONSTRAINT "app_requests_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_requests" ADD CONSTRAINT "app_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_secret_requirements" ADD CONSTRAINT "app_secret_requirements_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_secret_requirements" ADD CONSTRAINT "app_secret_requirements_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_sessions" ADD CONSTRAINT "oauth_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_sessions" ADD CONSTRAINT "oauth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_bindings" ADD CONSTRAINT "secret_bindings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_bindings" ADD CONSTRAINT "secret_bindings_secret_id_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_bindings" ADD CONSTRAINT "secret_bindings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_domains" ADD CONSTRAINT "app_domains_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_feed_configs" ADD CONSTRAINT "org_feed_configs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_feed_configs" ADD CONSTRAINT "org_feed_configs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_reply_confirmations" ADD CONSTRAINT "pending_reply_confirmations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_reply_confirmations" ADD CONSTRAINT "pending_reply_confirmations_engagement_event_id_social_engagement_events_id_fk" FOREIGN KEY ("engagement_event_id") REFERENCES "public"."social_engagement_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_engagement_events" ADD CONSTRAINT "social_engagement_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_engagement_events" ADD CONSTRAINT "social_engagement_events_feed_config_id_org_feed_configs_id_fk" FOREIGN KEY ("feed_config_id") REFERENCES "public"."org_feed_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_notification_messages" ADD CONSTRAINT "social_notification_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_notification_messages" ADD CONSTRAINT "social_notification_messages_engagement_event_id_social_engagement_events_id_fk" FOREIGN KEY ("engagement_event_id") REFERENCES "public"."social_engagement_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_domains" ADD CONSTRAINT "managed_domains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_domains" ADD CONSTRAINT "managed_domains_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_domains" ADD CONSTRAINT "managed_domains_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_domains" ADD CONSTRAINT "managed_domains_agent_id_user_characters_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."user_characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_domains" ADD CONSTRAINT "managed_domains_mcp_id_user_mcps_id_fk" FOREIGN KEY ("mcp_id") REFERENCES "public"."user_mcps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_moderation_events" ADD CONSTRAINT "domain_moderation_events_domain_id_managed_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."managed_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_moderation_events" ADD CONSTRAINT "domain_moderation_events_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_moderation_events" ADD CONSTRAINT "domain_moderation_events_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_credential_sessions" ADD CONSTRAINT "platform_credential_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_credential_sessions" ADD CONSTRAINT "platform_credential_sessions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_credential_sessions" ADD CONSTRAINT "platform_credential_sessions_requesting_user_id_users_id_fk" FOREIGN KEY ("requesting_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_credential_sessions" ADD CONSTRAINT "platform_credential_sessions_credential_id_platform_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."platform_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_credentials" ADD CONSTRAINT "platform_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_credentials" ADD CONSTRAINT "platform_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_credentials" ADD CONSTRAINT "platform_credentials_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_checkin_responses" ADD CONSTRAINT "org_checkin_responses_schedule_id_org_checkin_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."org_checkin_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_checkin_responses" ADD CONSTRAINT "org_checkin_responses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_checkin_schedules" ADD CONSTRAINT "org_checkin_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_checkin_schedules" ADD CONSTRAINT "org_checkin_schedules_server_id_org_platform_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."org_platform_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_checkin_schedules" ADD CONSTRAINT "org_checkin_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_platform_connections" ADD CONSTRAINT "org_platform_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_platform_connections" ADD CONSTRAINT "org_platform_connections_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_platform_servers" ADD CONSTRAINT "org_platform_servers_connection_id_org_platform_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."org_platform_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_platform_servers" ADD CONSTRAINT "org_platform_servers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_team_members" ADD CONSTRAINT "org_team_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_team_members" ADD CONSTRAINT "org_team_members_server_id_org_platform_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."org_platform_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_todos" ADD CONSTRAINT "org_todos_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_todos" ADD CONSTRAINT "org_todos_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_access_token_secret_id_secrets_id_fk" FOREIGN KEY ("access_token_secret_id") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_refresh_token_secret_id_secrets_id_fk" FOREIGN KEY ("refresh_token_secret_id") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_creatives" ADD CONSTRAINT "ad_creatives_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_transactions" ADD CONSTRAINT "ad_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_transactions" ADD CONSTRAINT "ad_transactions_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_transactions" ADD CONSTRAINT "ad_transactions_credit_transaction_id_credit_transactions_id_fk" FOREIGN KEY ("credit_transaction_id") REFERENCES "public"."credit_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_artifacts" ADD CONSTRAINT "seo_artifacts_request_id_seo_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."seo_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_provider_calls" ADD CONSTRAINT "seo_provider_calls_request_id_seo_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."seo_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_requests" ADD CONSTRAINT "seo_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_requests" ADD CONSTRAINT "seo_requests_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_requests" ADD CONSTRAINT "seo_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_requests" ADD CONSTRAINT "seo_requests_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_requests_app_id_idx" ON "app_requests" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "app_requests_created_at_idx" ON "app_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "app_requests_type_idx" ON "app_requests" USING btree ("request_type");--> statement-breakpoint
CREATE INDEX "app_requests_source_idx" ON "app_requests" USING btree ("source");--> statement-breakpoint
CREATE INDEX "app_requests_ip_idx" ON "app_requests" USING btree ("ip_address");--> statement-breakpoint
CREATE INDEX "app_requests_app_created_idx" ON "app_requests" USING btree ("app_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "app_secret_requirements_app_secret_idx" ON "app_secret_requirements" USING btree ("app_id","secret_name");--> statement-breakpoint
CREATE INDEX "app_secret_requirements_app_idx" ON "app_secret_requirements" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "app_secret_requirements_approved_idx" ON "app_secret_requirements" USING btree ("approved");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_sessions_org_provider_idx" ON "oauth_sessions" USING btree ("organization_id","provider","user_id");--> statement-breakpoint
CREATE INDEX "oauth_sessions_user_provider_idx" ON "oauth_sessions" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "oauth_sessions_provider_idx" ON "oauth_sessions" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "oauth_sessions_expires_idx" ON "oauth_sessions" USING btree ("access_token_expires_at");--> statement-breakpoint
CREATE INDEX "oauth_sessions_valid_idx" ON "oauth_sessions" USING btree ("is_valid");--> statement-breakpoint
CREATE INDEX "secret_audit_log_secret_idx" ON "secret_audit_log" USING btree ("secret_id");--> statement-breakpoint
CREATE INDEX "secret_audit_log_oauth_idx" ON "secret_audit_log" USING btree ("oauth_session_id");--> statement-breakpoint
CREATE INDEX "secret_audit_log_org_idx" ON "secret_audit_log" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "secret_audit_log_action_idx" ON "secret_audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "secret_audit_log_actor_idx" ON "secret_audit_log" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "secret_audit_log_created_at_idx" ON "secret_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "secret_audit_log_org_action_time_idx" ON "secret_audit_log" USING btree ("organization_id","action","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "secret_bindings_secret_project_idx" ON "secret_bindings" USING btree ("secret_id","project_id","project_type");--> statement-breakpoint
CREATE INDEX "secret_bindings_org_idx" ON "secret_bindings" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "secret_bindings_project_idx" ON "secret_bindings" USING btree ("project_id","project_type");--> statement-breakpoint
CREATE INDEX "secret_bindings_secret_idx" ON "secret_bindings" USING btree ("secret_id");--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_org_name_project_env_idx" ON "secrets" USING btree ("organization_id","name","project_id","environment");--> statement-breakpoint
CREATE INDEX "secrets_org_idx" ON "secrets" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "secrets_project_idx" ON "secrets" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "secrets_scope_idx" ON "secrets" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "secrets_env_idx" ON "secrets" USING btree ("environment");--> statement-breakpoint
CREATE INDEX "secrets_name_idx" ON "secrets" USING btree ("name");--> statement-breakpoint
CREATE INDEX "secrets_expires_idx" ON "secrets" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "secrets_provider_idx" ON "secrets" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "app_domains_app_id_idx" ON "app_domains" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_domains_subdomain_idx" ON "app_domains" USING btree ("subdomain");--> statement-breakpoint
CREATE UNIQUE INDEX "app_domains_custom_domain_idx" ON "app_domains" USING btree ("custom_domain");--> statement-breakpoint
CREATE INDEX "app_domains_vercel_domain_idx" ON "app_domains" USING btree ("vercel_domain_id");--> statement-breakpoint
CREATE INDEX "org_feed_configs_org_idx" ON "org_feed_configs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "org_feed_configs_enabled_idx" ON "org_feed_configs" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "org_feed_configs_platform_idx" ON "org_feed_configs" USING btree ("source_platform");--> statement-breakpoint
CREATE UNIQUE INDEX "org_feed_configs_unique" ON "org_feed_configs" USING btree ("organization_id","source_platform","source_account_id");--> statement-breakpoint
CREATE INDEX "pending_reply_confirmations_org_idx" ON "pending_reply_confirmations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "pending_reply_confirmations_status_idx" ON "pending_reply_confirmations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "pending_reply_confirmations_engagement_idx" ON "pending_reply_confirmations" USING btree ("engagement_event_id");--> statement-breakpoint
CREATE INDEX "pending_reply_confirmations_source_msg_idx" ON "pending_reply_confirmations" USING btree ("source_platform","source_channel_id","source_message_id");--> statement-breakpoint
CREATE INDEX "social_engagement_events_org_idx" ON "social_engagement_events" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "social_engagement_events_feed_idx" ON "social_engagement_events" USING btree ("feed_config_id");--> statement-breakpoint
CREATE INDEX "social_engagement_events_type_idx" ON "social_engagement_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "social_engagement_events_created_idx" ON "social_engagement_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "social_engagement_events_author_idx" ON "social_engagement_events" USING btree ("author_id");--> statement-breakpoint
CREATE UNIQUE INDEX "social_engagement_events_unique" ON "social_engagement_events" USING btree ("feed_config_id","source_post_id");--> statement-breakpoint
CREATE INDEX "social_notification_messages_org_idx" ON "social_notification_messages" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "social_notification_messages_engagement_idx" ON "social_notification_messages" USING btree ("engagement_event_id");--> statement-breakpoint
CREATE INDEX "social_notification_messages_lookup_idx" ON "social_notification_messages" USING btree ("platform","channel_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "social_notification_messages_unique" ON "social_notification_messages" USING btree ("engagement_event_id","platform","channel_id","message_id");--> statement-breakpoint
CREATE INDEX "managed_domains_org_idx" ON "managed_domains" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_domains_domain_idx" ON "managed_domains" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "managed_domains_app_idx" ON "managed_domains" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "managed_domains_container_idx" ON "managed_domains" USING btree ("container_id");--> statement-breakpoint
CREATE INDEX "managed_domains_agent_idx" ON "managed_domains" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "managed_domains_mcp_idx" ON "managed_domains" USING btree ("mcp_id");--> statement-breakpoint
CREATE INDEX "managed_domains_status_idx" ON "managed_domains" USING btree ("status");--> statement-breakpoint
CREATE INDEX "managed_domains_moderation_idx" ON "managed_domains" USING btree ("moderation_status");--> statement-breakpoint
CREATE INDEX "managed_domains_expires_idx" ON "managed_domains" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "managed_domains_content_scan_idx" ON "managed_domains" USING btree ("last_content_scan_at");--> statement-breakpoint
CREATE INDEX "managed_domains_suspended_idx" ON "managed_domains" USING btree ("suspended_at");--> statement-breakpoint
CREATE INDEX "domain_mod_events_domain_idx" ON "domain_moderation_events" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "domain_mod_events_type_idx" ON "domain_moderation_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "domain_mod_events_severity_idx" ON "domain_moderation_events" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "domain_mod_events_created_idx" ON "domain_moderation_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "domain_mod_events_unresolved_idx" ON "domain_moderation_events" USING btree ("resolved_at");--> statement-breakpoint
CREATE INDEX "platform_credential_sessions_session_idx" ON "platform_credential_sessions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "platform_credential_sessions_org_idx" ON "platform_credential_sessions" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_credential_sessions_oauth_state_idx" ON "platform_credential_sessions" USING btree ("oauth_state");--> statement-breakpoint
CREATE INDEX "platform_credential_sessions_status_idx" ON "platform_credential_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "platform_credential_sessions_expires_idx" ON "platform_credential_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "platform_credentials_org_idx" ON "platform_credentials" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "platform_credentials_user_idx" ON "platform_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "platform_credentials_app_idx" ON "platform_credentials" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_credentials_platform_user_idx" ON "platform_credentials" USING btree ("organization_id","platform","platform_user_id");--> statement-breakpoint
CREATE INDEX "platform_credentials_status_idx" ON "platform_credentials" USING btree ("status");--> statement-breakpoint
CREATE INDEX "org_checkin_responses_schedule_idx" ON "org_checkin_responses" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "org_checkin_responses_org_idx" ON "org_checkin_responses" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "org_checkin_responses_responder_idx" ON "org_checkin_responses" USING btree ("responder_platform_id","responder_platform");--> statement-breakpoint
CREATE INDEX "org_checkin_responses_date_idx" ON "org_checkin_responses" USING btree ("checkin_date");--> statement-breakpoint
CREATE INDEX "org_checkin_schedules_org_idx" ON "org_checkin_schedules" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "org_checkin_schedules_server_idx" ON "org_checkin_schedules" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "org_checkin_schedules_enabled_idx" ON "org_checkin_schedules" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "org_checkin_schedules_next_run_idx" ON "org_checkin_schedules" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "org_platform_connections_org_idx" ON "org_platform_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "org_platform_connections_platform_idx" ON "org_platform_connections" USING btree ("platform");--> statement-breakpoint
CREATE UNIQUE INDEX "org_platform_connections_unique" ON "org_platform_connections" USING btree ("organization_id","platform","platform_bot_id");--> statement-breakpoint
CREATE INDEX "org_platform_connections_status_idx" ON "org_platform_connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "org_platform_servers_connection_idx" ON "org_platform_servers" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "org_platform_servers_org_idx" ON "org_platform_servers" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "org_platform_servers_server_id_idx" ON "org_platform_servers" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_platform_servers_unique" ON "org_platform_servers" USING btree ("connection_id","server_id");--> statement-breakpoint
CREATE INDEX "org_platform_servers_enabled_idx" ON "org_platform_servers" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "org_team_members_org_idx" ON "org_team_members" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "org_team_members_server_idx" ON "org_team_members" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "org_team_members_platform_user_idx" ON "org_team_members" USING btree ("platform_user_id","platform");--> statement-breakpoint
CREATE UNIQUE INDEX "org_team_members_unique" ON "org_team_members" USING btree ("server_id","platform_user_id","platform");--> statement-breakpoint
CREATE INDEX "org_todos_org_idx" ON "org_todos" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "org_todos_status_idx" ON "org_todos" USING btree ("status");--> statement-breakpoint
CREATE INDEX "org_todos_assignee_idx" ON "org_todos" USING btree ("assignee_platform_id","assignee_platform");--> statement-breakpoint
CREATE INDEX "org_todos_due_date_idx" ON "org_todos" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "org_todos_created_by_idx" ON "org_todos" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "ad_accounts_organization_idx" ON "ad_accounts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ad_accounts_platform_idx" ON "ad_accounts" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "ad_accounts_org_platform_idx" ON "ad_accounts" USING btree ("organization_id","platform");--> statement-breakpoint
CREATE INDEX "ad_accounts_external_id_idx" ON "ad_accounts" USING btree ("external_account_id");--> statement-breakpoint
CREATE INDEX "ad_accounts_status_idx" ON "ad_accounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ad_campaigns_organization_idx" ON "ad_campaigns" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ad_campaigns_ad_account_idx" ON "ad_campaigns" USING btree ("ad_account_id");--> statement-breakpoint
CREATE INDEX "ad_campaigns_platform_idx" ON "ad_campaigns" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "ad_campaigns_status_idx" ON "ad_campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ad_campaigns_external_id_idx" ON "ad_campaigns" USING btree ("external_campaign_id");--> statement-breakpoint
CREATE INDEX "ad_campaigns_app_idx" ON "ad_campaigns" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "ad_campaigns_created_at_idx" ON "ad_campaigns" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ad_campaigns_org_status_idx" ON "ad_campaigns" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "ad_creatives_campaign_idx" ON "ad_creatives" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "ad_creatives_type_idx" ON "ad_creatives" USING btree ("type");--> statement-breakpoint
CREATE INDEX "ad_creatives_status_idx" ON "ad_creatives" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ad_creatives_external_id_idx" ON "ad_creatives" USING btree ("external_creative_id");--> statement-breakpoint
CREATE INDEX "ad_creatives_created_at_idx" ON "ad_creatives" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ad_transactions_organization_idx" ON "ad_transactions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ad_transactions_campaign_idx" ON "ad_transactions" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "ad_transactions_credit_tx_idx" ON "ad_transactions" USING btree ("credit_transaction_id");--> statement-breakpoint
CREATE INDEX "ad_transactions_type_idx" ON "ad_transactions" USING btree ("type");--> statement-breakpoint
CREATE INDEX "ad_transactions_created_at_idx" ON "ad_transactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ad_transactions_org_type_idx" ON "ad_transactions" USING btree ("organization_id","type");--> statement-breakpoint
CREATE INDEX "seo_artifacts_request_idx" ON "seo_artifacts" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "seo_artifacts_type_idx" ON "seo_artifacts" USING btree ("type");--> statement-breakpoint
CREATE INDEX "seo_provider_calls_request_idx" ON "seo_provider_calls" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "seo_provider_calls_provider_idx" ON "seo_provider_calls" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "seo_provider_calls_status_idx" ON "seo_provider_calls" USING btree ("status");--> statement-breakpoint
CREATE INDEX "seo_requests_org_idx" ON "seo_requests" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "seo_requests_app_idx" ON "seo_requests" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "seo_requests_type_idx" ON "seo_requests" USING btree ("type");--> statement-breakpoint
CREATE INDEX "seo_requests_status_idx" ON "seo_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "seo_requests_idempotency_idx" ON "seo_requests" USING btree ("organization_id","idempotency_key");