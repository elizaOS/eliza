#!/usr/bin/env bash
# Audits the pinned Eliza X hotfix lifecycle and retries only a terminal placement.
set -euo pipefail

agent_id=4602b3be-2c01-4e7e-9cdc-849604e1bef7
expected_image=ghcr.io/elizaos/eliza-demo@sha256:9b4baaaa657d1c79cee47eb00b6e2f46e2b24729ce7d9b0357e9611f27abdc49
database_url="$(sed -n 's/^DATABASE_URL=//p' /opt/eliza/cloud/.env.local | tail -1)"
database_url="${database_url/sslmode=no-verify/sslmode=require}"

psql "$database_url" -v ON_ERROR_STOP=1 -c \
  "SELECT id, status, node_id, container_name, docker_image, image_digest, lifecycle_job_id, error_message, updated_at FROM agent_sandboxes WHERE id = '$agent_id'"
psql "$database_url" -v ON_ERROR_STOP=1 -c \
  "SELECT id, type, status, max_attempts, error, created_at, updated_at, completed_at FROM jobs WHERE agent_id = '$agent_id' ORDER BY created_at DESC LIMIT 8"

psql "$database_url" -v ON_ERROR_STOP=1 <<SQL
BEGIN;
DO \$\$
DECLARE
  sandbox_status text;
  active_jobs integer;
  changed integer;
BEGIN
  SELECT status INTO sandbox_status
  FROM agent_sandboxes
  WHERE id = '$agent_id'
    AND docker_image = '$expected_image'
    AND replacement_cleanup_sandbox_id IS NULL;
  IF sandbox_status IS NULL THEN
    RAISE EXCEPTION 'pinned X hotfix image is not selected';
  END IF;
  SELECT count(*) INTO active_jobs
  FROM jobs
  WHERE agent_id = '$agent_id' AND status IN ('pending','in_progress');
  IF sandbox_status IN ('error', 'stopped') AND active_jobs = 0 THEN
    INSERT INTO jobs (
      type, status, data, data_storage, agent_id,
      organization_id, user_id, max_attempts, estimated_completion_at
    )
    SELECT
      'agent_restart', 'pending',
      jsonb_build_object(
        'agentId', sandbox.id,
        'organizationId', sandbox.organization_id::text,
        'userId', sandbox.user_id::text
      ),
      'inline', sandbox.id::text, sandbox.organization_id,
      sandbox.user_id, 3, NOW() + INTERVAL '90 seconds'
    FROM agent_sandboxes AS sandbox
    WHERE sandbox.id = '$agent_id'
      AND sandbox.docker_image = '$expected_image'
      AND sandbox.user_id IS NOT NULL;
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> 1 THEN
      RAISE EXCEPTION 'terminal X hotfix retry admission failed';
    END IF;
  ELSIF sandbox_status NOT IN ('running', 'provisioning') THEN
    RAISE EXCEPTION 'unexpected X hotfix lifecycle state: %', sandbox_status;
  END IF;
END \$\$;
COMMIT;
SELECT id, status, node_id, docker_image, lifecycle_job_id, error_message
FROM agent_sandboxes WHERE id = '$agent_id';
SELECT id, type, status, error
FROM jobs WHERE agent_id = '$agent_id' ORDER BY created_at DESC LIMIT 4;
SQL
