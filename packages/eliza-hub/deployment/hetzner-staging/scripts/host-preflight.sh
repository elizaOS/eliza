#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=artifact-paths.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/artifact-paths.sh"

ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env}"
REQUIRE_REVERSE_PROXY="${REQUIRE_REVERSE_PROXY:-true}"
CHECK_DNS="${CHECK_DNS:-false}"
CHECK_DOCKER_DAEMON="${CHECK_DOCKER_DAEMON:-true}"
HOST_PREFLIGHT_STDOUT="${HOST_PREFLIGHT_STDOUT:-$(eliza_tmp_path eliza-hub-host-preflight.out)}"
HOST_PREFLIGHT_STDERR="${HOST_PREFLIGHT_STDERR:-$(eliza_tmp_path eliza-hub-host-preflight.err)}"

FAILED=0
WARNED=0

log() {
  printf '[host-preflight] %s\n' "$*"
}

warn() {
  WARNED=$((WARNED + 1))
  printf '[host-preflight] warning: %s\n' "$*" >&2
}

fail() {
  FAILED=$((FAILED + 1))
  printf '[host-preflight] error: %s\n' "$*" >&2
}

usage() {
  cat <<'EOF'
usage: host-preflight.sh

Read-only host checks before a staging deploy.

Environment:
  ENV_FILE                         Private env file to validate.
  REQUIRE_REVERSE_PROXY=true|false Require caddy or nginx on PATH.
  CHECK_DNS=true|false             Resolve FORGEJO_DOMAIN from ENV_FILE.
  CHECK_DOCKER_DAEMON=true|false   Require docker daemon connectivity.

The script reports command and variable names only. It does not print secrets
and never starts, stops, pulls, removes, or mutates services.
EOF
}

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '%s is required on the host\n' "$command_name" >&2
    return 1
  fi
  return 0
}

run_check() {
  local name="$1"
  shift

  printf '[host-preflight] check: %s... ' "$name"
  if "$@" >"$HOST_PREFLIGHT_STDOUT" 2>"$HOST_PREFLIGHT_STDERR"; then
    printf 'ok\n'
    if [[ -s "$HOST_PREFLIGHT_STDERR" ]]; then
      sed 's/^/[host-preflight]   /' "$HOST_PREFLIGHT_STDERR" >&2 || true
    fi
    return 0
  fi

  printf 'failed\n'
  sed 's/^/[host-preflight]   /' "$HOST_PREFLIGHT_STDERR" >&2 || true
  FAILED=$((FAILED + 1))
  return 1
}

env_value() {
  local key="$1"
  local line value

  [[ -f "$ENV_FILE" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue

    if [[ "$line" =~ ^[[:space:]]*${key}=(.*)$ ]]; then
      value="${BASH_REMATCH[1]}"
      if [[ "$value" == \"*\" && "$value" == *\" && ${#value} -ge 2 ]]; then
        value="${value:1:${#value}-2}"
      elif [[ "$value" == \'*\' && ${#value} -ge 2 ]]; then
        value="${value:1:${#value}-2}"
      fi
      printf '%s' "$value"
      return 0
    fi
  done < "$ENV_FILE"
}

check_commands() {
  local missing=0
  require_command bash || missing=1
  require_command node || missing=1
  require_command npm || missing=1
  require_command curl || missing=1
  require_command age || missing=1
  require_command rclone || missing=1
  require_command jq || missing=1
  require_command flock || missing=1

  if require_command docker; then
    docker compose version >/dev/null
  else
    missing=1
  fi

  return "$missing"
}

check_docker_daemon() {
  if is_true "$CHECK_DOCKER_DAEMON"; then
    docker info >/dev/null
  fi
}

check_reverse_proxy() {
  if command -v caddy >/dev/null 2>&1; then
    return 0
  fi

  if command -v nginx >/dev/null 2>&1; then
    return 0
  fi

  if is_true "$REQUIRE_REVERSE_PROXY"; then
    printf 'caddy or nginx is required for host TLS termination\n' >&2
    return 1
  fi

  warn "caddy/nginx not found; REQUIRE_REVERSE_PROXY=false"
  return 0
}

check_dns() {
  local domain
  domain="$(env_value FORGEJO_DOMAIN)"

  if [[ -z "$domain" ]]; then
    printf 'FORGEJO_DOMAIN is missing from ENV_FILE\n' >&2
    return 1
  fi

  if command -v getent >/dev/null 2>&1; then
    getent ahosts "$domain" >/dev/null
    return
  fi

  if command -v dig >/dev/null 2>&1; then
    dig +short "$domain" >/dev/null
    return
  fi

  printf 'getent or dig is required when CHECK_DNS=true\n' >&2
  return 1
}

check_loopback_port_report() {
  local label="$1"
  local port="$2"

  [[ -z "$port" ]] && return 0
  if ! [[ "$port" =~ ^[0-9]+$ ]]; then
    warn "$label is not numeric"
    return 0
  fi

  if command -v ss >/dev/null 2>&1 && ss -ltn "( sport = :$port )" | tail -n +2 | grep -q .; then
    log "$label=$port is already listening; this is expected on an existing host"
  else
    log "$label=$port is not currently listening"
  fi
}

main() {
  if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    usage
    return 0
  fi

  eliza_prepare_artifact_dirs
  log "using env file: $ENV_FILE"
  log "using tmp root: $ELIZA_TMP_ROOT"
  run_check "private env validates" "$SCRIPT_DIR/validate-env.sh" || true
  run_check "required host commands exist" check_commands || true
  run_check "docker daemon is reachable when required" check_docker_daemon || true
  run_check "TLS reverse proxy command exists" check_reverse_proxy || true

  if is_true "$CHECK_DNS"; then
    run_check "FORGEJO_DOMAIN resolves" check_dns || true
  else
    log "CHECK_DNS=false; skipping DNS resolution"
  fi

  check_loopback_port_report FORGEJO_HTTP_PORT "$(env_value FORGEJO_HTTP_PORT)"
  check_loopback_port_report FORGEJO_SSH_PORT "$(env_value FORGEJO_SSH_PORT)"
  check_loopback_port_report MERGE_STEWARD_HTTP_PORT "$(env_value MERGE_STEWARD_HTTP_PORT)"

  rm -f "$HOST_PREFLIGHT_STDOUT" "$HOST_PREFLIGHT_STDERR"

  if ((FAILED > 0)); then
    fail "$FAILED host preflight checks failed"
    exit 1
  fi

  if ((WARNED > 0)); then
    log "host preflight passed with $WARNED warning(s)"
  else
    log "host preflight passed"
  fi
}

main "$@"
