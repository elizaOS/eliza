#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '%s\n' "operator target resolution failed" >&2
  exit 1
}

target_class="${TARGET_CLASS:-}"
expected_count="${EXPECTED_HOST_COUNT:-}"
control_host="${CONTROL_HOST:-}"
approved_ids="${APPROVED_SERVER_IDS:-}"
project_token="${PROJECT_HCLOUD_TOKEN:-}"
output_path="${OUTPUT_PATH:-}"

case "$target_class" in data-plane|apps) ;; *) fail ;; esac
[[ "$expected_count" =~ ^[1-9][0-9]*$ ]] || fail
[ -n "$control_host" ] && [ -n "$approved_ids" ] && [ -n "$project_token" ] && [ -n "$output_path" ] || fail

umask 077
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/operator-targets.XXXXXX")" || fail
cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT HUP INT TERM

ids_path="$work_dir/approved-ids"
printf '%s\n' "$approved_ids" | awk 'NF { print }' > "$ids_path"
while IFS= read -r server_id; do
  [[ "$server_id" =~ ^[1-9][0-9]*$ ]] || fail
done < "$ids_path"
sort -n -u -o "$ids_path" "$ids_path"
[ "$(awk 'NF { count += 1 } END { print count + 0 }' "$ids_path")" -eq "$expected_count" ] || fail

targets_path="$work_dir/targets"
: > "$targets_path"
while IFS= read -r server_id; do
  response="$({ curl --fail --silent --show-error \
    -H "Authorization: Bearer $project_token" \
    "https://api.hetzner.cloud/v1/servers/$server_id"; } 2>/dev/null)" || fail
  [ "$(jq -r '.server.id // empty' <<<"$response")" = "$server_id" ] || fail
  [ "$(jq -r '.server.status // empty' <<<"$response")" = running ] || fail

  case "$target_class" in
    data-plane)
      jq -e --arg control_host "$control_host" \
        '.server | select(.name | test("^eliza-core-[0-9a-f]{8}$")) | select(.public_net.ipv4.ip != $control_host) | .public_net.ipv4.ip | strings | length > 0' \
        <<<"$response" >/dev/null || fail
      jq -r '[.server.public_net.ipv4.ip, "direct"] | @tsv' <<<"$response" >> "$targets_path"
      ;;
    apps)
      jq -e --arg control_host "$control_host" \
        '.server as $server | select(["app-node", "apps-control", "apps-worker", "tenant-db"] | index($server.labels.role)) | if $server.public_net.ipv4.ip == $control_host then ($server.public_net.ipv4.ip | strings | length > 0) else (($server.private_net | map(.ip) | first) | strings | length > 0) end' \
        <<<"$response" >/dev/null || fail
      jq -r --arg control_host "$control_host" \
        '.server | if .public_net.ipv4.ip == $control_host then [.public_net.ipv4.ip, "direct"] else [(.private_net | map(.ip) | first), "proxy"] end | @tsv' \
        <<<"$response" >> "$targets_path"
      ;;
  esac
done < "$ids_path"

sort -u -o "$targets_path" "$targets_path"
[ "$(awk 'NF { count += 1 } END { print count + 0 }' "$targets_path")" -eq "$expected_count" ] || fail
mv -- "$targets_path" "$output_path"
