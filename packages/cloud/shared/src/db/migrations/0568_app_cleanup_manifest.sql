-- Complete v2 cleanup plans stay on the existing root job; v1 historical jobs retain their prior semantics.
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
        AND data->>'version' IN ('1', '2')
    ) THEN
      RAISE EXCEPTION 'app deletion requires its original owned job' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_original_app_deletion_job() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.type = 'app_delete' OR (OLD.type IN ('app_db_deprovision', 'container_delete') AND OLD.data ? 'appDeletionJobId')) AND (
    NEW.id IS DISTINCT FROM OLD.id OR NEW.type IS DISTINCT FROM OLD.type
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR (NEW.user_id IS NOT NULL AND NEW.user_id IS DISTINCT FROM OLD.user_id)
    OR NEW.data_storage IS DISTINCT FROM OLD.data_storage OR NEW.data_key IS DISTINCT FROM OLD.data_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'original app deletion job identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD.type = 'app_delete' OR (OLD.type IN ('app_db_deprovision', 'container_delete') AND OLD.data ? 'appDeletionJobId')) AND NEW.data IS DISTINCT FROM OLD.data THEN
    IF NOT (OLD.type = 'app_delete' AND OLD.data->>'version' = '2'
      AND NOT (OLD.data ? 'frontendCleanupPlan') AND NEW.data ? 'frontendCleanupPlan'
      AND NEW.data - 'frontendCleanupPlan' = OLD.data
      AND NEW.result->>'appDeleted' = 'true') THEN
      RAISE EXCEPTION 'original app deletion job data is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.type = 'app_delete' AND OLD.data->>'version' = '2' THEN
    IF NEW.result->>'appDeleted' = 'true' THEN
      IF NOT (NEW.data ? 'frontendCleanupPlan')
        OR NEW.data->'frontendCleanupPlan'->>'version' IS DISTINCT FROM '1'
        OR jsonb_typeof(NEW.data->'frontendCleanupPlan'->'digest') IS DISTINCT FROM 'string'
        OR (NEW.data->'frontendCleanupPlan'->>'digest') !~ '^[a-f0-9]{64}$'
        OR jsonb_typeof(NEW.data->'frontendCleanupPlan'->'objectCount') IS DISTINCT FROM 'number'
        OR (NEW.data->'frontendCleanupPlan'->>'objectCount') !~ '^(0|[1-9][0-9]*)$'
        OR jsonb_typeof(NEW.result->'cleanupManifestDigest') IS DISTINCT FROM 'string'
        OR jsonb_typeof(NEW.result->'cleanupObjectCount') IS DISTINCT FROM 'number'
        OR jsonb_typeof(NEW.result->'cleanupCursor') IS DISTINCT FROM 'number'
        OR jsonb_typeof(NEW.result->'cleanupConfirmed') IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(NEW.data->'frontendCleanupPlan'->'deployments') IS DISTINCT FROM 'array'
        OR NEW.result->>'cleanupManifestDigest' IS DISTINCT FROM NEW.data->'frontendCleanupPlan'->>'digest'
        OR NEW.result->>'cleanupObjectCount' IS DISTINCT FROM NEW.data->'frontendCleanupPlan'->>'objectCount'
        OR NEW.result->>'cleanupCursor' IS NULL
        OR (NEW.result->>'cleanupCursor')::integer < 0
        OR (NEW.result->>'cleanupCursor')::integer > (NEW.result->>'cleanupObjectCount')::integer
        OR (NEW.result->>'cleanupConfirmed' = 'true') IS DISTINCT FROM ((NEW.result->>'cleanupCursor')::integer = (NEW.result->>'cleanupObjectCount')::integer)
        OR NEW.result_storage <> 'inline' OR NEW.result_key IS NOT NULL
      THEN RAISE EXCEPTION 'app deletion requires complete original cleanup authority' USING ERRCODE = '23514'; END IF;
      IF OLD.result->>'appDeleted' IS DISTINCT FROM 'true' AND (NEW.result->>'cleanupCursor')::integer <> 0 THEN
        RAISE EXCEPTION 'app cleanup must start with no unacknowledged progress' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF OLD.result->>'appDeleted' = 'true' AND (
      (NEW.result - 'cleanupCursor' - 'cleanupConfirmed') IS DISTINCT FROM (OLD.result - 'cleanupCursor' - 'cleanupConfirmed')
      OR NEW.result_storage IS DISTINCT FROM OLD.result_storage OR NEW.result_key IS DISTINCT FROM OLD.result_key
      OR (NEW.result->>'cleanupCursor')::integer < (OLD.result->>'cleanupCursor')::integer
      OR (NEW.result->>'cleanupCursor')::integer > (OLD.result->>'cleanupCursor')::integer + 1
      OR (OLD.result->>'cleanupConfirmed' = 'true' AND NEW.result->>'cleanupConfirmed' IS DISTINCT FROM 'true')
      OR (OLD.status = 'completed' AND NEW.status <> 'completed')
    ) THEN RAISE EXCEPTION 'original app cleanup receipt cannot change or rewind' USING ERRCODE = '23514'; END IF;
    IF NEW.status = 'completed' AND (NEW.result->>'appDeleted' IS DISTINCT FROM 'true' OR NEW.result->>'cleanupConfirmed' IS DISTINCT FROM 'true') THEN
      RAISE EXCEPTION 'app cleanup is not confirmed complete' USING ERRCODE = '23514';
    END IF;
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
    AND NOT (OLD.type = 'app_delete' AND OLD.data->>'version' = '2')
    AND (OLD.result->>'appDeletionConfirmed' = 'true' OR OLD.result->>'appDeleted' = 'true') AND
    (NEW.result IS DISTINCT FROM OLD.result OR NEW.result_storage IS DISTINCT FROM OLD.result_storage OR NEW.result_key IS DISTINCT FROM OLD.result_key
     OR (OLD.status = 'completed' AND NEW.status <> 'completed'))
  THEN RAISE EXCEPTION 'app deletion completion receipt is immutable' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION retain_original_app_cleanup_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.type = 'app_delete' AND OLD.data->>'version' = '2' AND
    (OLD.result_storage <> 'inline' OR OLD.result->>'cleanupConfirmed' IS DISTINCT FROM 'true'
     OR OLD.result->>'appDeleted' IS DISTINCT FROM 'true') THEN
    RAISE EXCEPTION 'original app cleanup must complete before its job or organization is removed' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER jobs_retain_original_app_cleanup BEFORE DELETE ON jobs
FOR EACH ROW EXECUTE FUNCTION retain_original_app_cleanup_job();

--> statement-breakpoint
ALTER TABLE app_frontend_deployments ADD COLUMN IF NOT EXISTS upload_generation uuid;
--> statement-breakpoint
ALTER TABLE app_frontend_deployments ADD COLUMN IF NOT EXISTS upload_plan jsonb;
--> statement-breakpoint
ALTER TABLE app_frontend_deployments ADD COLUMN IF NOT EXISTS upload_quiesced_at timestamp;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_frontend_original_upload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' AND NEW.status = 'pending' THEN
    RAISE EXCEPTION 'a started frontend cannot return to unstarted authority' USING ERRCODE = '23514';
  END IF;
  IF OLD.upload_generation IS NOT NULL THEN
    IF NEW.upload_generation IS DISTINCT FROM OLD.upload_generation
      OR NEW.upload_plan IS DISTINCT FROM OLD.upload_plan
      OR NEW.r2_prefix IS DISTINCT FROM OLD.r2_prefix
      OR NEW.app_id IS DISTINCT FROM OLD.app_id
      OR (OLD.upload_quiesced_at IS NOT NULL AND NEW.upload_quiesced_at IS DISTINCT FROM OLD.upload_quiesced_at)
      OR (NEW.manifest IS NOT NULL AND NEW.manifest IS DISTINCT FROM OLD.upload_plan)
      OR (NEW.status IN ('ready', 'active', 'superseded') AND NEW.upload_quiesced_at IS NULL)
    THEN RAISE EXCEPTION 'original frontend upload plan and quiescence are immutable' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER app_frontend_original_upload_guard BEFORE UPDATE ON app_frontend_deployments
FOR EACH ROW EXECUTE FUNCTION guard_frontend_original_upload();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION retain_unquiesced_frontend_upload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('uploading', 'failed') AND OLD.upload_quiesced_at IS NULL THEN
    RAISE EXCEPTION 'original frontend upload is not confirmed quiescent' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER app_frontend_unquiesced_upload_guard BEFORE DELETE ON app_frontend_deployments
FOR EACH ROW EXECUTE FUNCTION retain_unquiesced_frontend_upload();
