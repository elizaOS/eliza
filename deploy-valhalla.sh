#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: deploy-valhalla.sh --repo OWNER/REPO --ref BRANCH [--environment NAME]

Dispatch deploy-valhalla.yml for the remote branch and watch the correlated run.
The environment defaults to github-pages.
Requires gh authentication with Actions access, jq, python3, and timeout.
VALHALLA_DISCOVERY_ATTEMPTS (default 30, maximum 120) and
VALHALLA_DISCOVERY_INTERVAL (default 2, maximum 60 seconds) control polling.
VALHALLA_GH_TIMEOUT (default 30, maximum 300 seconds) bounds each API/list call.
EOF
}

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

repo=
ref=
environment=github-pages
while (($#)); do
  case "$1" in
    --repo|--ref|--environment)
      (($# >= 2)) || die "missing value for $1"
      case "$1" in
        --repo) repo=$2 ;;
        --ref) ref=$2 ;;
        --environment) environment=$2 ;;
      esac
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die 'expected --repo OWNER/REPO'
[[ -n $ref && $ref != -* ]] || die 'expected --ref BRANCH'
[[ -n $environment ]] || die 'environment must not be empty'
for command in gh jq python3 timeout; do
  command -v "$command" >/dev/null || die "required command not found: $command"
done

attempts=${VALHALLA_DISCOVERY_ATTEMPTS:-30}
interval=${VALHALLA_DISCOVERY_INTERVAL:-2}
gh_timeout=${VALHALLA_GH_TIMEOUT:-30}
if [[ ! $attempts =~ ^[1-9][0-9]{0,2}$ ]] || ((attempts > 120)); then
  die 'invalid discovery attempts (1-120)'
fi
if [[ ! $interval =~ ^(0|[1-9][0-9]?)$ ]] || ((interval > 60)); then
  die 'invalid discovery interval (0-60)'
fi
if [[ ! $gh_timeout =~ ^[1-9][0-9]{0,2}$ ]] || ((gh_timeout > 300)); then
  die 'invalid gh timeout (1-300)'
fi

encoded_ref=$(jq -rn --arg value "$ref" '$value | @uri')
if ! branch=$(timeout --kill-after=5s "${gh_timeout}s" gh api "repos/$repo/branches/$encoded_ref"); then
  die "cannot fetch remote branch '$ref' from $repo"
fi
sha=$(jq -er '.commit.sha | select(type == "string" and test("^[0-9a-fA-F]{40}$"))' <<<"$branch") ||
  die "invalid remote SHA for branch '$ref'"
request_id=$(python3 -c 'import uuid; print(uuid.uuid4())') || die 'cannot generate request ID'
title="valhalla-$request_id"
payload=$(jq -cn --arg ref "$ref" --arg sha "$sha" --arg request_id "$request_id" \
  --arg environment "$environment" \
  '{ref: $ref, inputs: {sha: $sha, request_id: $request_id, environment: $environment}}')

printf 'Dispatching %s at %s (request %s)\n' "$ref" "$sha" "$request_id"
if ! timeout --kill-after=5s "${gh_timeout}s" gh api --method POST \
  "repos/$repo/actions/workflows/deploy-valhalla.yml/dispatches" --input - <<<"$payload"; then
  die "workflow dispatch failed or timed out; check request $request_id before retrying"
fi

for ((i = 1; i <= attempts; i++)); do
  if ! runs=$(timeout --kill-after=5s "${gh_timeout}s" gh run list --repo "$repo" --workflow deploy-valhalla.yml --event workflow_dispatch \
    --branch "$ref" --commit "$sha" --limit 100 --json databaseId,displayTitle,event,headBranch,headSha); then
    die 'failed to list workflow runs'
  fi
  if ! matches=$(jq -er --arg title "$title" --arg ref "$ref" --arg sha "$sha" '
    if type != "array" then error("expected an array") else
      [.[] | select(.displayTitle == $title and .event == "workflow_dispatch"
        and .headBranch == $ref and .headSha == $sha) | .databaseId
        | select(type == "number" and . > 0 and floor == .)] end
  ' <<<"$runs"); then
    die 'invalid workflow run list'
  fi
  count=$(jq 'length' <<<"$matches")
  ((count <= 1)) || die "multiple runs matched request $request_id"
  if ((count == 1)); then
    run_id=$(jq -r '.[0]' <<<"$matches")
    printf 'Watching run %s\n' "$run_id"
    gh run watch "$run_id" --repo "$repo" --exit-status
    exit $?
  fi
  if ((i < attempts)); then sleep "$interval"; fi
done
die "run for request $request_id was not found after $attempts attempts"
