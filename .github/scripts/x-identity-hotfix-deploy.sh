#!/usr/bin/env bash
# Replaces the macOS-xattr X layer after proving its failed candidate absent.
set -euo pipefail

agent_id=4602b3be-2c01-4e7e-9cdc-849604e1bef7
failed_job=693be71d-0035-4059-9eff-b20cfb16cc02
bad_image=ghcr.io/elizaos/eliza-demo@sha256:9b4baaaa657d1c79cee47eb00b6e2f46e2b24729ce7d9b0357e9611f27abdc49
clean_digest=sha256:7ac3474cc7520a489918a506fb8fd48c3ddd5bafe7d91c4c2e43a976872a3ba0
clean_image="ghcr.io/elizaos/eliza-demo@$clean_digest"
database_url="$(sed -n 's/^DATABASE_URL=//p' /opt/eliza/cloud/.env.local | tail -1)"
database_url="${database_url/sslmode=no-verify/sslmode=require}"
organization_id="$(psql "$database_url" -v ON_ERROR_STOP=1 -Atc "SELECT organization_id FROM agent_sandboxes WHERE id = '$agent_id' AND status = 'provisioning' AND docker_image = '$bad_image' AND replacement_cleanup_sandbox_id = 'agent-$agent_id' AND replacement_cleanup_node_id = 'eliza-core-prod-5' AND replacement_cleanup_container_name = 'agent-$agent_id'")"
test -n "$organization_id"

psql "$database_url" -v ON_ERROR_STOP=1 <<SQL
BEGIN;
DO \$\$
DECLARE changed integer;
BEGIN
  UPDATE jobs
  SET status = 'failed',
      error = 'Operator superseded macOS-xattr X hotfix image',
      execution_quiesced_at = NOW(),
      completed_at = NOW(),
      updated_at = NOW()
  WHERE id = '$failed_job'
    AND agent_id = '$agent_id'
    AND type = 'agent_restart'
    AND status IN ('pending', 'in_progress')
    AND error = 'Agent replacement cleanup is still pending';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'exact xattr restart job did not match';
  END IF;
END \$\$;
COMMIT;
SQL

cd /opt/eliza
TARGET_AGENT_ID="$agent_id" TARGET_ORG_ID="$organization_id" \
  /home/deploy/.bun/bin/bun --env-file=cloud/.env.local -e '
    const { elizaSandboxService } = await import("./packages/cloud/shared/src/lib/services/eliza-sandbox.ts");
    await elizaSandboxService.convergeReplacementCleanupFence(
      process.env.TARGET_AGENT_ID,
      process.env.TARGET_ORG_ID,
    );
    process.stdout.write("exact xattr replacement cleanup converged\n");
    process.exit(0);
  '

psql "$database_url" -v ON_ERROR_STOP=1 <<SQL
BEGIN;
DO \$\$
DECLARE changed integer;
BEGIN
  UPDATE agent_sandboxes
  SET status = 'stopped',
      docker_image = '$clean_image',
      image_digest = '$clean_digest',
      lifecycle_job_id = NULL,
      lifecycle_execution_generation = NULL,
      error_message = NULL,
      updated_at = NOW()
  WHERE id = '$agent_id'
    AND organization_id = '$organization_id'
    AND status = 'provisioning'
    AND docker_image = '$bad_image'
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
    RAISE EXCEPTION 'clean X image transition did not match';
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
    AND sandbox.docker_image = '$clean_image'
    AND sandbox.user_id IS NOT NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'clean X restart admission failed';
  END IF;
END \$\$;
COMMIT;
SELECT id, status, docker_image, replacement_cleanup_sandbox_id
FROM agent_sandboxes WHERE id = '$agent_id';
SELECT id, type, status, error
FROM jobs WHERE agent_id = '$agent_id' ORDER BY created_at DESC LIMIT 4;
SQL
