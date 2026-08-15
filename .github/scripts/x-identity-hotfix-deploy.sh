#!/usr/bin/env bash
# Inspects the live X container's database tooling without exposing credentials.
set -euo pipefail

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
agent_id=4602b3be-2c01-4e7e-9cdc-849604e1bef7
expected_image=ghcr.io/elizaos/eliza-demo@sha256:2c069963295ab5fab774b135f89b93bd0f2184c56d8afee5950448748dbb8db3
database_url="$(sed -n 's/^DATABASE_URL=//p' /opt/eliza/cloud/.env.local | tail -1)"
database_url="${database_url/sslmode=no-verify/sslmode=require}"
readarray -t placement < <(psql "$database_url" -v ON_ERROR_STOP=1 -Atc \
  "SELECT node_id, container_name FROM agent_sandboxes WHERE id = '$agent_id' AND status = 'running' AND docker_image = '$expected_image'")
test "${#placement[@]}" -eq 1
IFS='|' read -r node_id container_name <<<"${placement[0]}"

containers_key="$(sed -n 's/^CONTAINERS_SSH_KEY=//p' /opt/eliza/cloud/.env.local | tail -1)"
printf '%s' "$containers_key" | base64 -d > "$work/key"
chmod 600 "$work/key"
curl -fsS --max-time 30 -H "Authorization: Bearer $ELIZACLOUD_API_KEY" \
  -o "$work/node.json" "https://api.eliza.app/api/v1/admin/docker-nodes/$node_id"
node_host="$(jq -er '.data.hostname' "$work/node.json")"
node_user="$(jq -er '.data.sshUser' "$work/node.json")"
node_port="$(jq -er '.data.sshPort' "$work/node.json")"
ssh -i "$work/key" -p "$node_port" -o BatchMode=yes \
  -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$work/known_hosts" \
  "$node_user@$node_host" \
  "set -euo pipefail; test \"\$(docker inspect --format '{{.Config.Image}}' '$container_name')\" = '$expected_image'; docker exec '$container_name' sh -lc 'cd /app && bun -e '\''for (const name of [\"postgres\",\"pg\",\"@electric-sql/pglite\"]) { try { await import(name); console.log(name + \"=available\"); } catch { console.log(name + \"=missing\"); } }'\'''"
