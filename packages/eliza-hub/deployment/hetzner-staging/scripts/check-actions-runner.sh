#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=artifact-paths.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/artifact-paths.sh"
# shellcheck source=env-loader.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/env-loader.sh"

ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$DEPLOY_DIR/compose.yml}"
RUNNER_COMPOSE_FILE="${RUNNER_COMPOSE_FILE:-$DEPLOY_DIR/compose.actions-runner.yml}"
RUNNER_CONFIG_FILE="${RUNNER_CONFIG_FILE:-$DEPLOY_DIR/runner/data/config.yml}"
RUNNER_CHECK_STDOUT="${RUNNER_CHECK_STDOUT:-$(eliza_tmp_path eliza-hub-runner-check.out)}"
RUNNER_CHECK_STDERR="${RUNNER_CHECK_STDERR:-$(eliza_tmp_path eliza-hub-runner-check.err)}"
RUNNER_CHECK_COMPOSE_CONFIG="${RUNNER_CHECK_COMPOSE_CONFIG:-$(eliza_tmp_path eliza-hub-runner-compose.yml)}"
FAILED=0

log() {
  printf '[runner-check] %s\n' "$*"
}

fail_now() {
  printf '[runner-check] error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail_now "missing required command: $1"
}

load_env_file() {
  safe_load_env_file "$ENV_FILE" "${ALLOW_ENV_ONLY:-false}" "runner-check"
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

run_check() {
  local name="$1"
  shift

  printf '[runner-check] check: %s... ' "$name"
  if "$@" >"$RUNNER_CHECK_STDOUT" 2>"$RUNNER_CHECK_STDERR"; then
    printf 'ok\n'
  else
    printf 'failed\n'
    sed 's/^/[runner-check]   /' "$RUNNER_CHECK_STDERR" >&2 || true
    FAILED=$((FAILED + 1))
  fi
}

check_compose_config() {
  compose config >"$RUNNER_CHECK_COMPOSE_CONFIG"
}

check_env_validation() {
  ENV_FILE="$ENV_FILE" VALIDATE_STEWARD=false VALIDATE_RUNNER=true "$SCRIPT_DIR/validate-env.sh"
}

check_no_host_socket() {
  if grep -q '/var/run/docker.sock' "$RUNNER_CHECK_COMPOSE_CONFIG" "$RUNNER_CONFIG_FILE" 2>/dev/null; then
    printf 'runner config must not mount or reference the host Docker socket\n' >&2
    return 1
  fi
}

check_no_host_labels() {
  if grep -Eq '(^|[[:space:],])-?[A-Za-z0-9_-]+:host($|[[:space:],])' "$RUNNER_CONFIG_FILE"; then
    printf 'staging runner labels must not use :host executors\n' >&2
    return 1
  fi
}

check_service_running() {
  local service="$1"
  local container_id
  local state
  local health

  container_id="$(compose ps -q "$service")"
  [[ -n "$container_id" ]] || {
    printf 'service %s has no container\n' "$service" >&2
    return 1
  }

  state="$(docker inspect --format '{{.State.Status}}' "$container_id")"
  [[ "$state" == "running" ]] || {
    printf 'service %s is %s\n' "$service" "$state" >&2
    return 1
  }

  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id")"
  [[ -z "$health" || "$health" == "healthy" ]] || {
    printf 'service %s health is %s\n' "$service" "$health" >&2
    return 1
  }
}

check_runner_registration() {
  [[ -f "$DEPLOY_DIR/runner/data/.runner" ]] || {
    printf 'runner is not registered; run scripts/register-actions-runner.sh first\n' >&2
    return 1
  }
  [[ -f "$RUNNER_CONFIG_FILE" ]] || {
    printf 'runner config is missing: %s\n' "$RUNNER_CONFIG_FILE" >&2
    return 1
  }
}

check_dind_daemon() {
  compose exec -T actions-dind docker info >/dev/null
}

main() {
  require_command docker
  require_command grep
  eliza_prepare_artifact_dirs
  load_env_file

  log "using compose files: $COMPOSE_FILE and $RUNNER_COMPOSE_FILE"
  log "using env file: $ENV_FILE"
  log "using tmp root: $ELIZA_TMP_ROOT"

  run_check "private env validates runner settings" check_env_validation
  run_check "compose config renders" check_compose_config
  run_check "host Docker socket is not exposed" check_no_host_socket
  run_check "runner labels avoid host executors" check_no_host_labels
  run_check "runner registration files exist" check_runner_registration
  run_check "actions-dind container is running and healthy" check_service_running actions-dind
  run_check "actions-runner container is running and healthy" check_service_running actions-runner
  run_check "actions-dind Docker daemon responds" check_dind_daemon

  rm -f "$RUNNER_CHECK_STDOUT" "$RUNNER_CHECK_STDERR"

  if ((FAILED > 0)); then
    fail_now "$FAILED runner checks failed"
  fi

  log "runner checks passed"
}

main "$@"
