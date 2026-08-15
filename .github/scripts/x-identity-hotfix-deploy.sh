#!/usr/bin/env bash
# Enqueues the pinned Eliza X runtime after its replacement fence is retired.
set -euo pipefail

agent_id=4602b3be-2c01-4e7e-9cdc-849604e1bef7
expected_image=ghcr.io/elizaos/eliza-demo@sha256:9b4baaaa657d1c79cee47eb00b6e2f46e2b24729ce7d9b0357e9611f27abdc49
database_url="$(sed -n 's/^DATABASE_URL=//p' /opt/eliza/cloud/.env.local | tail -1)"
database_url="${database_url/sslmode=no-verify/sslmode=require}"

psql "$database_url" -v ON_ERROR_STOP=1 <<SQL
BEGIN;
DO \$\$
DECLARE changed integer;
BEGIN
  UPDATE agent_sandboxes
  SET status = 'stopped',
      lifecycle_job_id = NULL,
      lifecycle_execution_generation = NULL,
      error_message = NULL,
      updated_at = NOW()
  WHERE id = '$agent_id'
    AND status = 'provisioning'
    AND docker_image = '$expected_image'
    AND node_id IS NULL
    AND container_name IS NULL
    AND replacement_cleanup_sandbox_id IS NULL
    AND replacement_cleanup_node_id IS NULL
    AND replacement_cleanup_container_name IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM jobs
      WHERE agent_id = '$agent_id' AND status IN ('pending','in_progress')
    );
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'retired X placement did not match';
  END IF;
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
    AND sandbox.status = 'stopped'
    AND sandbox.docker_image = '$expected_image'
    AND sandbox.user_id IS NOT NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'exact X restart retry admission failed';
  END IF;
END \$\$;
COMMIT;
SELECT id, status, docker_image, replacement_cleanup_sandbox_id
FROM agent_sandboxes WHERE id = '$agent_id';
SELECT id, type, status, error
FROM jobs WHERE agent_id = '$agent_id' ORDER BY created_at DESC LIMIT 4;
SQL
