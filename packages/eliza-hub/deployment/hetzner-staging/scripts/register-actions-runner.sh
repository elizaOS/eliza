#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=env-loader.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/env-loader.sh"

ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$DEPLOY_DIR/compose.yml}"
RUNNER_COMPOSE_FILE="${RUNNER_COMPOSE_FILE:-$DEPLOY_DIR/compose.actions-runner.yml}"
RUNNER_DATA_DIR="${RUNNER_DATA_DIR:-$DEPLOY_DIR/runner/data}"
RUNNER_CONFIG_TEMPLATE="${RUNNER_CONFIG_TEMPLATE:-$DEPLOY_DIR/runner/config.example.yml}"
RUNNER_CONFIG_FILE="${RUNNER_CONFIG_FILE:-$RUNNER_DATA_DIR/config.yml}"

log() {
  printf '[runner-register] %s\n' "$*"
}

fail() {
  printf '[runner-register] error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

load_env_file() {
  safe_load_env_file "$ENV_FILE" "${ALLOW_ENV_ONLY:-false}" "runner-register"
}

compose() {
  local args=()

  if [[ -f "$ENV_FILE" ]]; then
    args+=(--env-file "$ENV_FILE")
  fi

  docker compose \
    "${args[@]}" \
    -f "$COMPOSE_FILE" \
    -f "$RUNNER_COMPOSE_FILE" \
    --profile actions-runner \
    "$@"
}

main() {
  require_command docker
  load_env_file
  ENV_FILE="$ENV_FILE" VALIDATE_STEWARD=false VALIDATE_RUNNER=true VALIDATE_RUNNER_REGISTRATION=true "$SCRIPT_DIR/validate-env.sh"

  local instance="${FORGEJO_RUNNER_INSTANCE:-${FORGEJO_ROOT_URL:-}}"
  local token="${FORGEJO_RUNNER_REGISTRATION_TOKEN:-}"
  local name="${FORGEJO_RUNNER_NAME:-eliza-staging-docker-1}"
  local labels="${FORGEJO_RUNNER_LABELS:-docker:docker://node:24-bookworm,node-24:docker://node:24-bookworm,ubuntu-latest:docker://node:24-bookworm}"

  [[ -n "$instance" ]] || fail "set FORGEJO_RUNNER_INSTANCE or FORGEJO_ROOT_URL"
  [[ -n "$token" ]] || fail "set FORGEJO_RUNNER_REGISTRATION_TOKEN in the private env"
  [[ -f "$RUNNER_CONFIG_TEMPLATE" ]] || fail "missing runner config template: $RUNNER_CONFIG_TEMPLATE"

  mkdir -p "$RUNNER_DATA_DIR"
  if [[ ! -f "$RUNNER_CONFIG_FILE" ]]; then
    cp "$RUNNER_CONFIG_TEMPLATE" "$RUNNER_CONFIG_FILE"
    log "created $RUNNER_CONFIG_FILE from the template"
  fi

  log "registering runner '$name' against $instance"
  compose run --rm --no-deps actions-runner \
    forgejo-runner register \
      --no-interactive \
      --instance "$instance" \
      --token "$token" \
      --name "$name" \
      --labels "$labels" \
      --config /data/config.yml

  log "runner registered; start with the actions-runner compose profile"
}

main "$@"
