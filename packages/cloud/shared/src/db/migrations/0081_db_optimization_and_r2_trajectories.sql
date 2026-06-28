-- Usage analytics: persisted canonical keys (aligned with model-id-translation.ts)
ALTER TABLE "usage_records" ADD COLUMN IF NOT EXISTS "canonical_model" text GENERATED ALWAYS AS (
  CASE
    WHEN model IS NULL OR model::text = '' THEN '__null__'
    WHEN position('/'::text in model::text) > 0 THEN
      CASE
        WHEN model::text LIKE 'xai/%' THEN 'x-ai/' || substring(model::text from 5)
        WHEN model::text LIKE 'mistral/%' THEN 'mistralai/' || substring(model::text from 9)
        ELSE model
      END
    ELSE model
  END
) STORED;

ALTER TABLE "usage_records" ADD COLUMN IF NOT EXISTS "canonical_provider" text GENERATED ALWAYS AS (
  CASE provider
    WHEN 'x-ai' THEN 'xai'
    WHEN 'mistralai' THEN 'mistral'
    ELSE provider
  END
) STORED;

CREATE INDEX IF NOT EXISTS "usage_records_org_canonical_model_created_idx" ON "usage_records" USING btree ("organization_id","canonical_model","created_at");
CREATE INDEX IF NOT EXISTS "usage_records_org_canonical_provider_created_idx" ON "usage_records" USING btree ("organization_id","canonical_provider","created_at");

-- LLM trajectories: optional R2 blob storage for prompt/response bodies (Postgres keeps metadata + pointer)
ALTER TABLE "llm_trajectories" ADD COLUMN IF NOT EXISTS "trajectory_payload_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "llm_trajectories" ADD COLUMN IF NOT EXISTS "trajectory_payload_key" text;

-- Heavy immutable payloads: keep DB rows queryable, move large static bodies/results/logs to object storage
ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "content_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "content_key" text;
ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "api_request_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "api_request_key" text;
ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "api_response_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "api_response_key" text;

ALTER TABLE "generations" ADD COLUMN IF NOT EXISTS "prompt_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "generations" ADD COLUMN IF NOT EXISTS "prompt_key" text;
ALTER TABLE "generations" ADD COLUMN IF NOT EXISTS "negative_prompt_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "generations" ADD COLUMN IF NOT EXISTS "negative_prompt_key" text;
ALTER TABLE "generations" ADD COLUMN IF NOT EXISTS "result_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "generations" ADD COLUMN IF NOT EXISTS "result_key" text;
ALTER TABLE "generations" ADD COLUMN IF NOT EXISTS "content_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "generations" ADD COLUMN IF NOT EXISTS "content_key" text;

ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "result_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "result_key" text;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "error_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "error_key" text;

ALTER TABLE "containers" ADD COLUMN IF NOT EXISTS "deployment_log_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "containers" ADD COLUMN IF NOT EXISTS "deployment_log_key" text;

ALTER TABLE "agent_events" ADD COLUMN IF NOT EXISTS "message_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "agent_events" ADD COLUMN IF NOT EXISTS "message_key" text;
ALTER TABLE "agent_events" ADD COLUMN IF NOT EXISTS "metadata_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "agent_events" ADD COLUMN IF NOT EXISTS "metadata_key" text;

-- Redundant with UNIQUE(event_id)
DROP INDEX IF EXISTS "webhook_events_event_id_idx";

CREATE INDEX IF NOT EXISTS "users_anonymous_session_id_partial_idx" ON "users" USING btree ("anonymous_session_id") WHERE ("anonymous_session_id" IS NOT NULL);

CREATE INDEX IF NOT EXISTS "jobs_type_status_scheduled_idx" ON "jobs" USING btree ("type","status","scheduled_for");
CREATE INDEX IF NOT EXISTS "jobs_pending_claim_idx" ON "jobs" USING btree ("type","scheduled_for","created_at") WHERE ("status" = 'pending');
