ALTER TABLE "app_sandbox_sessions" ADD COLUMN IF NOT EXISTS "initial_prompt_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "app_sandbox_sessions" ADD COLUMN IF NOT EXISTS "initial_prompt_key" text;
ALTER TABLE "app_sandbox_sessions" ADD COLUMN IF NOT EXISTS "claude_messages_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "app_sandbox_sessions" ADD COLUMN IF NOT EXISTS "claude_messages_key" text;

ALTER TABLE "app_builder_prompts" ADD COLUMN IF NOT EXISTS "content_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "app_builder_prompts" ADD COLUMN IF NOT EXISTS "content_key" text;

ALTER TABLE "session_file_snapshots" ADD COLUMN IF NOT EXISTS "content_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "session_file_snapshots" ADD COLUMN IF NOT EXISTS "content_key" text;

ALTER TABLE "phone_message_log" ADD COLUMN IF NOT EXISTS "message_body_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "phone_message_log" ADD COLUMN IF NOT EXISTS "message_body_key" text;
ALTER TABLE "phone_message_log" ADD COLUMN IF NOT EXISTS "media_urls_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "phone_message_log" ADD COLUMN IF NOT EXISTS "media_urls_key" text;
ALTER TABLE "phone_message_log" ADD COLUMN IF NOT EXISTS "agent_response_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "phone_message_log" ADD COLUMN IF NOT EXISTS "agent_response_key" text;
ALTER TABLE "phone_message_log" ADD COLUMN IF NOT EXISTS "metadata_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "phone_message_log" ADD COLUMN IF NOT EXISTS "metadata_key" text;

ALTER TABLE "twilio_inbound_calls" ADD COLUMN IF NOT EXISTS "raw_payload_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "twilio_inbound_calls" ADD COLUMN IF NOT EXISTS "raw_payload_key" text;

ALTER TABLE "seo_requests" ADD COLUMN IF NOT EXISTS "prompt_context_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "seo_requests" ADD COLUMN IF NOT EXISTS "prompt_context_key" text;

ALTER TABLE "seo_artifacts" ADD COLUMN IF NOT EXISTS "data_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "seo_artifacts" ADD COLUMN IF NOT EXISTS "data_key" text;

ALTER TABLE "seo_provider_calls" ADD COLUMN IF NOT EXISTS "request_payload_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "seo_provider_calls" ADD COLUMN IF NOT EXISTS "request_payload_key" text;
ALTER TABLE "seo_provider_calls" ADD COLUMN IF NOT EXISTS "response_payload_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "seo_provider_calls" ADD COLUMN IF NOT EXISTS "response_payload_key" text;

ALTER TABLE "vertex_tuning_jobs" ADD COLUMN IF NOT EXISTS "last_remote_payload_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "vertex_tuning_jobs" ADD COLUMN IF NOT EXISTS "last_remote_payload_key" text;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_sandbox_backups') THEN
    ALTER TABLE "agent_sandbox_backups" ADD COLUMN IF NOT EXISTS "state_data_storage" text DEFAULT 'inline' NOT NULL;
    ALTER TABLE "agent_sandbox_backups" ADD COLUMN IF NOT EXISTS "state_data_key" text;
  ELSIF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'eliza_sandbox_backups') THEN
    ALTER TABLE "eliza_sandbox_backups" ADD COLUMN IF NOT EXISTS "state_data_storage" text DEFAULT 'inline' NOT NULL;
    ALTER TABLE "eliza_sandbox_backups" ADD COLUMN IF NOT EXISTS "state_data_key" text;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "app_sandbox_sessions_user_app_created_idx"
  ON "app_sandbox_sessions" USING btree ("user_id", "app_id", "created_at");

CREATE INDEX IF NOT EXISTS "app_builder_prompts_session_created_idx"
  ON "app_builder_prompts" USING btree ("sandbox_session_id", "created_at");

CREATE INDEX IF NOT EXISTS "session_file_snapshots_hash_idx"
  ON "session_file_snapshots" USING btree ("content_hash");

CREATE INDEX IF NOT EXISTS "phone_message_log_phone_status_created_idx"
  ON "phone_message_log" USING btree ("phone_number_id", "status", "created_at");

CREATE INDEX IF NOT EXISTS "twilio_inbound_calls_agent_received_idx"
  ON "twilio_inbound_calls" USING btree ("agent_id", "received_at");

CREATE INDEX IF NOT EXISTS "seo_requests_org_status_created_idx"
  ON "seo_requests" USING btree ("organization_id", "status", "created_at");

CREATE INDEX IF NOT EXISTS "vertex_tuning_jobs_scope_status_updated_idx"
  ON "vertex_tuning_jobs" USING btree ("scope", "status", "updated_at");
