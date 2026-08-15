#!/usr/bin/env bash
# Inspects the exact lifecycle state of the ownership-repair rollout.
set -euo pipefail

agent_id=4602b3be-2c01-4e7e-9cdc-849604e1bef7
expected_image=ghcr.io/elizaos/eliza-demo@sha256:9ab5513662a1dc99a5140597fde9cb3ef1c762877585b4f2874eeb78ebb9d387
database_url="$(sed -n 's/^DATABASE_URL=//p' /opt/eliza/cloud/.env.local | tail -1)"
database_url="${database_url/sslmode=no-verify/sslmode=require}"

psql "$database_url" -v ON_ERROR_STOP=1 -P pager=off <<SQL
SELECT id, status, node_id, container_name, headscale_ip, docker_image,
       lifecycle_job_id, lifecycle_execution_generation, error_message,
       replacement_cleanup_sandbox_id, replacement_cleanup_node_id,
       replacement_cleanup_container_name, replacement_cleanup_vpn_node_id,
       replacement_cleanup_attempt_id, updated_at
FROM agent_sandboxes
WHERE id = '$agent_id' AND docker_image = '$expected_image';

SELECT id, type, status, attempts, error, execution_generation,
       execution_quiesced_at, created_at, updated_at, completed_at
FROM jobs
WHERE agent_id = '$agent_id'
ORDER BY created_at DESC
LIMIT 5;
SQL

journalctl --since '15 minutes ago' --no-pager 2>/dev/null \
  | grep -E "$agent_id|Headscale|headscale" \
  | tail -n 240 || true
