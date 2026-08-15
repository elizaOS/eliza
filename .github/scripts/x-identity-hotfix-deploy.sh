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
  "set -euo pipefail; test \"\$(docker inspect --format '{{.Config.Image}}' '$container_name')\" = '$expected_image'; docker exec '$container_name' sh -lc 'cd /app && bun -e '\''import postgres from \"postgres\"; const sql=postgres(process.env.ELIZA_MANAGED_DATABASE_URL,{max:1}); const query=\"SELECT r.id::text AS room_id,r.world_id::text AS room_world_id,w.id::text AS world_id,w.name,w.metadata FROM rooms r LEFT JOIN worlds w ON w.id=r.world_id WHERE r.id IN (\\$1::uuid,\\$2::uuid) OR jsonb_extract_path_text(w.metadata,\\$5,\\$6) IN (\\$3,\\$4) ORDER BY r.created_at DESC\"; const rows=await sql.unsafe(query,[\"47f5526f-c192-04ca-aa63-12283ea6f010\",\"d81c82a8-6992-0632-94bd-c23a925f1c04\",\"1519007261917650945\",\"1830340867737178112\",\"ownership\",\"ownerId\"]); console.log(JSON.stringify(rows)); await sql.end();'\'''"
