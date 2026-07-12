#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env}"
VALIDATE_STEWARD="${VALIDATE_STEWARD:-true}"
VALIDATE_RUNNER="${VALIDATE_RUNNER:-false}"
VALIDATE_RUNNER_REGISTRATION="${VALIDATE_RUNNER_REGISTRATION:-false}"
ALLOW_PUBLIC_BINDS="${ALLOW_PUBLIC_BINDS:-false}"

declare -A ENV_VALUES=()
ERRORS=()
WARNINGS=()

log() {
  printf '[env-check] %s\n' "$*"
}

error() {
  ERRORS+=("$1")
}

warn() {
  WARNINGS+=("$1")
}

usage() {
  cat <<'EOF'
usage: validate-env.sh

Environment:
  ENV_FILE                         Private env file to validate.
  VALIDATE_STEWARD=true|false      Validate Merge Steward production settings.
  VALIDATE_RUNNER=true|false       Validate isolated Actions runner settings.
  VALIDATE_RUNNER_REGISTRATION=true|false
                                   Require the runner registration token.
  ALLOW_PUBLIC_BINDS=true|false    Allow non-loopback compose port binds.

The validator reports variable names only. It never prints secret values.
EOF
}

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

load_env_file() {
  [[ -f "$ENV_FILE" ]] || {
    printf '[env-check] error: missing ENV_FILE=%s\n' "$ENV_FILE" >&2
    exit 1
  }

  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue

    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      if [[ "$value" == \"*\" && "$value" == *\" && ${#value} -ge 2 ]]; then
        value="${value:1:${#value}-2}"
      elif [[ "$value" == \'*\' && ${#value} -ge 2 ]]; then
        value="${value:1:${#value}-2}"
      fi
      ENV_VALUES["$key"]="$value"
    else
      warn "ignored malformed env line"
    fi
  done < "$ENV_FILE"
}

value_for() {
  local key="$1"
  printf '%s' "${ENV_VALUES[$key]:-${!key-}}"
}

has_bad_placeholder() {
  local value="$1"
  [[ -z "$value" ]] && return 0
  [[ "$value" == *example.invalid* ]] && return 0
  [[ "$value" == *replace-me* ]] && return 0
  [[ "$value" == "dummy" ]] && return 0
  [[ "$value" == "changeme" ]] && return 0
  [[ "$value" == "change-me" ]] && return 0
  [[ "$value" == "secret" ]] && return 0
  return 1
}

require_present() {
  local key="$1"
  local value
  value="$(value_for "$key")"
  if has_bad_placeholder "$value"; then
    error "$key is missing or still uses a placeholder"
  fi
}

require_username() {
  local key="$1"
  local value
  value="$(value_for "$key")"
  if has_bad_placeholder "$value"; then
    error "$key is missing or still uses a placeholder"
    return
  fi
  if ! [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{1,38}$ ]]; then
    error "$key must be a stable Forgejo-safe username"
  fi
}

require_email() {
  local key="$1"
  local value
  value="$(value_for "$key")"
  if has_bad_placeholder "$value"; then
    error "$key is missing or still uses a placeholder"
    return
  fi
  if [[ "$value" == *[[:space:]]* || "$value" != *@*.* ]]; then
    error "$key must be an email address"
  fi
}

require_secret() {
  local key="$1"
  local min_length="${2:-24}"
  local value
  value="$(value_for "$key")"
  if has_bad_placeholder "$value"; then
    error "$key is missing or still uses a placeholder"
    return
  fi
  if ((${#value} < min_length)); then
    error "$key is shorter than the required minimum length"
  fi
}

require_true_var() {
  local key="$1"
  if ! is_true "$(value_for "$key")"; then
    error "$key must be true"
  fi
}

require_false_var() {
  local key="$1"
  if is_true "$(value_for "$key")"; then
    error "$key must be false"
  fi
}

check_enum() {
  local key="$1"
  shift
  local value
  value="$(value_for "$key")"
  if has_bad_placeholder "$value"; then
    error "$key is missing or still uses a placeholder"
    return
  fi

  local allowed
  for allowed in "$@"; do
    if [[ "$value" == "$allowed" ]]; then
      return 0
    fi
  done

  error "$key must be one of: $*"
}

require_pinned_image() {
  local key="$1"
  local value
  value="$(value_for "$key")"
  if has_bad_placeholder "$value"; then
    error "$key is missing or still uses a placeholder image"
    return
  fi
  if [[ "$value" == *":latest" ]]; then
    error "$key must not use the mutable :latest tag"
  fi
  if [[ "$value" != *:* ]]; then
    error "$key must include an explicit image tag"
  fi
}

require_https_url() {
  local key="$1"
  local value
  value="$(value_for "$key")"
  if has_bad_placeholder "$value"; then
    error "$key is missing or still uses a placeholder URL"
    return
  fi
  if [[ "$value" != https://* ]]; then
    error "$key must use https://"
  fi
}

require_root_url() {
  local key="$1"
  local value
  value="$(value_for "$key")"
  require_https_url "$key"
  if [[ -n "$value" && "$value" != */ ]]; then
    error "$key must end with a slash"
  fi
}

require_postgres_url() {
  local key="$1"
  local value
  value="$(value_for "$key")"
  if has_bad_placeholder "$value"; then
    error "$key is missing or still uses a placeholder"
    return
  fi
  if [[ "$value" != postgres://* && "$value" != postgresql://* ]]; then
    error "$key must use postgres:// or postgresql://"
  fi
}

check_loopback_bind() {
  local key="$1"
  local value
  value="$(value_for "$key")"
  [[ -z "$value" ]] && return 0
  case "$value" in
    127.0.0.1|localhost|::1) return 0 ;;
  esac
  if ! is_true "$ALLOW_PUBLIC_BINDS"; then
    error "$key must bind to loopback unless ALLOW_PUBLIC_BINDS=true"
  else
    warn "$key allows a public bind because ALLOW_PUBLIC_BINDS=true"
  fi
}

check_positive_int_range() {
  local key="$1"
  local min="$2"
  local max="$3"
  local value
  value="$(value_for "$key")"
  [[ -z "$value" ]] && return 0
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    error "$key must be an integer"
    return
  fi
  if ((value < min || value > max)); then
    error "$key must be between $min and $max"
  fi
}

check_domain_matches_root_url() {
  local domain root host
  domain="$(value_for FORGEJO_DOMAIN)"
  root="$(value_for FORGEJO_ROOT_URL)"
  [[ -z "$domain" || -z "$root" || "$root" != https://* ]] && return 0
  host="${root#https://}"
  host="${host%%/*}"
  host="${host%%:*}"
  if [[ "$host" != "$domain" ]]; then
    error "FORGEJO_ROOT_URL host must match FORGEJO_DOMAIN"
  fi
}

check_mail() {
  if ! is_true "$(value_for FORGEJO_MAIL_ENABLED)"; then
    require_false_var FORGEJO_REGISTER_EMAIL_CONFIRM
    require_false_var FORGEJO_OAUTH2_REGISTER_EMAIL_CONFIRM
    return 0
  fi

  require_present FORGEJO_SMTP_ADDR
  check_positive_int_range FORGEJO_SMTP_PORT 1 65535
  require_email FORGEJO_MAIL_FROM
  require_present FORGEJO_SMTP_USER
  require_secret FORGEJO_SMTP_PASSWORD 12
}

check_common_forgejo() {
  require_pinned_image POSTGRES_IMAGE
  require_pinned_image FORGEJO_IMAGE

  require_present FORGEJO_DOMAIN
  require_root_url FORGEJO_ROOT_URL
  require_present FORGEJO_SSH_DOMAIN
  check_domain_matches_root_url

  check_loopback_bind FORGEJO_HTTP_BIND
  check_loopback_bind FORGEJO_SSH_BIND

  require_username FORGEJO_RECOVERY_ADMIN_USERNAME
  require_email FORGEJO_RECOVERY_ADMIN_EMAIL
  require_secret FORGEJO_RECOVERY_ADMIN_PASSWORD 24

  require_secret FORGEJO_DB_PASSWORD 24
  require_secret FORGEJO_SECRET_KEY 32
  require_secret FORGEJO_INTERNAL_TOKEN 32
  require_secret FORGEJO_OAUTH2_JWT_SECRET 32

  if is_true "$(value_for FORGEJO_ACTIONS_ENABLED)"; then
    require_https_url FORGEJO_ACTIONS_URL
  fi
  check_positive_int_range FORGEJO_ACTION_LOG_RETENTION_DAYS 1 90
  check_positive_int_range FORGEJO_ACTION_ARTIFACT_RETENTION_DAYS 1 90
  check_mail
  require_present FORGEJO_THEMES
  require_present FORGEJO_DEFAULT_THEME

  require_https_url ELIZA_CLOUD_OIDC_ISSUER_URL
  require_https_url ELIZA_CLOUD_OIDC_DISCOVERY_URL
  require_present FORGEJO_OIDC_AUTH_NAME
  require_present FORGEJO_OIDC_SCOPES
  require_true_var FORGEJO_OAUTH2_ENABLE_AUTO_REGISTRATION
  check_enum FORGEJO_OAUTH2_USERNAME userid nickname email
  check_enum FORGEJO_OAUTH2_ACCOUNT_LINKING disabled login auto
  if [[ "$(value_for FORGEJO_OAUTH2_ACCOUNT_LINKING)" == "auto" ]]; then
    error "FORGEJO_OAUTH2_ACCOUNT_LINKING must not be auto for production SSO"
  fi
  require_present FORGEJO_OIDC_REQUIRED_CLAIM_NAME
  require_present FORGEJO_OIDC_REQUIRED_CLAIM_VALUE
  require_present FORGEJO_OIDC_GROUP_CLAIM_NAME
  require_present FORGEJO_OIDC_ADMIN_GROUP
  require_present FORGEJO_OIDC_RESTRICTED_GROUP
  require_present ELIZA_CLOUD_FORGEJO_CLIENT_ID
  require_secret ELIZA_CLOUD_FORGEJO_CLIENT_SECRET 24
}

check_steward() {
  require_pinned_image MERGE_STEWARD_IMAGE
  require_postgres_url MERGE_STEWARD_DATABASE_URL
  require_username FORGEJO_STEWARD_USERNAME
  if [[ -n "$(value_for FORGEJO_STEWARD_EMAIL)" ]]; then
    require_email FORGEJO_STEWARD_EMAIL
  fi
  require_secret FORGEJO_STEWARD_TOKEN 24
  require_secret FORGEJO_WEBHOOK_SECRET 32

  if [[ "$(value_for MERGE_STEWARD_DEPLOYMENT_MODE)" != "production" ]]; then
    error "MERGE_STEWARD_DEPLOYMENT_MODE must be production"
  fi
  require_true_var MERGE_STEWARD_API_AUTH_REQUIRED
  require_secret MERGE_STEWARD_API_TOKEN 24
  require_true_var MERGE_STEWARD_OIDC_ENABLED
  require_https_url ELIZA_CLOUD_OIDC_ISSUER_URL
  require_https_url ELIZA_CLOUD_OIDC_DISCOVERY_URL
  require_present ELIZA_CLOUD_STEWARD_AUDIENCE
  require_present MERGE_STEWARD_OIDC_REQUIRED_ROLES
  require_present MERGE_STEWARD_OIDC_REQUIRED_GROUPS
  require_present MERGE_STEWARD_OIDC_ADMIN_ROLES
  require_present MERGE_STEWARD_OIDC_ADMIN_GROUPS

  if is_true "$(value_for MERGE_STEWARD_METRICS_ENABLED)"; then
    require_true_var MERGE_STEWARD_METRICS_AUTH_REQUIRED
  fi
  require_true_var MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID
  require_true_var MERGE_STEWARD_EVENT_GATE_ENABLED
  require_present MERGE_STEWARD_EVENT_GATE_REPOSITORIES

  if is_true "$(value_for FORGEJO_FEEDBACK_ENABLED)" && ! is_true "$(value_for FORGEJO_FEEDBACK_DRY_RUN)"; then
    require_secret FORGEJO_STEWARD_TOKEN 24
  fi

  if is_true "$(value_for MERGE_STEWARD_INTEGRATION_ENABLED)" && ! is_true "$(value_for MERGE_STEWARD_INTEGRATION_DRY_RUN)"; then
    require_true_var FORGEJO_ENRICHMENT_ENABLED
    require_true_var MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT
    require_true_var MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS
    require_true_var MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS
    require_true_var MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE
    require_true_var MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY
    require_present MERGE_STEWARD_AGENT_BRANCH_NAMESPACE_PREFIX
    if has_bad_placeholder "$(value_for MERGE_STEWARD_AGENT_IDENTITY_REGISTRY)" &&
      has_bad_placeholder "$(value_for DATABASE_URL)" &&
      has_bad_placeholder "$(value_for MERGE_STEWARD_DATABASE_URL)"; then
      error "live integration requires MERGE_STEWARD_AGENT_IDENTITY_REGISTRY or Postgres-backed steward agent identity registry"
    fi
    require_present MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET_ENV
    require_secret "$(value_for MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET_ENV)" 32
    if [[ "$(value_for MERGE_STEWARD_INTEGRATION_EXECUTOR)" == "none" ]]; then
      error "live integration requires MERGE_STEWARD_INTEGRATION_EXECUTOR to be non-none"
    fi
    require_present MERGE_STEWARD_INTEGRATION_REMOTE_URL
    if ! is_true "$(value_for MERGE_STEWARD_INTEGRATION_ALLOW_EMPTY_CHECKS)"; then
      require_present FORGEJO_REQUIRED_CHECKS
    fi
  fi

  if is_true "$(value_for MERGE_STEWARD_WORKER_ENABLED)"; then
    require_true_var MERGE_STEWARD_WORKER_CONFIRM_LIVE_EXECUTION
    require_true_var MERGE_STEWARD_WORKER_LEASE_ENABLED
    require_true_var MERGE_STEWARD_INTEGRATION_ENABLED
    if is_true "$(value_for MERGE_STEWARD_INTEGRATION_DRY_RUN)"; then
      error "enabled workers require MERGE_STEWARD_INTEGRATION_DRY_RUN=false"
    fi
    if ! is_true "$(value_for MERGE_STEWARD_INTEGRATION_ALLOW_EMPTY_CHECKS)"; then
      require_present FORGEJO_REQUIRED_CHECKS
    fi
  fi
}

check_runner() {
  require_pinned_image FORGEJO_RUNNER_IMAGE
  require_pinned_image FORGEJO_RUNNER_DIND_IMAGE
  require_https_url FORGEJO_RUNNER_INSTANCE

  local labels
  labels="$(value_for FORGEJO_RUNNER_LABELS)"
  require_present FORGEJO_RUNNER_LABELS
  if [[ "$labels" == *":host"* ]]; then
    error "FORGEJO_RUNNER_LABELS must not contain :host executors"
  fi
  if [[ "$labels" != *"docker://"* ]]; then
    error "FORGEJO_RUNNER_LABELS must include docker:// executor labels"
  fi
  if [[ "$labels" == *"/var/run/docker.sock"* ]]; then
    error "FORGEJO_RUNNER_LABELS must not reference the host Docker socket"
  fi

  if is_true "$VALIDATE_RUNNER_REGISTRATION"; then
    require_secret FORGEJO_RUNNER_REGISTRATION_TOKEN 16
  fi
}

main() {
  if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    usage
    exit 0
  fi

  load_env_file
  log "validating $ENV_FILE"
  check_common_forgejo

  if is_true "$VALIDATE_STEWARD"; then
    check_steward
  fi

  if is_true "$VALIDATE_RUNNER" || is_true "$VALIDATE_RUNNER_REGISTRATION"; then
    check_runner
  fi

  for warning in "${WARNINGS[@]}"; do
    printf '[env-check] warning: %s\n' "$warning" >&2
  done

  if ((${#ERRORS[@]})); then
    for item in "${ERRORS[@]}"; do
      printf '[env-check] error: %s\n' "$item" >&2
    done
    printf '[env-check] failed with %d error(s)\n' "${#ERRORS[@]}" >&2
    exit 1
  fi

  log "env validation passed"
}

main "$@"
