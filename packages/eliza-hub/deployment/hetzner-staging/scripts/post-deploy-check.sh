#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/../.." && pwd)"

# shellcheck source=artifact-paths.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/artifact-paths.sh"
# shellcheck source=env-loader.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/env-loader.sh"

ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$DEPLOY_DIR/compose.yml}"
POST_DEPLOY_COMPOSE_PROFILES="${POST_DEPLOY_COMPOSE_PROFILES:-steward}"
HTTP_TIMEOUT_SECONDS="${HTTP_TIMEOUT_SECONDS:-5}"
POST_DEPLOY_STDOUT="${POST_DEPLOY_STDOUT:-$(eliza_tmp_path eliza-hub-post-deploy.out)}"
POST_DEPLOY_STDERR="${POST_DEPLOY_STDERR:-$(eliza_tmp_path eliza-hub-post-deploy.err)}"
POST_DEPLOY_COMPOSE_CONFIG="${POST_DEPLOY_COMPOSE_CONFIG:-$(eliza_tmp_path eliza-hub-post-deploy-compose.yml)}"
POST_DEPLOY_CHECK_LOG="${POST_DEPLOY_CHECK_LOG:-$(eliza_tmp_path eliza-hub-post-deploy-checks.tsv)}"
POST_DEPLOY_EVIDENCE_OUTPUT="${POST_DEPLOY_EVIDENCE_OUTPUT:-$(eliza_artifact_path eliza-hub-post-deploy-evidence.json)}"
POST_DEPLOY_STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
FAILED=0
WARNED=0

log() {
  printf '[post-deploy] %s\n' "$*"
}

fail_now() {
  printf '[post-deploy] error: %s\n' "$*" >&2
  exit 1
}

warn() {
  WARNED=$((WARNED + 1))
  printf '[post-deploy] warning: %s\n' "$*" >&2
}

record_check() {
  local name="$1"
  local status="$2"

  printf '%s\t%s\n' "$name" "$status" >>"$POST_DEPLOY_CHECK_LOG"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail_now "missing required command: $1"
}

load_env_file() {
  safe_load_env_file "$ENV_FILE" "${ALLOW_ENV_ONLY:-false}" "post-deploy"
}

compose_args() {
  local args=()

  if [[ -n "$POST_DEPLOY_COMPOSE_PROFILES" ]]; then
    IFS=',' read -r -a profiles <<< "$POST_DEPLOY_COMPOSE_PROFILES"
    for profile in "${profiles[@]}"; do
      [[ -n "$profile" ]] && args+=(--profile "$profile")
    done
  fi

  if [[ -f "$ENV_FILE" ]]; then
    args+=(--env-file "$ENV_FILE")
  fi

  args+=(-f "$COMPOSE_FILE")
  printf '%s\0' "${args[@]}"
}

compose() {
  local args=()
  while IFS= read -r -d '' arg; do
    args+=("$arg")
  done < <(compose_args)

  docker compose "${args[@]}" "$@"
}

run_check() {
  local name="$1"
  shift

  printf '[post-deploy] check: %s... ' "$name"
  if "$@" >"$POST_DEPLOY_STDOUT" 2>"$POST_DEPLOY_STDERR"; then
    printf 'ok\n'
    record_check "$name" "pass"
    if [[ -s "$POST_DEPLOY_STDERR" ]]; then
      sed 's/^/[post-deploy]   /' "$POST_DEPLOY_STDERR" >&2 || true
    fi
  else
    printf 'failed\n'
    record_check "$name" "fail"
    sed 's/^/[post-deploy]   /' "$POST_DEPLOY_STDERR" >&2 || true
    FAILED=$((FAILED + 1))
  fi
}

write_evidence() {
  local status="$1"

  mkdir -p "$(dirname "$POST_DEPLOY_EVIDENCE_OUTPUT")"
  POST_DEPLOY_STATUS="$status" \
  POST_DEPLOY_STARTED_AT="$POST_DEPLOY_STARTED_AT" \
  POST_DEPLOY_FINISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
  POST_DEPLOY_WARNED="$WARNED" \
  POST_DEPLOY_FAILED="$FAILED" \
  POST_DEPLOY_CHECK_LOG="$POST_DEPLOY_CHECK_LOG" \
  POST_DEPLOY_EVIDENCE_OUTPUT="$POST_DEPLOY_EVIDENCE_OUTPUT" \
  ENV_FILE="$ENV_FILE" \
  COMPOSE_FILE="$COMPOSE_FILE" \
  POST_DEPLOY_COMPOSE_CONFIG="$POST_DEPLOY_COMPOSE_CONFIG" \
  POST_DEPLOY_COMPOSE_PROFILES="$POST_DEPLOY_COMPOSE_PROFILES" \
  FORGEJO_LOCAL_URL="$FORGEJO_LOCAL_URL" \
  STEWARD_LOCAL_URL="$STEWARD_LOCAL_URL" \
  HTTP_TIMEOUT_SECONDS="$HTTP_TIMEOUT_SECONDS" \
  node <<'NODE'
const fs = require("node:fs");

const checkLog = process.env.POST_DEPLOY_CHECK_LOG;
const lines = fs.existsSync(checkLog) ? fs.readFileSync(checkLog, "utf8").trim().split("\n").filter(Boolean) : [];
const checks = lines.map((line, index) => {
  const [name = "", status = "unknown"] = line.split("\t");
  return {
    index: index + 1,
    name,
    status,
  };
});

const summary = checks.reduce((acc, check) => {
  if (check.status === "pass") acc.passed += 1;
  else if (check.status === "fail") acc.failed += 1;
  else acc.unknown += 1;
  return acc;
}, {
  total: checks.length,
  passed: 0,
  failed: 0,
  unknown: 0,
  warnings: Number(process.env.POST_DEPLOY_WARNED ?? 0),
});

const evidence = {
  schema: "https://eliza.hub/schemas/post-deploy-evidence.v1",
  status: process.env.POST_DEPLOY_STATUS,
  startedAt: process.env.POST_DEPLOY_STARTED_AT,
  finishedAt: process.env.POST_DEPLOY_FINISHED_AT,
  targets: {
    forgejoLocalUrl: process.env.FORGEJO_LOCAL_URL,
    stewardLocalUrl: process.env.STEWARD_LOCAL_URL,
    httpTimeoutSeconds: Number(process.env.HTTP_TIMEOUT_SECONDS ?? 0),
  },
  options: {
    composeProfiles: process.env.POST_DEPLOY_COMPOSE_PROFILES,
  },
  files: {
    envFile: process.env.ENV_FILE,
    composeFile: process.env.COMPOSE_FILE,
    composeConfig: process.env.POST_DEPLOY_COMPOSE_CONFIG,
  },
  summary,
  checks,
};

fs.writeFileSync(process.env.POST_DEPLOY_EVIDENCE_OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
NODE
  log "wrote post-deploy evidence: $POST_DEPLOY_EVIDENCE_OUTPUT"
}

check_compose_config() {
  compose config >"$POST_DEPLOY_COMPOSE_CONFIG"
}

check_env_validation() {
  ENV_FILE="$ENV_FILE" VALIDATE_STEWARD=true "$SCRIPT_DIR/validate-env.sh"
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

curl_text() {
  local url="$1"
  local token="${MERGE_STEWARD_DOCTOR_TOKEN:-${MERGE_STEWARD_API_TOKEN:-}}"
  local headers=()

  if [[ -n "$token" ]]; then
    headers=(-H "Authorization: Bearer $token")
  fi

  curl -fsS --max-time "$HTTP_TIMEOUT_SECONDS" "${headers[@]}" "$url"
}

curl_json_post() {
  local url="$1"
  local body="$2"
  local token="${MERGE_STEWARD_DOCTOR_TOKEN:-${MERGE_STEWARD_API_TOKEN:-}}"
  local headers=(-H "Content-Type: application/json")

  if [[ -n "$token" ]]; then
    headers+=(-H "Authorization: Bearer $token")
  fi

  curl -fsS --max-time "$HTTP_TIMEOUT_SECONDS" "${headers[@]}" -d "$body" "$url"
}

check_forgejo_http() {
  curl -fsS --max-time "$HTTP_TIMEOUT_SECONDS" "$FORGEJO_LOCAL_URL/api/healthz" >/dev/null \
    || curl -fsS --max-time "$HTTP_TIMEOUT_SECONDS" "$FORGEJO_LOCAL_URL/" >/dev/null
}

check_forgejo_eliza_theme() {
  curl -fsS --max-time "$HTTP_TIMEOUT_SECONDS" "$FORGEJO_LOCAL_URL/assets/css/theme-eliza.css" >/dev/null
  curl -fsSL --max-time "$HTTP_TIMEOUT_SECONDS" "$FORGEJO_LOCAL_URL/" | grep -q 'theme-eliza'
}

check_forgejo_identity() {
  FORGEJO_LOCAL_URL="$FORGEJO_LOCAL_URL" \
    APPLY_BOOTSTRAP=false \
    "$SCRIPT_DIR/bootstrap-forgejo-identity.sh"
}

check_steward_health() {
  curl_text "$STEWARD_LOCAL_URL/health" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'
}

check_steward_ready() {
  curl_text "$STEWARD_LOCAL_URL/ready" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'
}

check_steward_discovery() {
  curl_text "$STEWARD_LOCAL_URL/.well-known/eliza-hub.json" \
    | grep -q '"service"[[:space:]]*:[[:space:]]*"eliza-merge-steward"'
  curl_text "$STEWARD_LOCAL_URL/.well-known/eliza-hub.json" \
    | grep -q '"production_evidence_inventory"'
  curl_text "$STEWARD_LOCAL_URL/openapi.json" \
    | grep -q '"title"[[:space:]]*:[[:space:]]*"Eliza Merge Steward API"'
}

check_steward_product_apis() {
  local smoke_repo="${MERGE_STEWARD_SMOKE_REPO:-elizaos/eliza}"
  local smoke_agent="${MERGE_STEWARD_SMOKE_AGENT:-eliza-smoke-agent}"
  local smoke_repo_query="${smoke_repo//\//%2F}"
  local smoke_agent_path="${smoke_agent//\//%2F}"
  local smoke_agent_branch="${smoke_agent//\//-}"
  local merge_queue_response
  local production_evidence_template_response

  curl_text "$STEWARD_LOCAL_URL/api/workflows?readiness=false" \
    | grep -q '"workflow"[[:space:]]*:'
  curl_text "$STEWARD_LOCAL_URL/api/github-parity" \
    | grep -q '"parity"[[:space:]]*:'
  curl_text "$STEWARD_LOCAL_URL/api/production-readiness" \
    | grep -q '"productionReadiness"[[:space:]]*:'
  curl_text "$STEWARD_LOCAL_URL/api/production-cutover" \
    | grep -q '"productionCutover"[[:space:]]*:'
  production_evidence_template_response="$(curl_text "$STEWARD_LOCAL_URL/api/production-evidence-template")"
  printf '%s' "$production_evidence_template_response" | grep -q '"productionEvidenceTemplate"[[:space:]]*:'
  printf '%s' "$production_evidence_template_response" | grep -q 'production-evidence-inventory\.mjs --strict'
  curl_text "$STEWARD_LOCAL_URL/api/project-board?repo=$smoke_repo_query&readiness=false" \
    | grep -q '"board"[[:space:]]*:'
  curl_text "$STEWARD_LOCAL_URL/api/work-items?repo=$smoke_repo_query" \
    | grep -q '"workItems"[[:space:]]*:'
  curl_text "$STEWARD_LOCAL_URL/api/work-views?repo=$smoke_repo_query" \
    | grep -q '"workViews"[[:space:]]*:'
  curl_json_post "$STEWARD_LOCAL_URL/api/work-views/evaluate" \
    "{\"repo\":\"$smoke_repo\",\"maxItems\":5,\"maxPages\":5,\"view\":{\"repo\":\"$smoke_repo\",\"title\":\"Smoke docs view\",\"kind\":\"kanban\",\"filters\":{\"packages\":[\"docs\"]}}}" \
    | grep -q '"workViewEvaluation"[[:space:]]*:'
  curl_text "$STEWARD_LOCAL_URL/api/work-pages?repo=$smoke_repo_query" \
    | grep -q '"workPages"[[:space:]]*:'
  curl_text "$STEWARD_LOCAL_URL/api/fleet-coordination?repo=$smoke_repo_query&ownerAgentId=$smoke_agent_path" \
    | grep -q '"coordinationContract"[[:space:]]*:'
  curl_text "$STEWARD_LOCAL_URL/api/work-context?repo=$smoke_repo_query&ownerAgentId=$smoke_agent_path" \
    | grep -q '"workContext"[[:space:]]*:'
  curl_text "$STEWARD_LOCAL_URL/api/work-intake?repo=$smoke_repo_query" \
    | grep -q '"workIntake"[[:space:]]*:'
  merge_queue_response="$(curl_text "$STEWARD_LOCAL_URL/api/merge-queue?repo=$smoke_repo_query&readiness=false")"
  printf '%s' "$merge_queue_response" | grep -q '"mergeQueue"[[:space:]]*:'
  printf '%s' "$merge_queue_response" | grep -q '"diagnostics"[[:space:]]*:'
  curl_text "$STEWARD_LOCAL_URL/api/merge-train?repo=$smoke_repo_query&readiness=false" \
    | grep -q '"mergeTrain"[[:space:]]*:'
  curl_json_post "$STEWARD_LOCAL_URL/api/search" \
    "{\"repo\":\"$smoke_repo\",\"query\":\"smoke action log\",\"documents\":[{\"kind\":\"actions_log\",\"id\":\"smoke-actions-log\",\"repo\":\"$smoke_repo\",\"title\":\"smoke action log\",\"body\":\"Smoke Actions log for post-deploy search verification.\"}]}" \
    | grep -q '"search:actions-log"'
  curl_json_post "$STEWARD_LOCAL_URL/api/queue/simulate" \
    "{\"repo\":\"$smoke_repo\",\"targetBranch\":\"main\",\"proposedItem\":{\"id\":\"$smoke_repo#0-simulation\",\"repo\":\"$smoke_repo\",\"pullRequestId\":0,\"sourceBranch\":\"agent/$smoke_agent_branch/queue-simulation\",\"targetBranch\":\"main\",\"ownerAgentId\":\"$smoke_agent\",\"authorKind\":\"agent\",\"agentKnown\":true,\"hasIssueLink\":true,\"hasExecutionPlan\":true,\"hasValidationPlan\":true,\"targetProtected\":true,\"reviewSatisfied\":true,\"headShaMatches\":true,\"changedFiles\":[\"README.md\"],\"affectedPackages\":[\"docs\"],\"requiredChecks\":[]}}" \
    | grep -q '"simulation"[[:space:]]*:'
  curl_text "$STEWARD_LOCAL_URL/api/agent-identities" \
    | grep -q '"agents"[[:space:]]*:'
  curl_text "$STEWARD_LOCAL_URL/api/release-readiness?repo=$smoke_repo_query&readiness=false" \
    | grep -q '"releaseReadiness"[[:space:]]*:'
  curl_text "$STEWARD_LOCAL_URL/api/repository-protection?repo=$smoke_repo_query&requireLive=false" \
    | grep -q '"repositoryProtection"[[:space:]]*:'
  curl_text "$STEWARD_LOCAL_URL/api/agent-insights?repo=$smoke_repo_query&readiness=false" \
    | grep -q '"insights"[[:space:]]*:'
  curl_text "$STEWARD_LOCAL_URL/api/agents?repo=$smoke_repo_query&readiness=false" \
    | grep -q '"agents"[[:space:]]*:'
  curl_text "$STEWARD_LOCAL_URL/api/agent-performance?repo=$smoke_repo_query&readiness=false" \
    | grep -q '"performance"[[:space:]]*:'
  curl_text "$STEWARD_LOCAL_URL/api/agent-routing?repo=$smoke_repo_query&readiness=false" \
    | grep -q '"routing"[[:space:]]*:'
  curl_text "$STEWARD_LOCAL_URL/api/agents/$smoke_agent_path/bootstrap?repo=$smoke_repo_query&readiness=false" \
    | grep -q '"bootstrap"[[:space:]]*:'
  curl_text "$STEWARD_LOCAL_URL/api/agents/$smoke_agent_path/cockpit?repo=$smoke_repo_query&targetBranch=main&readiness=false" \
    | grep -q '"cockpit"[[:space:]]*:'
  curl_json_post "$STEWARD_LOCAL_URL/api/agents/$smoke_agent_path/action-plan" \
    "{\"repo\":\"$smoke_repo\",\"targetBranch\":\"main\",\"query\":\"smoke action plan\",\"commands\":[\"turbo run typecheck --filter=@elizaos/core\"],\"proposedItem\":{\"repo\":\"$smoke_repo\",\"targetBranch\":\"main\",\"sourceBranch\":\"agent/$smoke_agent_branch/action-plan\",\"ownerAgentId\":\"$smoke_agent\",\"authorKind\":\"agent\",\"agentKnown\":true,\"hasIssueLink\":true,\"hasExecutionPlan\":true,\"hasValidationPlan\":true,\"changedFiles\":[\"README.md\"],\"affectedPackages\":[\"docs\"]},\"documents\":[{\"kind\":\"actions_log\",\"id\":\"smoke-action-plan-log\",\"repo\":\"$smoke_repo\",\"targetBranch\":\"main\",\"ownerAgentId\":\"$smoke_agent\",\"title\":\"smoke action plan\",\"body\":\"Smoke action plan context.\"}],\"readiness\":false}" \
    | grep -q '"agent-action-plan:'
  curl_json_post "$STEWARD_LOCAL_URL/api/agents/$smoke_agent_path/submission-gate" \
    "{\"repo\":\"$smoke_repo\",\"proposedItem\":{\"repo\":\"$smoke_repo\",\"ownerAgentId\":\"$smoke_agent\",\"authorKind\":\"agent\",\"agentKnown\":true,\"hasIssueLink\":true,\"hasExecutionPlan\":true,\"hasValidationPlan\":true,\"changedFiles\":[\"README.md\"],\"requiredChecks\":[]}}" \
    | grep -q '"submission:allowed"'
  curl_json_post "$STEWARD_LOCAL_URL/api/agents/$smoke_agent_path/work-preflight" \
    "{\"repo\":\"$smoke_repo\",\"targetBranch\":\"main\",\"changedFiles\":[\"README.md\"],\"affectedPackages\":[\"docs\"]}" \
    | grep -q '"work-preflight:allowed"'
  curl_json_post "$STEWARD_LOCAL_URL/api/agents/$smoke_agent_path/work-reservation" \
    "{\"repo\":\"$smoke_repo\",\"targetBranch\":\"main\",\"changedFiles\":[\"README.md\"],\"affectedPackages\":[\"docs\"],\"dryRun\":true}" \
    | grep -q '"work-reservation:dry-run"'
  curl_json_post "$STEWARD_LOCAL_URL/api/ci/failure-analysis" \
    "{\"item\":{\"id\":\"$smoke_repo#0\",\"repo\":\"$smoke_repo\",\"ownerAgentId\":\"$smoke_agent\"},\"checks\":[{\"name\":\"smoke\",\"conclusion\":\"failure\",\"log\":\"AssertionError: smoke failure route test\"}]}" \
    | grep -q '"primaryCategory"[[:space:]]*:[[:space:]]*"test_failure"'
  curl_json_post "$STEWARD_LOCAL_URL/api/ci/validation-plan" \
    "{\"repo\":\"$smoke_repo\",\"ownerAgentId\":\"$smoke_agent\",\"changedFiles\":[\"packages/core/src/runtime.ts\"],\"commands\":[\"turbo run typecheck --filter=@elizaos/core\"]}" \
    | grep -q '"allowed"[[:space:]]*:[[:space:]]*true'
  curl_json_post "$STEWARD_LOCAL_URL/api/pr/brief" \
    "{\"item\":{\"id\":\"$smoke_repo#0\",\"repo\":\"$smoke_repo\",\"pullRequestId\":0,\"ownerAgentId\":\"$smoke_agent\",\"authorKind\":\"agent\",\"agentKnown\":true,\"hasIssueLink\":true,\"hasExecutionPlan\":true,\"hasValidationPlan\":true,\"targetProtected\":true,\"reviewSatisfied\":true,\"headShaMatches\":true,\"changedFiles\":[\"README.md\"],\"requiredChecks\":[]}}" \
    | grep -q '"risk:low"'
  curl_json_post "$STEWARD_LOCAL_URL/api/review/assignment" \
    "{\"repo\":\"$smoke_repo\",\"targetBranch\":\"main\",\"ownerAgentId\":\"$smoke_agent\",\"changedFiles\":[\"README.md\"],\"affectedPackages\":[\"docs\"]}" \
    | grep -q '"review-assignment:'
  curl_json_post "$STEWARD_LOCAL_URL/api/patch/conflict-prediction" \
    "{\"repo\":\"$smoke_repo\",\"targetBranch\":\"main\",\"ownerAgentId\":\"$smoke_agent\",\"changedFiles\":[\"README.md\"],\"affectedPackages\":[\"docs\"]}" \
    | grep -q '"patch-conflict:clear"'
  curl_text "$STEWARD_LOCAL_URL/api/agents/$smoke_agent_path/inbox?repo=$smoke_repo_query&readiness=false" \
    | grep -q '"inbox"[[:space:]]*:'
}

check_steward_metrics() {
  if [[ "${MERGE_STEWARD_METRICS_AUTH_REQUIRED:-true}" == "true" ]] \
    && [[ -z "${MERGE_STEWARD_DOCTOR_TOKEN:-${MERGE_STEWARD_API_TOKEN:-}}" ]]; then
    printf 'metrics auth is required but MERGE_STEWARD_API_TOKEN or MERGE_STEWARD_DOCTOR_TOKEN is not set\n' >&2
    return 1
  fi

  curl_text "$STEWARD_LOCAL_URL/metrics" | grep -q '^eliza_merge_steward_ready'
}

check_doctor() {
  [[ -f "$REPO_ROOT/services/merge-steward/package.json" ]] || {
    printf 'Merge Steward package is missing from %s\n' "$REPO_ROOT" >&2
    return 1
  }
  command -v npm >/dev/null 2>&1 || {
    printf 'npm is required to run the deployment doctor\n' >&2
    return 1
  }

  (
    cd "$REPO_ROOT"
    MERGE_STEWARD_DOCTOR_TOKEN="${MERGE_STEWARD_DOCTOR_TOKEN:-${MERGE_STEWARD_API_TOKEN:-}}" \
      npm run doctor --prefix services/merge-steward -- "$STEWARD_LOCAL_URL"
  )
}

check_merge_queue_rollout_drill() {
  STEWARD_LOCAL_URL="$STEWARD_LOCAL_URL" \
    MERGE_QUEUE_ROLLOUT_CHECK_DOCTOR=false \
    "$SCRIPT_DIR/merge-queue-rollout-drill.sh"
}

check_promtool_if_available() {
  if ! command -v promtool >/dev/null 2>&1; then
    warn "promtool is not installed; skipping Prometheus syntax validation"
    return 0
  fi

  (
    cd "$DEPLOY_DIR/observability"
    promtool check config prometheus.yml
    promtool check rules merge-steward-alerts.yml
  )
}

main() {
  require_command docker
  require_command curl
  require_command grep
  require_command node
  eliza_prepare_artifact_dirs
  : >"$POST_DEPLOY_CHECK_LOG"
  load_env_file

  FORGEJO_LOCAL_URL="${FORGEJO_LOCAL_URL:-http://127.0.0.1:${FORGEJO_HTTP_PORT:-3000}}"
  STEWARD_LOCAL_URL="${STEWARD_LOCAL_URL:-http://127.0.0.1:${MERGE_STEWARD_HTTP_PORT:-8080}}"

  log "using compose file: $COMPOSE_FILE"
  log "using env file: $ENV_FILE"
  log "using tmp root: $ELIZA_TMP_ROOT"
  log "checking Forgejo at: $FORGEJO_LOCAL_URL"
  log "checking Merge Steward at: $STEWARD_LOCAL_URL"

  run_check "private env validates" check_env_validation
  run_check "compose config renders" check_compose_config
  run_check "postgres container is running and healthy" check_service_running postgres
  run_check "forgejo container is running and healthy" check_service_running forgejo
  run_check "merge-steward container is running and healthy" check_service_running merge-steward
  run_check "Forgejo HTTP responds" check_forgejo_http
  run_check "Forgejo Eliza theme asset and default theme render" check_forgejo_eliza_theme
  run_check "Forgejo recovery admin and Eliza Cloud SSO are bootstrapped" check_forgejo_identity
  run_check "Merge Steward /health is ok" check_steward_health
  run_check "Merge Steward /ready is ok" check_steward_ready
  run_check "Merge Steward discovery manifest and OpenAPI contract respond with production evidence hints" check_steward_discovery
  run_check "Merge Steward workflow, parity, production readiness, production cutover, evidence template, board, work items, work view evaluation, work pages, fleet coordination, work context, merge queue diagnostics, merge train plan, search, queue simulation, agent identities, insights, agents, agent performance, agent routing, agent bootstrap, agent cockpit, agent action plan, submission gate, work preflight, work reservation, CI failure analysis, validation plan, PR brief, review assignment, patch conflict prediction, and agent inbox APIs respond" check_steward_product_apis
  run_check "Merge Steward /metrics exports readiness" check_steward_metrics
  run_check "Merge Steward deployment doctor passes" check_doctor
  run_check "Merge queue rollout drill stays safely gated" check_merge_queue_rollout_drill
  run_check "Prometheus config validates when promtool exists" check_promtool_if_available

  rm -f "$POST_DEPLOY_STDOUT" "$POST_DEPLOY_STDERR"

  if ((FAILED > 0)); then
    write_evidence "failed"
    fail_now "$FAILED post-deploy checks failed"
  fi

  write_evidence "passed"

  if ((WARNED > 0)); then
    log "post-deploy checks passed with $WARNED warning(s)"
  else
    log "post-deploy checks passed"
  fi
}

main "$@"
