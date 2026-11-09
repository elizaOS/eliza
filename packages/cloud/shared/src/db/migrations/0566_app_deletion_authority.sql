ALTER TABLE "apps" ADD COLUMN "deletion_job_id" uuid;
--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_deletion_job_id_jobs_id_fk"
  FOREIGN KEY ("deletion_job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_original_app_deletion" ON "jobs" ("organization_id", ("data"->>'appId'))
  WHERE "type" = 'app_delete';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_app_deletion_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.deletion_job_id IS NOT NULL
     AND NEW.deletion_job_id IS DISTINCT FROM OLD.deletion_job_id THEN
    RAISE EXCEPTION 'app deletion authority is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.deletion_job_id IS NOT NULL AND (
    NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.github_repo IS DISTINCT FROM OLD.github_repo
    OR NEW.api_key_id IS DISTINCT FROM OLD.api_key_id
  ) THEN RAISE EXCEPTION 'original app deletion resource identity is immutable' USING ERRCODE = '23514'; END IF;
  IF NEW.deletion_job_id IS NOT NULL THEN
    IF NEW.is_active IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'an app being deleted cannot be reactivated' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM jobs WHERE id = NEW.deletion_job_id AND type = 'app_delete'
        AND organization_id = NEW.organization_id AND data_storage = 'inline'
        AND data->>'appId' = NEW.id::text AND data->>'organizationId' = NEW.organization_id::text
        AND data->>'version' = '1'
    ) THEN
      RAISE EXCEPTION 'app deletion requires its original owned job' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER apps_deletion_authority_guard BEFORE INSERT OR UPDATE ON apps
FOR EACH ROW EXECUTE FUNCTION guard_app_deletion_authority();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_original_app_deletion_job() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.type = 'app_delete' OR (OLD.type IN ('app_db_deprovision', 'container_delete') AND OLD.data ? 'appDeletionJobId')) AND (
    NEW.id IS DISTINCT FROM OLD.id OR NEW.type IS DISTINCT FROM OLD.type
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR (NEW.user_id IS NOT NULL AND NEW.user_id IS DISTINCT FROM OLD.user_id) OR NEW.data IS DISTINCT FROM OLD.data
    OR NEW.data_storage IS DISTINCT FROM OLD.data_storage OR NEW.data_key IS DISTINCT FROM OLD.data_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'original app deletion job identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.type = 'app_delete' AND OLD.result->>'revocationsConfirmed' = 'true' AND NEW.result->>'revocationsConfirmed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'app revocation receipt is immutable' USING ERRCODE = '23514'; END IF;
  IF OLD.type = 'app_delete' AND OLD.result ? 'deletionPlan' AND (
    NEW.result->'deletionPlan' IS DISTINCT FROM OLD.result->'deletionPlan'
    OR NEW.result->'originalGitHubRepo' IS DISTINCT FROM OLD.result->'originalGitHubRepo'
    OR NEW.result->'githubRequired' IS DISTINCT FROM OLD.result->'githubRequired'
    OR NEW.result_storage <> 'inline' OR NEW.result_key IS NOT NULL
  ) THEN RAISE EXCEPTION 'original app deletion plan is immutable' USING ERRCODE = '23514'; END IF;
  IF OLD.type = 'app_delete' AND OLD.result ? 'githubDeletion' AND
    (NEW.result->'githubDeletion'->'identity' IS DISTINCT FROM OLD.result->'githubDeletion'->'identity'
     OR (OLD.result->'githubDeletion'->>'dispatched' = 'true' AND NEW.result->'githubDeletion'->>'dispatched' IS DISTINCT FROM 'true')
     OR (OLD.result->'githubDeletion'->>'confirmed' = 'true' AND NEW.result->'githubDeletion'->>'confirmed' IS DISTINCT FROM 'true'))
  THEN RAISE EXCEPTION 'original repository deletion identity is immutable' USING ERRCODE = '23514'; END IF;
  IF (OLD.type = 'app_delete' OR (OLD.type IN ('app_db_deprovision', 'container_delete') AND OLD.data ? 'appDeletionJobId'))
    AND (OLD.result->>'appDeletionConfirmed' = 'true' OR OLD.result->>'appDeleted' = 'true') AND
    (NEW.result IS DISTINCT FROM OLD.result OR NEW.result_storage IS DISTINCT FROM OLD.result_storage OR NEW.result_key IS DISTINCT FROM OLD.result_key
     OR (OLD.status = 'completed' AND NEW.status <> 'completed'))
  THEN RAISE EXCEPTION 'app deletion completion receipt is immutable' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER jobs_original_app_deletion_guard BEFORE UPDATE ON jobs
FOR EACH ROW EXECUTE FUNCTION guard_original_app_deletion_job();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_app_deletion_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deletion_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM jobs WHERE id = OLD.deletion_job_id AND type = 'app_delete'
      AND organization_id = OLD.organization_id AND result_storage = 'inline'
      AND result->>'appDeleted' = 'true' AND result->>'appId' = OLD.id::text
      AND result->>'deletionJobId' = OLD.deletion_job_id::text
  ) THEN RAISE EXCEPTION 'app deletion requires its original completion receipt' USING ERRCODE = '23514'; END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER apps_deletion_receipt_guard BEFORE DELETE ON apps
FOR EACH ROW EXECUTE FUNCTION guard_app_deletion_receipt();
