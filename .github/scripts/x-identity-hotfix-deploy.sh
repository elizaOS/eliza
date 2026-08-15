#!/usr/bin/env bash
# Reads the exact production-node logs for the pinned Eliza X provision attempt.
set -euo pipefail

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
containers_key="$(sed -n 's/^CONTAINERS_SSH_KEY=//p' /opt/eliza/cloud/.env.local | tail -1)"
printf '%s' "$containers_key" | base64 -d > "$work/key"
chmod 600 "$work/key"
curl --silent --show-error --fail --max-time 30 \
  --header "Authorization: Bearer $ELIZACLOUD_API_KEY" \
  --output "$work/node.json" \
  https://api.eliza.app/api/v1/admin/docker-nodes/eliza-core-prod-5
host="$(jq -er '.data.hostname' "$work/node.json")"
user="$(jq -er '.data.sshUser' "$work/node.json")"
port="$(jq -er '.data.sshPort' "$work/node.json")"
ssh -i "$work/key" -p "$port" \
  -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile="$work/known_hosts" \
  "$user@$host" \
  "set -euo pipefail; journalctl --since '2026-08-15 06:04:30 UTC' --no-pager | grep -E '4602b3be-2c01-4e7e-9cdc-849604e1bef7|9b4baaaa657d1c79cee47eb00b6e2f46e2b24729ce7d9b0357e9611f27abdc49|b4d19d85-3426-407f-88f7-7f4a4bac7778|693be71d-0035-4059-9eff-b20cfb16cc02|error|failed' | tail -300"
