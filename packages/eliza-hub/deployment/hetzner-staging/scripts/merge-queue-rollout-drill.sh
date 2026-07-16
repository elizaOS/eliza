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
STEWARD_LOCAL_URL="${STEWARD_LOCAL_URL:-}"
HTTP_TIMEOUT_SECONDS="${HTTP_TIMEOUT_SECONDS:-5}"
MERGE_QUEUE_ROLLOUT_CHECK_DOCTOR="${MERGE_QUEUE_ROLLOUT_CHECK_DOCTOR:-true}"
MERGE_QUEUE_ROLLOUT_SMOKE_REPO="${MERGE_QUEUE_ROLLOUT_SMOKE_REPO:-${MERGE_STEWARD_SMOKE_REPO:-elizaos/eliza}}"
MERGE_QUEUE_ROLLOUT_SMOKE_AGENT="${MERGE_QUEUE_ROLLOUT_SMOKE_AGENT:-${MERGE_STEWARD_SMOKE_AGENT:-eliza-smoke-agent}}"
MERGE_QUEUE_ROLLOUT_SMOKE_PR="${MERGE_QUEUE_ROLLOUT_SMOKE_PR:-9001}"
MERGE_QUEUE_ROLLOUT_EVIDENCE_OUT="${MERGE_QUEUE_ROLLOUT_EVIDENCE_OUT:-}"
MERGE_QUEUE_ROLLOUT_STDOUT="${MERGE_QUEUE_ROLLOUT_STDOUT:-$(eliza_tmp_path eliza-hub-merge-queue-rollout.out)}"
MERGE_QUEUE_ROLLOUT_STDERR="${MERGE_QUEUE_ROLLOUT_STDERR:-$(eliza_tmp_path eliza-hub-merge-queue-rollout.err)}"
FAILED=0
WARNED=0
CHECK_RESULTS=()

log() {
  printf '[merge-queue-rollout] %s\n' "$*"
}

warn() {
  WARNED=$((WARNED + 1))
  printf '[merge-queue-rollout] warning: %s\n' "$*" >&2
}

fail_now() {
  printf '[merge-queue-rollout] error: %s\n' "$*" >&2
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
  safe_load_env_file "$ENV_FILE" "${ALLOW_ENV_ONLY:-false}" "merge-queue-rollout"
}

run_check() {
  local name="$1"
  shift

  printf '[merge-queue-rollout] check: %s... ' "$name"
  if "$@" >"$MERGE_QUEUE_ROLLOUT_STDOUT" 2>"$MERGE_QUEUE_ROLLOUT_STDERR"; then
    printf 'ok\n'
    CHECK_RESULTS+=("true	$name")
    if [[ -s "$MERGE_QUEUE_ROLLOUT_STDERR" ]]; then
      sed 's/^/[merge-queue-rollout]   /' "$MERGE_QUEUE_ROLLOUT_STDERR" >&2 || true
    fi
  else
    printf 'failed\n'
    CHECK_RESULTS+=("false	$name")
    sed 's/^/[merge-queue-rollout]   /' "$MERGE_QUEUE_ROLLOUT_STDERR" >&2 || true
    FAILED=$((FAILED + 1))
  fi
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

smoke_plan_body() {
  node - "$MERGE_QUEUE_ROLLOUT_SMOKE_REPO" "$MERGE_QUEUE_ROLLOUT_SMOKE_AGENT" "$MERGE_QUEUE_ROLLOUT_SMOKE_PR" <<'NODE'
const [repo, agent, pullRequestId] = process.argv.slice(2);
const pr = Number.parseInt(pullRequestId, 10);

process.stdout.write(JSON.stringify({
  items: [{
    id: `${repo}#${pr}`,
    repo,
    pullRequestId: pr,
    sourceBranch: `agent/${agent}/rollout-smoke`,
    targetBranch: "develop",
    headSha: "merge-queue-rollout-smoke-sha",
    authorKind: "agent",
    ownerAgentId: agent,
    agentKnown: true,
    hasIssueLink: true,
    hasExecutionPlan: true,
    hasValidationPlan: true,
    targetProtected: true,
    reviewSatisfied: true,
    headShaMatches: true,
    changedFiles: ["packages/core/src/rollout-smoke.ts"],
    requiredChecks: ["smoke"],
    checkResults: { smoke: "success" }
  }]
}));
NODE
}

assert_ready_json() {
  # shellcheck disable=SC2016
  node -e '
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(0, "utf8"));
if (body.ok !== true) {
  console.error("ready response did not report ok=true");
  process.exit(1);
}

const preflight = (body.checks ?? []).find((check) => check.name === "runtime_preflight");
if (preflight && preflight.ok !== true) {
  console.error("runtime_preflight is not ok");
  process.exit(1);
}
'
}

assert_plan_json() {
  # shellcheck disable=SC2016
  node -e '
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(0, "utf8"));
const plan = body.plan ?? body;
const itemPlan = plan.plans?.[0];

if (!itemPlan || plan.planCount < 1) {
  console.error("integration plan did not select the smoke queue item");
  process.exit(1);
}

const actionTypes = new Set((itemPlan.actions ?? []).map((action) => action.type));
for (const required of [
  "ensure_integration_branch",
  "merge_pr_head_into_integration",
  "wait_for_checks",
  "merge_original_pull_request",
]) {
  if (!actionTypes.has(required)) {
    console.error(`integration plan is missing action ${required}`);
    process.exit(1);
  }
}
'
}

assert_unconfirmed_execution_json() {
  # shellcheck disable=SC2016
  node -e '
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(0, "utf8"));
const execution = body.execution ?? body;
const safeReasons = new Set([
  "integration_disabled",
  "integration_execution_not_confirmed",
  "live_integration_disabled",
  "no_ready_items",
]);

if (execution.skipped !== true || !safeReasons.has(execution.reason)) {
  console.error(`unconfirmed execution was not safely blocked: ${JSON.stringify(execution)}`);
  process.exit(1);
}
'
}

assert_unconfirmed_run_once_json() {
  # shellcheck disable=SC2016
  node -e '
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(0, "utf8"));
const safeReasons = new Set([
  "integration_disabled",
  "integration_execution_not_confirmed",
  "live_integration_disabled",
  "no_ready_items",
]);

if (body.claimed !== false || !safeReasons.has(body.reason)) {
  console.error(`unconfirmed run-once was not safely blocked: ${JSON.stringify(body)}`);
  process.exit(1);
}
'
}

check_steward_ready() {
  curl_text "$STEWARD_LOCAL_URL/ready" | assert_ready_json
}

check_doctor() {
  if ! is_true "$MERGE_QUEUE_ROLLOUT_CHECK_DOCTOR"; then
    warn "MERGE_QUEUE_ROLLOUT_CHECK_DOCTOR=false; skipping deployment doctor"
    return 0
  fi

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

check_non_mutating_plan() {
  local body
  body="$(smoke_plan_body)"
  curl_json_post "$STEWARD_LOCAL_URL/api/queue/integration-plan" "$body" | assert_plan_json
}

check_unconfirmed_manual_execution_is_blocked() {
  local body
  body="$(smoke_plan_body)"
  curl_json_post "$STEWARD_LOCAL_URL/api/queue/integration-execution" "$body" | assert_unconfirmed_execution_json
}

check_unconfirmed_worker_run_is_blocked() {
  curl_json_post "$STEWARD_LOCAL_URL/api/queue/run-once" \
    '{"workerId":"merge-queue-rollout-drill","confirm":false}' \
    | assert_unconfirmed_run_once_json
}

write_rollout_evidence() {
  if [[ -z "$MERGE_QUEUE_ROLLOUT_EVIDENCE_OUT" ]]; then
    return 0
  fi

  node - "$MERGE_QUEUE_ROLLOUT_EVIDENCE_OUT" \
    "$STEWARD_LOCAL_URL" \
    "$MERGE_QUEUE_ROLLOUT_SMOKE_REPO" \
    "$MERGE_QUEUE_ROLLOUT_SMOKE_AGENT" \
    "$MERGE_QUEUE_ROLLOUT_SMOKE_PR" \
    "${CHECK_RESULTS[@]}" <<'NODE'
const { chmodSync, writeFileSync } = require("node:fs");

const [out, stewardUrl, smokeRepo, smokeAgent, smokePullRequestId, ...rawChecks] = process.argv.slice(2);
const checks = rawChecks.map((line) => {
  const separator = line.indexOf("\t");
  const ok = line.slice(0, separator) === "true";
  const name = line.slice(separator + 1);
  return { name, ok };
});
const dryRunPassed = checks.length > 0 && checks.every((check) => check.ok === true);
const evidence = {
  mergeQueueRolloutDrill: {
    dryRunPassed,
    stagedLiveDrillPassed: false,
    workerLeaseVerified: false,
    rollbackDrillPassed: false,
    humanApprovalRecorded: false,
    checkedAt: new Date().toISOString(),
    safeMode: true,
    stewardUrl,
    smokeRepo,
    smokeAgent,
    smokePullRequestId: Number.parseInt(smokePullRequestId, 10),
    checks,
  },
};

writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
chmodSync(out, 0o600);
NODE
  log "wrote merge queue rollout evidence: $MERGE_QUEUE_ROLLOUT_EVIDENCE_OUT"
}

main() {
  require_command curl
  require_command node
  eliza_prepare_artifact_dirs
  load_env_file

  STEWARD_LOCAL_URL="${STEWARD_LOCAL_URL:-http://127.0.0.1:${MERGE_STEWARD_HTTP_PORT:-8080}}"

  log "using env file: $ENV_FILE"
  log "using tmp root: $ELIZA_TMP_ROOT"
  log "checking Merge Steward at: $STEWARD_LOCAL_URL"
  log "smoke repo: $MERGE_QUEUE_ROLLOUT_SMOKE_REPO"
  log "safe mode: no confirmation token is sent to live execution endpoints"

  run_check "Merge Steward /ready is ok" check_steward_ready
  run_check "Merge Steward deployment doctor passes" check_doctor
  run_check "synthetic queue item creates an integration plan" check_non_mutating_plan
  run_check "manual live execution stays blocked without confirmation" check_unconfirmed_manual_execution_is_blocked
  run_check "worker run-once stays blocked without confirmation" check_unconfirmed_worker_run_is_blocked

  rm -f "$MERGE_QUEUE_ROLLOUT_STDOUT" "$MERGE_QUEUE_ROLLOUT_STDERR"
  write_rollout_evidence

  if ((FAILED > 0)); then
    fail_now "$FAILED merge queue rollout drill check(s) failed"
  fi

  if ((WARNED > 0)); then
    log "merge queue rollout drill passed with $WARNED warning(s)"
  else
    log "merge queue rollout drill passed"
  fi
}

main "$@"
