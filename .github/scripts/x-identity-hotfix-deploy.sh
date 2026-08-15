#!/usr/bin/env bash
# Converges the failed legacy-runtime candidate and admits one clean retry.
set -euo pipefail

agent_id=4602b3be-2c01-4e7e-9cdc-849604e1bef7
failed_job=e8f0ff89-f463-4b4a-8d81-e5af6c1e960b
expected_image=ghcr.io/elizaos/eliza-demo@sha256:2c069963295ab5fab774b135f89b93bd0f2184c56d8afee5950448748dbb8db3
database_url="$(sed -n 's/^DATABASE_URL=//p' /opt/eliza/cloud/.env.local | tail -1)"
database_url="${database_url/sslmode=no-verify/sslmode=require}"
organization_id="$(psql "$database_url" -v ON_ERROR_STOP=1 -Atc "SELECT organization_id FROM agent_sandboxes WHERE id = '$agent_id' AND status = 'provisioning' AND docker_image = '$expected_image' AND replacement_cleanup_sandbox_id = 'agent-$agent_id' AND replacement_cleanup_node_id = 'eliza-core-prod-5' AND replacement_cleanup_container_name = 'agent-$agent_id'")"
test -n "$organization_id"

psql "$database_url" -v ON_ERROR_STOP=1 <<SQL
BEGIN;
UPDATE jobs
SET status = 'failed', error = 'Operator retrying legacy-runtime image after Headscale cleanup',
    execution_quiesced_at = NOW(), completed_at = NOW(), updated_at = NOW()
WHERE id = '$failed_job' AND agent_id = '$agent_id' AND type = 'agent_restart'
  AND status IN ('pending', 'in_progress')
  AND error = 'Agent replacement cleanup is still pending';
COMMIT;
SQL

cd /opt/eliza
TARGET_AGENT_ID="$agent_id" TARGET_ORG_ID="$organization_id" \
  /home/deploy/.bun/bin/bun --env-file=cloud/.env.local -e '
    const { elizaSandboxService } = await import("./packages/cloud/shared/src/lib/services/eliza-sandbox.ts");
    await elizaSandboxService.convergeReplacementCleanupFence(process.env.TARGET_AGENT_ID, process.env.TARGET_ORG_ID);
    process.stdout.write("legacy-runtime X cleanup converged\n");
    process.exit(0);
  '

psql "$database_url" -v ON_ERROR_STOP=1 <<SQL
BEGIN;
DO \$\$
DECLARE changed integer;
BEGIN
  UPDATE agent_sandboxes
  SET status = 'stopped', lifecycle_job_id = NULL,
      lifecycle_execution_generation = NULL, error_message = NULL, updated_at = NOW()
  WHERE id = '$agent_id' AND status = 'provisioning'
    AND docker_image = '$expected_image' AND node_id IS NULL AND container_name IS NULL
    AND replacement_cleanup_sandbox_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM jobs WHERE agent_id = '$agent_id' AND status IN ('pending','in_progress'));
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'retired legacy-runtime X placement did not match'; END IF;
  INSERT INTO jobs (type, status, data, data_storage, agent_id,
    organization_id, user_id, max_attempts, estimated_completion_at)
  SELECT 'agent_restart', 'pending',
    jsonb_build_object('agentId', sandbox.id, 'organizationId', sandbox.organization_id::text, 'userId', sandbox.user_id::text),
    'inline', sandbox.id::text, sandbox.organization_id, sandbox.user_id, 3, NOW() + INTERVAL '90 seconds'
  FROM agent_sandboxes AS sandbox
  WHERE sandbox.id = '$agent_id' AND sandbox.status = 'stopped'
    AND sandbox.docker_image = '$expected_image' AND sandbox.user_id IS NOT NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'legacy-runtime X retry admission failed'; END IF;
END \$\$;
COMMIT;
SELECT id, status, docker_image FROM agent_sandboxes WHERE id = '$agent_id';
SELECT id, type, status, error FROM jobs WHERE agent_id = '$agent_id' ORDER BY created_at DESC LIMIT 4;
SQL
