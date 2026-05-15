ALTER TABLE "org_feed_configs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pending_reply_confirmations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "social_engagement_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "social_notification_messages" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "domain_moderation_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_checkin_responses" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_checkin_schedules" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_platform_connections" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_platform_servers" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_team_members" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_todos" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "n8n_workflow"."credential_mappings" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE IF EXISTS "org_feed_configs" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "pending_reply_confirmations" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "social_engagement_events" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "social_notification_messages" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "domain_moderation_events" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "org_checkin_responses" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "org_checkin_schedules" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "org_platform_connections" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "org_platform_servers" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "org_team_members" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "org_todos" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "n8n_workflow"."credential_mappings" CASCADE;--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_anonymous_session_id_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "organizations_stripe_customer_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "organizations_auto_top_up_enabled_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "users_privy_user_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "users_anonymous_session_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "users_expires_at_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "users_work_function_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "users_telegram_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "users_phone_number_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "users_discord_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "apps_user_database_status_idx";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "webhook_url";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "webhook_secret";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "tax_id_type";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "tax_id_value";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "billing_address";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "auto_top_up_subscription_id";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "max_api_requests";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "max_tokens_per_request";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "allowed_models";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "allowed_providers";--> statement-breakpoint
ALTER TABLE "apps" DROP COLUMN IF EXISTS "features_enabled";--> statement-breakpoint
ALTER TABLE "apps" DROP COLUMN IF EXISTS "rate_limit_per_minute";--> statement-breakpoint
ALTER TABLE "apps" DROP COLUMN IF EXISTS "rate_limit_per_hour";--> statement-breakpoint

DROP TYPE IF EXISTS "public"."reply_confirmation_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."social_engagement_type";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."domain_event_detected_by";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."domain_event_severity";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."domain_event_type";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."org_agent_type";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."org_checkin_frequency";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."org_checkin_type";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."org_platform_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."org_platform_type";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."org_todo_priority";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."org_todo_status";--> statement-breakpoint
DROP SCHEMA IF EXISTS "n8n_workflow";
