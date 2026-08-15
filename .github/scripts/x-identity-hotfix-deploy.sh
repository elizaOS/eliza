#!/usr/bin/env bash
# Replaces the exact serving Eliza X image with the ownership-repair bundle.
set -euo pipefail

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
agent_id=4602b3be-2c01-4e7e-9cdc-849604e1bef7
old_image=ghcr.io/elizaos/eliza-demo@sha256:ef8891f02762177004a9250d3b297dee9999ec50d61b615937774802a7ad8e86
new_digest=sha256:9ab5513662a1dc99a5140597fde9cb3ef1c762877585b4f2874eeb78ebb9d387
new_image="ghcr.io/elizaos/eliza-demo@$new_digest"
database_url="$(sed -n 's/^DATABASE_URL=//p' /opt/eliza/cloud/.env.local | tail -1)"
database_url="${database_url/sslmode=no-verify/sslmode=require}"
readarray -t placement < <(psql "$database_url" -v ON_ERROR_STOP=1 -Atc \
  "SELECT node_id, container_name FROM agent_sandboxes WHERE id = '$agent_id' AND status = 'running' AND docker_image = '$old_image' AND replacement_cleanup_sandbox_id IS NULL AND EXISTS (SELECT 1 FROM agent_sandbox_backups WHERE sandbox_record_id = '$agent_id') AND NOT EXISTS (SELECT 1 FROM jobs WHERE agent_id = '$agent_id' AND status IN ('pending','in_progress'))")
test "${#placement[@]}" -eq 1
IFS='|' read -r node_id container_name <<<"${placement[0]}"
test "$container_name" = "agent-$agent_id"

psql "$database_url" -v ON_ERROR_STOP=1 <<SQL
BEGIN;
DO \$\$
DECLARE changed integer;
BEGIN
  UPDATE agent_sandboxes
  SET status = 'provisioning', lifecycle_job_id = NULL,
      lifecycle_execution_generation = NULL,
      error_message = 'Operator staging X ownership repair', updated_at = NOW()
  WHERE id = '$agent_id' AND status = 'running'
    AND node_id = '$node_id' AND container_name = '$container_name'
    AND docker_image = '$old_image' AND replacement_cleanup_sandbox_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM jobs WHERE agent_id = '$agent_id' AND status IN ('pending','in_progress'));
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'exact serving X placement did not match'; END IF;
END \$\$;
COMMIT;
SQL

containers_key="$(sed -n 's/^CONTAINERS_SSH_KEY=//p' /opt/eliza/cloud/.env.local | tail -1)"
printf '%s' "$containers_key" | base64 -d > "$work/key"
chmod 600 "$work/key"
curl --silent --show-error --fail --max-time 30 \
  --header "Authorization: Bearer $ELIZACLOUD_API_KEY" \
  --output "$work/node.json" \
  "https://api.eliza.app/api/v1/admin/docker-nodes/$node_id"
node_host="$(jq -er '.data.hostname' "$work/node.json")"
node_user="$(jq -er '.data.sshUser' "$work/node.json")"
node_port="$(jq -er '.data.sshPort' "$work/node.json")"
ssh -i "$work/key" -p "$node_port" -o BatchMode=yes \
  -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$work/known_hosts" \
  "$node_user@$node_host" \
  "set -euo pipefail; test \"\$(docker inspect --format '{{.Config.Image}}' '$container_name')\" = '$old_image'; docker stop --time 20 '$container_name' >/dev/null; docker rm '$container_name' >/dev/null; test -z \"\$(docker ps -aq --filter 'name=^/$container_name\$')\""

psql "$database_url" -v ON_ERROR_STOP=1 <<SQL
BEGIN;
DO \$\$
DECLARE changed integer;
BEGIN
  UPDATE agent_sandboxes
  SET status = 'stopped', sandbox_id = NULL, bridge_url = NULL,
      health_url = NULL, node_id = NULL, container_name = NULL,
      bridge_port = NULL, web_ui_port = NULL, headscale_ip = NULL,
      docker_image = '$new_image', image_digest = '$new_digest',
      previous_docker_image = NULL, previous_image_digest = NULL,
      error_message = NULL, updated_at = NOW()
  WHERE id = '$agent_id' AND status = 'provisioning'
    AND node_id = '$node_id' AND container_name = '$container_name'
    AND docker_image = '$old_image'
    AND NOT EXISTS (SELECT 1 FROM jobs WHERE agent_id = '$agent_id' AND status IN ('pending','in_progress'));
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'staged X ownership repair did not match'; END IF;
  INSERT INTO jobs (type, status, data, data_storage, agent_id,
    organization_id, user_id, max_attempts, estimated_completion_at)
  SELECT 'agent_restart', 'pending',
    jsonb_build_object('agentId', sandbox.id, 'organizationId', sandbox.organization_id::text, 'userId', sandbox.user_id::text),
    'inline', sandbox.id::text, sandbox.organization_id, sandbox.user_id, 3, NOW() + INTERVAL '90 seconds'
  FROM agent_sandboxes AS sandbox
  WHERE sandbox.id = '$agent_id' AND sandbox.status = 'stopped'
    AND sandbox.docker_image = '$new_image' AND sandbox.user_id IS NOT NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'X ownership repair restart admission failed'; END IF;
END \$\$;
COMMIT;
SELECT id, status, docker_image FROM agent_sandboxes WHERE id = '$agent_id';
SELECT id, type, status FROM jobs WHERE agent_id = '$agent_id' ORDER BY created_at DESC LIMIT 3;
SQL
