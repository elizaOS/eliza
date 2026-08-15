#!/usr/bin/env bash
# Inspects the final Eliza X image lifecycle without mutating it.
set -euo pipefail

agent_id=4602b3be-2c01-4e7e-9cdc-849604e1bef7
database_url="$(sed -n 's/^DATABASE_URL=//p' /opt/eliza/cloud/.env.local | tail -1)"
database_url="${database_url/sslmode=no-verify/sslmode=require}"
psql "$database_url" -v ON_ERROR_STOP=1 -x -c \
  "SELECT id, status, node_id, container_name, sandbox_id, bridge_url, docker_image, image_digest, lifecycle_job_id, lifecycle_execution_generation, error_message, replacement_cleanup_sandbox_id, replacement_cleanup_node_id, replacement_cleanup_container_name, replacement_cleanup_attempt_id, updated_at FROM agent_sandboxes WHERE id = '$agent_id'"
psql "$database_url" -v ON_ERROR_STOP=1 -x -c \
  "SELECT id, type, status, max_attempts, execution_generation, execution_quiesced_at, error, created_at, updated_at, completed_at FROM jobs WHERE agent_id = '$agent_id' ORDER BY created_at DESC LIMIT 5"
