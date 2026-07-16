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
FORGEJO_SERVICE="${FORGEJO_SERVICE:-forgejo}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
FORGEJO_LOCAL_URL="${FORGEJO_LOCAL_URL:-}"
APPLY_BOOTSTRAP="${APPLY_BOOTSTRAP:-false}"
CHECK_DISCOVERY="${CHECK_DISCOVERY:-true}"
CHECK_STEWARD_TOKEN="${CHECK_STEWARD_TOKEN:-true}"
HTTP_TIMEOUT_SECONDS="${HTTP_TIMEOUT_SECONDS:-5}"
IDENTITY_BOOTSTRAP_STDOUT="${IDENTITY_BOOTSTRAP_STDOUT:-$(eliza_tmp_path eliza-hub-identity-bootstrap.out)}"
IDENTITY_BOOTSTRAP_STDERR="${IDENTITY_BOOTSTRAP_STDERR:-$(eliza_tmp_path eliza-hub-identity-bootstrap.err)}"
IDENTITY_BOOTSTRAP_COMPOSE_CONFIG="${IDENTITY_BOOTSTRAP_COMPOSE_CONFIG:-$(eliza_tmp_path eliza-hub-identity-compose.yml)}"
IDENTITY_BOOTSTRAP_CHECKS_TSV="${IDENTITY_BOOTSTRAP_CHECKS_TSV:-$(eliza_tmp_path eliza-hub-identity-bootstrap-checks.tsv)}"
IDENTITY_BOOTSTRAP_EVIDENCE_OUT="${IDENTITY_BOOTSTRAP_EVIDENCE_OUT:-$(eliza_artifact_path eliza-hub-identity-bootstrap-evidence.json)}"
FAILED=0
WARNED=0

log() {
  printf '[identity-bootstrap] %s\n' "$*"
}

warn() {
  WARNED=$((WARNED + 1))
  printf '[identity-bootstrap] warning: %s\n' "$*" >&2
}

fail_now() {
  printf '[identity-bootstrap] error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail_now "missing required command: $1"
}

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

load_env_file() {
  safe_load_env_file "$ENV_FILE" "${ALLOW_ENV_ONLY:-false}" "identity-bootstrap"
}

compose() {
  local args=()

  if [[ -f "$ENV_FILE" ]]; then
    args+=(--env-file "$ENV_FILE")
  fi

  docker compose "${args[@]}" -f "$COMPOSE_FILE" "$@"
}

forgejo_exec() {
  compose exec -T "$FORGEJO_SERVICE" forgejo "$@"
}

postgres_query() {
  compose exec -T "$POSTGRES_SERVICE" psql \
    -X \
    -q \
    -tA \
    -v ON_ERROR_STOP=1 \
    -U "${FORGEJO_DB_USER:-forgejo}" \
    -d "${FORGEJO_DB_NAME:-forgejo}" \
    "$@"
}

run_check() {
  local name="$1"
  local status
  shift

  printf '[identity-bootstrap] check: %s... ' "$name"
  if "$@" >"$IDENTITY_BOOTSTRAP_STDOUT" 2>"$IDENTITY_BOOTSTRAP_STDERR"; then
    printf 'ok\n'
    status="pass"
  else
    printf 'failed\n'
    sed 's/^/[identity-bootstrap]   /' "$IDENTITY_BOOTSTRAP_STDERR" >&2 || true
    FAILED=$((FAILED + 1))
    status="fail"
  fi
  printf '%s\t%s\n' "$name" "$status" >>"$IDENTITY_BOOTSTRAP_CHECKS_TSV"
}

write_identity_evidence() {
  node - "$IDENTITY_BOOTSTRAP_EVIDENCE_OUT" "$FAILED" "$WARNED" "$APPLY_BOOTSTRAP" "$CHECK_DISCOVERY" "$CHECK_STEWARD_TOKEN" "${FORGEJO_LOCAL_URL:-}" "${FORGEJO_OIDC_AUTH_NAME:-}" "${ELIZA_CLOUD_OIDC_ISSUER_URL:-}" "$IDENTITY_BOOTSTRAP_CHECKS_TSV" <<'NODE'
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const [
  output,
  failedRaw,
  warnedRaw,
  applyBootstrapRaw,
  checkDiscoveryRaw,
  checkStewardTokenRaw,
  forgejoLocalUrl,
  oidcAuthName,
  issuerUrl,
  checksPath,
] = process.argv.slice(2);

const checks = readFileSync(checksPath, "utf8")
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => {
    const [name, status] = line.split("\t");
    return { name, status };
  });
const failed = Number(failedRaw);
const evidence = {
  schema: "https://eliza.hub/schemas/identity-bootstrap-evidence.v1",
  finishedAt: new Date().toISOString(),
  status: failed === 0 ? "passed" : "failed",
  options: {
    applyBootstrap: /^(?:1|true|yes|on)$/iu.test(applyBootstrapRaw),
    checkDiscovery: /^(?:1|true|yes|on)$/iu.test(checkDiscoveryRaw),
    checkStewardToken: /^(?:1|true|yes|on)$/iu.test(checkStewardTokenRaw),
  },
  targets: {
    forgejoLocalUrl,
  },
  oidc: {
    authName: oidcAuthName,
    issuerUrl,
  },
  summary: {
    total: checks.length,
    passed: checks.filter((check) => check.status === "pass").length,
    failed,
    warnings: Number(warnedRaw),
  },
  checks,
};

mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
NODE
}

check_env_validation() {
  ENV_FILE="$ENV_FILE" VALIDATE_STEWARD="$CHECK_STEWARD_TOKEN" "$SCRIPT_DIR/validate-env.sh"
}

check_compose_config() {
  compose config >"$IDENTITY_BOOTSTRAP_COMPOSE_CONFIG"
}

check_forgejo_running() {
  local container_id
  local state
  local health

  container_id="$(compose ps -q "$FORGEJO_SERVICE")"
  [[ -n "$container_id" ]] || {
    printf 'service %s has no container\n' "$FORGEJO_SERVICE" >&2
    return 1
  }

  state="$(docker inspect --format '{{.State.Status}}' "$container_id")"
  [[ "$state" == "running" ]] || {
    printf 'service %s is %s\n' "$FORGEJO_SERVICE" "$state" >&2
    return 1
  }

  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id")"
  [[ -z "$health" || "$health" == "healthy" ]] || {
    printf 'service %s health is %s\n' "$FORGEJO_SERVICE" "$health" >&2
    return 1
  }
}

check_forgejo_cli() {
  forgejo_exec --version >/dev/null
}

check_discovery_document() {
  if ! is_true "$CHECK_DISCOVERY"; then
    warn "CHECK_DISCOVERY=false; skipping Eliza Cloud discovery check"
    return 0
  fi

  require_command curl

  local document
  document="$(curl -fsS --max-time "$HTTP_TIMEOUT_SECONDS" "$ELIZA_CLOUD_OIDC_DISCOVERY_URL")"
  printf '%s' "$document" | grep -F '"issuer"' | grep -F "$ELIZA_CLOUD_OIDC_ISSUER_URL" >/dev/null || {
    printf 'OIDC discovery issuer does not match ELIZA_CLOUD_OIDC_ISSUER_URL\n' >&2
    return 1
  }
  printf '%s' "$document" | grep -F '"jwks_uri"' >/dev/null || {
    printf 'OIDC discovery document does not advertise jwks_uri\n' >&2
    return 1
  }
}

recovery_admin_exists() {
  forgejo_exec admin user list --admin | grep -F "$FORGEJO_RECOVERY_ADMIN_USERNAME" >/dev/null
}

ensure_recovery_admin() {
  if recovery_admin_exists; then
    return 0
  fi

  if ! is_true "$APPLY_BOOTSTRAP"; then
    printf 'missing recovery admin %s; rerun with APPLY_BOOTSTRAP=true to create it\n' "$FORGEJO_RECOVERY_ADMIN_USERNAME" >&2
    return 1
  fi

  forgejo_exec admin user create \
    --username "$FORGEJO_RECOVERY_ADMIN_USERNAME" \
    --email "$FORGEJO_RECOVERY_ADMIN_EMAIL" \
    --password "$FORGEJO_RECOVERY_ADMIN_PASSWORD" \
    --admin \
    --must-change-password=false
}

oidc_source_exists() {
  forgejo_exec admin auth list | grep -F -- "$FORGEJO_OIDC_AUTH_NAME" >/dev/null
}

query_oidc_source_drift() {
  local expected_skip_local_2fa

  if is_true "${FORGEJO_OIDC_SKIP_LOCAL_2FA:-true}"; then
    expected_skip_local_2fa=true
  else
    expected_skip_local_2fa=false
  fi

  postgres_query \
    -v auth_name="$FORGEJO_OIDC_AUTH_NAME" \
    -v client_id="$ELIZA_CLOUD_FORGEJO_CLIENT_ID" \
    -v discovery_url="$ELIZA_CLOUD_OIDC_DISCOVERY_URL" \
    -v scopes="${FORGEJO_OIDC_SCOPES:-openid email profile groups}" \
    -v skip_local_2fa="$expected_skip_local_2fa" \
    -v required_claim_name="${FORGEJO_OIDC_REQUIRED_CLAIM_NAME:-}" \
    -v required_claim_value="${FORGEJO_OIDC_REQUIRED_CLAIM_VALUE:-}" \
    -v group_claim_name="${FORGEJO_OIDC_GROUP_CLAIM_NAME:-}" \
    -v admin_group="${FORGEJO_OIDC_ADMIN_GROUP:-}" \
    -v restricted_group="${FORGEJO_OIDC_RESTRICTED_GROUP:-}" <<'SQL'
WITH raw_sources AS (
  SELECT
    id,
    type,
    is_active,
    cfg::jsonb AS raw_cfg
  FROM login_source
  WHERE name = :'auth_name'
),
source_count AS (
  SELECT count(*) AS total FROM raw_sources
),
source AS (
  SELECT
    id,
    type,
    is_active,
    CASE
      WHEN jsonb_typeof(raw_cfg) = 'string' THEN (raw_cfg #>> '{}')::jsonb
      ELSE raw_cfg
    END AS cfg
  FROM raw_sources
  LIMIT 1
),
scope_text AS (
  SELECT jsonb_array_elements_text(
    CASE
      WHEN jsonb_typeof(cfg->'Scopes') = 'array' THEN cfg->'Scopes'
      ELSE '[]'::jsonb
    END
  ) AS value
  FROM source
  UNION ALL
  SELECT cfg->>'Scopes'
  FROM source
  WHERE jsonb_typeof(cfg->'Scopes') = 'string'
),
configured_scopes AS (
  SELECT lower(scope) AS scope
  FROM scope_text, regexp_split_to_table(value, '[[:space:],]+') AS split(scope)
  WHERE scope <> ''
),
expected_scopes AS (
  SELECT lower(scope) AS scope
  FROM regexp_split_to_table(:'scopes', '[[:space:],]+') AS split(scope)
  WHERE scope <> ''
),
checks AS (
  SELECT 'source_count' AS check_name, (SELECT total FROM source_count) = 1 AS ok
  UNION ALL
  SELECT 'source_type', EXISTS (SELECT 1 FROM source WHERE type = 6)
  UNION ALL
  SELECT 'source_enabled', EXISTS (SELECT 1 FROM source WHERE is_active)
  UNION ALL
  SELECT 'provider', EXISTS (SELECT 1 FROM source WHERE cfg->>'Provider' = 'openidConnect')
  UNION ALL
  SELECT 'client_id', EXISTS (SELECT 1 FROM source WHERE cfg->>'ClientID' = :'client_id')
  UNION ALL
  SELECT 'discovery_url', EXISTS (SELECT 1 FROM source WHERE cfg->>'OpenIDConnectAutoDiscoveryURL' = :'discovery_url')
  UNION ALL
  SELECT 'skip_local_2fa', EXISTS (
    SELECT 1
    FROM source
    WHERE COALESCE((cfg->>'SkipLocalTwoFA')::boolean, false) = (:'skip_local_2fa')::boolean
  )
  UNION ALL
  SELECT 'required_claim_name',
    :'required_claim_name' = '' OR EXISTS (SELECT 1 FROM source WHERE COALESCE(cfg->>'RequiredClaimName', '') = :'required_claim_name')
  UNION ALL
  SELECT 'required_claim_value',
    :'required_claim_value' = '' OR EXISTS (SELECT 1 FROM source WHERE COALESCE(cfg->>'RequiredClaimValue', '') = :'required_claim_value')
  UNION ALL
  SELECT 'group_claim_name',
    :'group_claim_name' = '' OR EXISTS (SELECT 1 FROM source WHERE COALESCE(cfg->>'GroupClaimName', '') = :'group_claim_name')
  UNION ALL
  SELECT 'admin_group',
    :'admin_group' = '' OR EXISTS (SELECT 1 FROM source WHERE COALESCE(cfg->>'AdminGroup', '') = :'admin_group')
  UNION ALL
  SELECT 'restricted_group',
    :'restricted_group' = '' OR EXISTS (SELECT 1 FROM source WHERE COALESCE(cfg->>'RestrictedGroup', '') = :'restricted_group')
  UNION ALL
  SELECT 'scopes',
    EXISTS (SELECT 1 FROM expected_scopes)
    AND NOT EXISTS (
      SELECT 1
      FROM expected_scopes expected
      WHERE NOT EXISTS (SELECT 1 FROM configured_scopes configured WHERE configured.scope = expected.scope)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM configured_scopes configured
      WHERE NOT EXISTS (SELECT 1 FROM expected_scopes expected WHERE expected.scope = configured.scope)
    )
)
SELECT check_name
FROM checks
WHERE NOT ok
ORDER BY check_name;
SQL
}

check_oidc_source_config() {
  local mismatches
  local summary

  if ! mismatches="$(query_oidc_source_drift)"; then
    printf 'failed to read OIDC auth source %s from Postgres login_source\n' "$FORGEJO_OIDC_AUTH_NAME" >&2
    return 1
  fi

  if [[ -n "$mismatches" ]]; then
    summary="${mismatches//$'\n'/, }"
    printf 'OIDC auth source %s does not match Eliza Cloud env: %s\n' "$FORGEJO_OIDC_AUTH_NAME" "$summary" >&2
    printf '%s\n' "$mismatches" | sed 's/^/[identity-bootstrap]   drift: /' >&2
    printf 'Existing auth sources are not modified automatically; update the source deliberately, then rerun this check.\n' >&2
    return 1
  fi
}

ensure_oidc_source() {
  if oidc_source_exists; then
    check_oidc_source_config
    return
  fi

  if ! is_true "$APPLY_BOOTSTRAP"; then
    printf 'missing OIDC auth source %s; rerun with APPLY_BOOTSTRAP=true to add it\n' "$FORGEJO_OIDC_AUTH_NAME" >&2
    return 1
  fi

  local args=(
    admin auth add-oauth
    --provider=openidConnect
    --name "$FORGEJO_OIDC_AUTH_NAME"
    --key "$ELIZA_CLOUD_FORGEJO_CLIENT_ID"
    --secret "$ELIZA_CLOUD_FORGEJO_CLIENT_SECRET"
    --auto-discover-url "$ELIZA_CLOUD_OIDC_DISCOVERY_URL"
    --scopes "${FORGEJO_OIDC_SCOPES:-openid email profile groups}"
  )

  if is_true "${FORGEJO_OIDC_SKIP_LOCAL_2FA:-true}"; then
    args+=(--skip-local-2fa)
  fi
  if [[ -n "${FORGEJO_OIDC_REQUIRED_CLAIM_NAME:-}" ]]; then
    args+=(--required-claim-name "$FORGEJO_OIDC_REQUIRED_CLAIM_NAME")
  fi
  if [[ -n "${FORGEJO_OIDC_REQUIRED_CLAIM_VALUE:-}" ]]; then
    args+=(--required-claim-value "$FORGEJO_OIDC_REQUIRED_CLAIM_VALUE")
  fi
  if [[ -n "${FORGEJO_OIDC_GROUP_CLAIM_NAME:-}" ]]; then
    args+=(--group-claim-name "$FORGEJO_OIDC_GROUP_CLAIM_NAME")
  fi
  if [[ -n "${FORGEJO_OIDC_ADMIN_GROUP:-}" ]]; then
    args+=(--admin-group "$FORGEJO_OIDC_ADMIN_GROUP")
  fi
  if [[ -n "${FORGEJO_OIDC_RESTRICTED_GROUP:-}" ]]; then
    args+=(--restricted-group "$FORGEJO_OIDC_RESTRICTED_GROUP")
  fi

  forgejo_exec "${args[@]}"
  check_oidc_source_config
}

check_steward_token_owner() {
  if ! is_true "$CHECK_STEWARD_TOKEN"; then
    warn "CHECK_STEWARD_TOKEN=false; skipping steward token owner check"
    return 0
  fi

  require_command curl

  local response compact
  response="$(curl -fsS --max-time "$HTTP_TIMEOUT_SECONDS" \
    -H "Authorization: token $FORGEJO_STEWARD_TOKEN" \
    "$FORGEJO_LOCAL_URL/api/v1/user")"
  compact="$(printf '%s' "$response" | tr -d '[:space:]')"
  if [[ "$compact" != *"\"login\":\"$FORGEJO_STEWARD_USERNAME\""* \
    && "$compact" != *"\"username\":\"$FORGEJO_STEWARD_USERNAME\""* ]]; then
    printf 'FORGEJO_STEWARD_TOKEN does not authenticate as %s\n' "$FORGEJO_STEWARD_USERNAME" >&2
    return 1
  fi
}

main() {
  require_command docker
  require_command grep
  require_command node
  eliza_prepare_artifact_dirs
  : >"$IDENTITY_BOOTSTRAP_CHECKS_TSV"
  load_env_file

  FORGEJO_LOCAL_URL="${FORGEJO_LOCAL_URL:-http://127.0.0.1:${FORGEJO_HTTP_PORT:-3000}}"

  log "using compose file: $COMPOSE_FILE"
  log "using env file: $ENV_FILE"
  log "using tmp root: $ELIZA_TMP_ROOT"
  log "using evidence output: $IDENTITY_BOOTSTRAP_EVIDENCE_OUT"
  log "using Postgres service: $POSTGRES_SERVICE"
  log "checking Forgejo at: $FORGEJO_LOCAL_URL"
  log "APPLY_BOOTSTRAP=$APPLY_BOOTSTRAP"

  run_check "private env validates identity inputs" check_env_validation
  run_check "compose config renders" check_compose_config
  run_check "forgejo container is running and healthy" check_forgejo_running
  run_check "forgejo CLI responds" check_forgejo_cli
  run_check "Eliza Cloud discovery document is valid" check_discovery_document
  run_check "local recovery admin exists" ensure_recovery_admin
  run_check "Eliza Cloud OIDC auth source config matches env" ensure_oidc_source
  run_check "steward token authenticates as steward user" check_steward_token_owner

  rm -f "$IDENTITY_BOOTSTRAP_STDOUT" "$IDENTITY_BOOTSTRAP_STDERR"
  write_identity_evidence
  log "wrote identity bootstrap evidence: $IDENTITY_BOOTSTRAP_EVIDENCE_OUT"

  if ((FAILED > 0)); then
    fail_now "$FAILED identity bootstrap check(s) failed"
  fi

  if ((WARNED > 0)); then
    log "identity bootstrap passed with $WARNED warning(s)"
  else
    log "identity bootstrap passed"
  fi
}

main "$@"
