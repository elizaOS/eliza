BEGIN;

CREATE TYPE "public"."vertex_tuning_job_state" AS ENUM(
  'JOB_STATE_PENDING',
  'JOB_STATE_RUNNING',
  'JOB_STATE_SUCCEEDED',
  'JOB_STATE_FAILED',
  'JOB_STATE_CANCELLED'
);

CREATE TYPE "public"."vertex_tuning_scope" AS ENUM('global', 'organization', 'user');

CREATE TYPE "public"."vertex_tuning_slot" AS ENUM(
  'should_respond',
  'response_handler',
  'action_planner',
  'planner',
  'response',
  'media_description'
);

CREATE TABLE "vertex_tuning_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "vertex_job_name" text NOT NULL,
  "project_id" text NOT NULL,
  "region" text NOT NULL,
  "display_name" text NOT NULL,
  "base_model" text NOT NULL,
  "slot" "vertex_tuning_slot" NOT NULL,
  "scope" "vertex_tuning_scope" NOT NULL,
  "organization_id" uuid,
  "user_id" uuid,
  "created_by_user_id" uuid,
  "training_data_path" text NOT NULL,
  "validation_data_path" text,
  "training_data_uri" text,
  "validation_data_uri" text,
  "recommended_model_id" text,
  "tuned_model_display_name" text,
  "tuned_model_endpoint_name" text,
  "status" "vertex_tuning_job_state" DEFAULT 'JOB_STATE_PENDING' NOT NULL,
  "error_code" integer,
  "error_message" text,
  "model_preference_patch" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "last_remote_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "vertex_tuning_jobs_scope_owner_check" CHECK (
    (
      ("scope" = 'global' AND "organization_id" IS NULL AND "user_id" IS NULL) OR
      ("scope" = 'organization' AND "organization_id" IS NOT NULL AND "user_id" IS NULL) OR
      ("scope" = 'user' AND "organization_id" IS NOT NULL AND "user_id" IS NOT NULL)
    )
  )
);

CREATE TABLE "vertex_tuned_models" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tuning_job_id" uuid,
  "vertex_model_id" text NOT NULL,
  "display_name" text NOT NULL,
  "base_model" text NOT NULL,
  "project_id" text NOT NULL,
  "region" text NOT NULL,
  "slot" "vertex_tuning_slot" NOT NULL,
  "source_scope" "vertex_tuning_scope" NOT NULL,
  "organization_id" uuid,
  "user_id" uuid,
  "model_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "vertex_tuned_models_scope_owner_check" CHECK (
    (
      ("source_scope" = 'global' AND "organization_id" IS NULL AND "user_id" IS NULL) OR
      ("source_scope" = 'organization' AND "organization_id" IS NOT NULL AND "user_id" IS NULL) OR
      ("source_scope" = 'user' AND "organization_id" IS NOT NULL AND "user_id" IS NOT NULL)
    )
  )
);

CREATE TABLE "vertex_model_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "scope" "vertex_tuning_scope" NOT NULL,
  "slot" "vertex_tuning_slot" NOT NULL,
  "organization_id" uuid,
  "user_id" uuid,
  "tuned_model_id" uuid NOT NULL,
  "assigned_by_user_id" uuid,
  "is_active" boolean DEFAULT true NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "activated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deactivated_at" timestamp with time zone,
  CONSTRAINT "vertex_model_assignments_scope_owner_check" CHECK (
    (
      ("scope" = 'global' AND "organization_id" IS NULL AND "user_id" IS NULL) OR
      ("scope" = 'organization' AND "organization_id" IS NOT NULL AND "user_id" IS NULL) OR
      ("scope" = 'user' AND "organization_id" IS NOT NULL AND "user_id" IS NOT NULL)
    )
  )
);

ALTER TABLE "vertex_tuning_jobs"
  ADD CONSTRAINT "vertex_tuning_jobs_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "vertex_tuning_jobs"
  ADD CONSTRAINT "vertex_tuning_jobs_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "vertex_tuning_jobs"
  ADD CONSTRAINT "vertex_tuning_jobs_created_by_user_id_users_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;

ALTER TABLE "vertex_tuned_models"
  ADD CONSTRAINT "vertex_tuned_models_tuning_job_id_vertex_tuning_jobs_id_fk"
  FOREIGN KEY ("tuning_job_id") REFERENCES "public"."vertex_tuning_jobs"("id")
  ON DELETE set null ON UPDATE no action;

ALTER TABLE "vertex_tuned_models"
  ADD CONSTRAINT "vertex_tuned_models_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "vertex_tuned_models"
  ADD CONSTRAINT "vertex_tuned_models_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "vertex_model_assignments"
  ADD CONSTRAINT "vertex_model_assignments_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "vertex_model_assignments"
  ADD CONSTRAINT "vertex_model_assignments_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "vertex_model_assignments"
  ADD CONSTRAINT "vertex_model_assignments_tuned_model_id_vertex_tuned_models_id_fk"
  FOREIGN KEY ("tuned_model_id") REFERENCES "public"."vertex_tuned_models"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "vertex_model_assignments"
  ADD CONSTRAINT "vertex_model_assignments_assigned_by_user_id_users_id_fk"
  FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;

CREATE UNIQUE INDEX "vertex_tuning_jobs_vertex_job_name_idx"
  ON "vertex_tuning_jobs" USING btree ("vertex_job_name");
CREATE INDEX "vertex_tuning_jobs_status_idx"
  ON "vertex_tuning_jobs" USING btree ("status");
CREATE INDEX "vertex_tuning_jobs_scope_idx"
  ON "vertex_tuning_jobs" USING btree ("scope");
CREATE INDEX "vertex_tuning_jobs_organization_idx"
  ON "vertex_tuning_jobs" USING btree ("organization_id");
CREATE INDEX "vertex_tuning_jobs_user_idx"
  ON "vertex_tuning_jobs" USING btree ("user_id");
CREATE INDEX "vertex_tuning_jobs_created_by_idx"
  ON "vertex_tuning_jobs" USING btree ("created_by_user_id");
CREATE INDEX "vertex_tuning_jobs_slot_idx"
  ON "vertex_tuning_jobs" USING btree ("slot");
CREATE INDEX "vertex_tuning_jobs_created_at_idx"
  ON "vertex_tuning_jobs" USING btree ("created_at");

CREATE UNIQUE INDEX "vertex_tuned_models_vertex_model_id_idx"
  ON "vertex_tuned_models" USING btree ("vertex_model_id");
CREATE INDEX "vertex_tuned_models_tuning_job_idx"
  ON "vertex_tuned_models" USING btree ("tuning_job_id");
CREATE INDEX "vertex_tuned_models_slot_idx"
  ON "vertex_tuned_models" USING btree ("slot");
CREATE INDEX "vertex_tuned_models_source_scope_idx"
  ON "vertex_tuned_models" USING btree ("source_scope");
CREATE INDEX "vertex_tuned_models_organization_idx"
  ON "vertex_tuned_models" USING btree ("organization_id");
CREATE INDEX "vertex_tuned_models_user_idx"
  ON "vertex_tuned_models" USING btree ("user_id");

CREATE INDEX "vertex_model_assignments_tuned_model_idx"
  ON "vertex_model_assignments" USING btree ("tuned_model_id");
CREATE INDEX "vertex_model_assignments_scope_idx"
  ON "vertex_model_assignments" USING btree ("scope");
CREATE INDEX "vertex_model_assignments_slot_idx"
  ON "vertex_model_assignments" USING btree ("slot");
CREATE INDEX "vertex_model_assignments_organization_idx"
  ON "vertex_model_assignments" USING btree ("organization_id");
CREATE INDEX "vertex_model_assignments_user_idx"
  ON "vertex_model_assignments" USING btree ("user_id");
CREATE INDEX "vertex_model_assignments_active_idx"
  ON "vertex_model_assignments" USING btree ("is_active");
CREATE UNIQUE INDEX "vertex_model_assignments_global_slot_active_idx"
  ON "vertex_model_assignments" USING btree ("slot")
  WHERE "vertex_model_assignments"."scope" = 'global' AND "vertex_model_assignments"."is_active" = true;
CREATE UNIQUE INDEX "vertex_model_assignments_org_slot_active_idx"
  ON "vertex_model_assignments" USING btree ("organization_id", "slot")
  WHERE "vertex_model_assignments"."scope" = 'organization' AND "vertex_model_assignments"."is_active" = true;
CREATE UNIQUE INDEX "vertex_model_assignments_user_slot_active_idx"
  ON "vertex_model_assignments" USING btree ("user_id", "slot")
  WHERE "vertex_model_assignments"."scope" = 'user' AND "vertex_model_assignments"."is_active" = true;

COMMIT;
