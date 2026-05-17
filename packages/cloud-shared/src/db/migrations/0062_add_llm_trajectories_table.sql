CREATE TABLE IF NOT EXISTS "llm_trajectories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "user_id" uuid,
  "api_key_id" uuid,
  "model" text NOT NULL,
  "provider" text NOT NULL,
  "purpose" text,
  "request_id" text,
  "system_prompt" text,
  "user_prompt" text,
  "response_text" text,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  "total_tokens" integer DEFAULT 0 NOT NULL,
  "input_cost" numeric(12, 6) DEFAULT '0.000000',
  "output_cost" numeric(12, 6) DEFAULT '0.000000',
  "total_cost" numeric(12, 6) DEFAULT '0.000000',
  "latency_ms" integer,
  "is_successful" boolean DEFAULT true NOT NULL,
  "error_message" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "llm_trajectories_org_created_idx" ON "llm_trajectories" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "llm_trajectories_org_model_idx" ON "llm_trajectories" ("organization_id", "model");
CREATE INDEX IF NOT EXISTS "llm_trajectories_purpose_idx" ON "llm_trajectories" ("purpose");
CREATE INDEX IF NOT EXISTS "llm_trajectories_org_purpose_created_idx" ON "llm_trajectories" ("organization_id", "purpose", "created_at");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'llm_trajectories_organization_id_organizations_id_fk') THEN
    ALTER TABLE "llm_trajectories" ADD CONSTRAINT "llm_trajectories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'llm_trajectories_user_id_users_id_fk') THEN
    ALTER TABLE "llm_trajectories" ADD CONSTRAINT "llm_trajectories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'llm_trajectories_api_key_id_api_keys_id_fk') THEN
    ALTER TABLE "llm_trajectories" ADD CONSTRAINT "llm_trajectories_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
