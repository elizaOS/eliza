#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/../.." && pwd)"

# shellcheck source=artifact-paths.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/artifact-paths.sh"

ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$DEPLOY_DIR/compose.yml}"
RUNNER_COMPOSE_FILE="${RUNNER_COMPOSE_FILE:-$DEPLOY_DIR/compose.actions-runner.yml}"
RUNNER_CONFIG_TEMPLATE="${RUNNER_CONFIG_TEMPLATE:-$DEPLOY_DIR/runner/config.example.yml}"
INFRA_DIR="${INFRA_DIR:-$DEPLOY_DIR/terraform}"
RELEASE_GATE_MODE="${RELEASE_GATE_MODE:-staging}"
VALIDATE_RUNNER="${VALIDATE_RUNNER:-true}"
if [[ "$RELEASE_GATE_MODE" == "production" ]]; then
  VALIDATE_PRODUCTION_GATE="${VALIDATE_PRODUCTION_GATE:-true}"
  VALIDATE_PRODUCTION_INVENTORY="${VALIDATE_PRODUCTION_INVENTORY:-true}"
else
  VALIDATE_PRODUCTION_GATE="${VALIDATE_PRODUCTION_GATE:-false}"
  VALIDATE_PRODUCTION_INVENTORY="${VALIDATE_PRODUCTION_INVENTORY:-false}"
fi
PRODUCTION_EVIDENCE_FILE="${PRODUCTION_EVIDENCE_FILE:-}"
RUN_TESTS="${RUN_TESTS:-true}"
RELEASE_GATE_STDOUT="${RELEASE_GATE_STDOUT:-$(eliza_tmp_path eliza-hub-release-gate.out)}"
RELEASE_GATE_STDERR="${RELEASE_GATE_STDERR:-$(eliza_tmp_path eliza-hub-release-gate.err)}"
RELEASE_COMPOSE_CONFIG="${RELEASE_COMPOSE_CONFIG:-$(eliza_tmp_path eliza-hub-release-compose.yml)}"
RELEASE_RUNNER_COMPOSE_CONFIG="${RELEASE_RUNNER_COMPOSE_CONFIG:-$(eliza_tmp_path eliza-hub-release-runner-compose.yml)}"
PRODUCTION_GATE_OUTPUT="${PRODUCTION_GATE_OUTPUT:-$(eliza_tmp_path eliza-hub-production-gate.json)}"
FAILED=0

log() {
  printf '[release-gate] %s\n' "$*"
}

fail_now() {
  printf '[release-gate] error: %s\n' "$*" >&2
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

run_check() {
  local name="$1"
  shift

  printf '[release-gate] check: %s... ' "$name"
  if "$@" >"$RELEASE_GATE_STDOUT" 2>"$RELEASE_GATE_STDERR"; then
    printf 'ok\n'
  else
    printf 'failed\n'
    sed 's/^/[release-gate]   /' "$RELEASE_GATE_STDERR" >&2 || true
    FAILED=$((FAILED + 1))
  fi
}

check_git_clean() {
  [[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]]
}

check_shell_syntax() {
  bash -n "$DEPLOY_DIR"/scripts/*.sh
}

check_shell_lint() {
  require_command shellcheck
  shellcheck "$DEPLOY_DIR"/scripts/*.sh "$REPO_ROOT"/scripts/*.sh
}

check_node_syntax() {
  require_command node
  node --check "$DEPLOY_DIR/scripts/backup-evidence.mjs"
  node --check "$DEPLOY_DIR/scripts/artifact-paths.mjs"
  node --check "$DEPLOY_DIR/scripts/database-evidence.mjs"
  node --check "$DEPLOY_DIR/scripts/image-provenance-evidence.mjs"
  node --check "$DEPLOY_DIR/scripts/mail-evidence.mjs"
  node --check "$DEPLOY_DIR/scripts/merge-queue-live-drill-evidence.mjs"
  node --check "$DEPLOY_DIR/scripts/merge-queue-rollout-evidence.mjs"
  node --check "$DEPLOY_DIR/scripts/observability-evidence.mjs"
  node --check "$DEPLOY_DIR/scripts/pilot-bootstrap.mjs"
  node --check "$DEPLOY_DIR/scripts/production-evidence-assemble.mjs"
  node --check "$DEPLOY_DIR/scripts/production-evidence-inventory.mjs"
  node --check "$DEPLOY_DIR/scripts/repository-evidence.mjs"
  node --check "$DEPLOY_DIR/scripts/runner-smoke-evidence.mjs"
  node --check "$DEPLOY_DIR/scripts/secret-management-evidence.mjs"
  node --check "$DEPLOY_DIR/scripts/security-review-evidence.mjs"
  node --check "$DEPLOY_DIR/scripts/sso-evidence.mjs"
  node --check "$DEPLOY_DIR/scripts/sso-smoke-evidence.mjs"
  node --check "$DEPLOY_DIR/scripts/steward-evidence.mjs"
  node --check "$DEPLOY_DIR/scripts/storage-evidence.mjs"
}

check_private_references() {
  "$REPO_ROOT/scripts/private-reference-scan.sh"
}

check_infrastructure_config() {
  INFRA_DIR="$INFRA_DIR" "$SCRIPT_DIR/validate-infrastructure.sh"
}

check_private_env() {
  ENV_FILE="$ENV_FILE" VALIDATE_STEWARD=true VALIDATE_RUNNER="$VALIDATE_RUNNER" "$SCRIPT_DIR/validate-env.sh"
}

compose_base() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile steward "$@"
}

compose_runner() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$RUNNER_COMPOSE_FILE" --profile steward --profile actions-runner "$@"
}

check_compose_base() {
  compose_base config >"$RELEASE_COMPOSE_CONFIG"
}

check_compose_runner() {
  if ! is_true "$VALIDATE_RUNNER"; then
    return 0
  fi
  compose_runner config >"$RELEASE_RUNNER_COMPOSE_CONFIG"
}

check_compose_steward_oidc_env() {
  [[ -f "$RELEASE_COMPOSE_CONFIG" ]] || compose_base config >"$RELEASE_COMPOSE_CONFIG"

  local key
  local missing=0
  for key in \
    MERGE_STEWARD_OIDC_REQUIRED_ROLES \
    MERGE_STEWARD_OIDC_REQUIRED_GROUPS \
    MERGE_STEWARD_OIDC_ADMIN_ROLES \
    MERGE_STEWARD_OIDC_ADMIN_GROUPS
  do
    if ! grep -Eq "^[[:space:]]+$key:" "$RELEASE_COMPOSE_CONFIG"; then
      printf 'rendered compose is missing %s for merge-steward\n' "$key" >&2
      missing=1
    fi
  done

  return "$missing"
}

check_runner_isolation() {
  if ! is_true "$VALIDATE_RUNNER"; then
    return 0
  fi

  [[ -f "$RELEASE_RUNNER_COMPOSE_CONFIG" ]] || compose_runner config >"$RELEASE_RUNNER_COMPOSE_CONFIG"

  if grep -q '/var/run/docker.sock' "$RELEASE_RUNNER_COMPOSE_CONFIG" "$RUNNER_CONFIG_TEMPLATE"; then
    printf 'runner must not mount or reference the host Docker socket\n' >&2
    return 1
  fi

  if grep -Eq '^\s*ports:' "$RUNNER_COMPOSE_FILE"; then
    printf 'runner overlay must not publish DIND ports\n' >&2
    return 1
  fi

  if grep -Eq '^\s*-\s*[A-Za-z0-9_-]+:host\s*$' "$RUNNER_CONFIG_TEMPLATE"; then
    printf 'runner config must not use :host labels\n' >&2
    return 1
  fi
}

check_node_suite() {
  if ! is_true "$RUN_TESTS"; then
    return 0
  fi

  require_command npm
  npm run check --prefix "$REPO_ROOT/services/merge-steward"
  npm test --prefix "$REPO_ROOT/services/merge-steward"
  npm audit --prefix "$REPO_ROOT/services/merge-steward" --omit=dev
}

print_production_gate_summary() {
  local output_file="$1"

  node - "$output_file" <<'NODE'
const fs = require("node:fs");

const outputFile = process.argv[2];
const body = JSON.parse(fs.readFileSync(outputFile, "utf8"));
const gate = body.productionGate ?? body;
const summary = gate.summary ?? {};

console.error(
  `production gate failed: ${summary.failed ?? 0} readiness check(s), ${summary.shapeErrors ?? 0} shape error(s)`,
);

for (const error of gate.evidenceShape?.errors ?? []) {
  console.error(`shape ${error.path}: ${error.message}`);
}

for (const check of gate.checks ?? []) {
  if (check.ok) continue;

  const errors = check.errors ?? [];
  if (errors.length === 0) {
    console.error(`${check.name}: failed`);
    continue;
  }

  for (const error of errors.slice(0, 5)) {
    console.error(`${check.name}: ${error.message}`);
  }

  if (errors.length > 5) {
    console.error(`${check.name}: ${errors.length - 5} more error(s)`);
  }
}
NODE
}

check_production_gate() {
  case "$RELEASE_GATE_MODE" in
    staging|production) ;;
    *)
      printf 'RELEASE_GATE_MODE must be staging or production\n' >&2
      return 1
      ;;
  esac

  if [[ "$RELEASE_GATE_MODE" == "production" ]] && ! is_true "$VALIDATE_PRODUCTION_GATE"; then
    printf 'VALIDATE_PRODUCTION_GATE must be true when RELEASE_GATE_MODE=production\n' >&2
    return 1
  fi

  if [[ "$RELEASE_GATE_MODE" == "production" ]] && ! is_true "$VALIDATE_PRODUCTION_INVENTORY"; then
    printf 'VALIDATE_PRODUCTION_INVENTORY must be true when RELEASE_GATE_MODE=production\n' >&2
    return 1
  fi

  if ! is_true "$VALIDATE_PRODUCTION_GATE"; then
    return 0
  fi

  require_command node

  if [[ -z "$PRODUCTION_EVIDENCE_FILE" ]]; then
    printf 'PRODUCTION_EVIDENCE_FILE is required when VALIDATE_PRODUCTION_GATE=true\n' >&2
    return 1
  fi

  if [[ ! -f "$PRODUCTION_EVIDENCE_FILE" ]]; then
    printf 'missing production evidence file: %s\n' "$PRODUCTION_EVIDENCE_FILE" >&2
    return 1
  fi

  if is_true "$VALIDATE_PRODUCTION_INVENTORY"; then
    node "$DEPLOY_DIR/scripts/production-evidence-inventory.mjs" \
      --artifact-root "$ELIZA_ARTIFACT_ROOT" \
      --template "$DEPLOY_DIR/release/production-evidence.example.json" \
      --out "$PRODUCTION_EVIDENCE_FILE" \
      --strict >/dev/null
  fi

  local output_file
  local production_artifact_validation
  local production_freshness_validation
  output_file="$PRODUCTION_GATE_OUTPUT"
  production_artifact_validation="${PRODUCTION_GATE_VALIDATE_ARTIFACTS:-false}"
  production_freshness_validation="${PRODUCTION_GATE_VALIDATE_FRESHNESS:-false}"
  if [[ "$RELEASE_GATE_MODE" == "production" ]]; then
    production_artifact_validation=true
    production_freshness_validation=true
  fi

  if ! PRODUCTION_GATE_VALIDATE_ARTIFACTS="$production_artifact_validation" \
    PRODUCTION_GATE_VALIDATE_FRESHNESS="$production_freshness_validation" \
    node "$REPO_ROOT/services/merge-steward/src/cli.js" production-gate --strict < "$PRODUCTION_EVIDENCE_FILE" >"$output_file"; then
    print_production_gate_summary "$output_file" || cat "$output_file" >&2 || true
    return 1
  fi
}

check_required_files() {
  local file
  for file in \
    "$DEPLOY_DIR/compose.yml" \
    "$DEPLOY_DIR/compose.actions-runner.yml" \
    "$DEPLOY_DIR/observability/prometheus.yml" \
    "$DEPLOY_DIR/observability/merge-steward-alerts.yml" \
    "$DEPLOY_DIR/reverse-proxy/Caddyfile.example" \
    "$DEPLOY_DIR/reverse-proxy/README.md" \
    "$DEPLOY_DIR/terraform/.terraform.lock.hcl" \
    "$DEPLOY_DIR/terraform/README.md" \
    "$DEPLOY_DIR/terraform/backend.hcl.example" \
    "$DEPLOY_DIR/terraform/cloud-init.yaml.tftpl" \
    "$DEPLOY_DIR/terraform/files/Caddyfile.tftpl" \
    "$DEPLOY_DIR/terraform/files/99-eliza-hub-sshd.conf.tftpl" \
    "$DEPLOY_DIR/terraform/files/20auto-upgrades" \
    "$DEPLOY_DIR/terraform/files/docker-daemon.json" \
    "$DEPLOY_DIR/terraform/files/fail2ban-sshd.local" \
    "$DEPLOY_DIR/terraform/files/install-node-24.sh" \
    "$DEPLOY_DIR/terraform/main.tf" \
    "$DEPLOY_DIR/terraform/outputs.tf" \
    "$DEPLOY_DIR/terraform/terraform.tfvars.example" \
    "$DEPLOY_DIR/terraform/variables.tf" \
    "$DEPLOY_DIR/terraform/versions.tf" \
    "$DEPLOY_DIR/scripts/bootstrap-forgejo-identity.sh" \
    "$DEPLOY_DIR/scripts/deploy.sh" \
    "$DEPLOY_DIR/scripts/artifact-paths.sh" \
    "$DEPLOY_DIR/scripts/artifact-paths.mjs" \
    "$DEPLOY_DIR/scripts/host-preflight.sh" \
    "$DEPLOY_DIR/scripts/validate-infrastructure.sh" \
    "$DEPLOY_DIR/scripts/merge-queue-rollout-drill.sh" \
    "$DEPLOY_DIR/scripts/backup.sh" \
    "$DEPLOY_DIR/scripts/backup-offsite.sh" \
    "$DEPLOY_DIR/scripts/backup-evidence.mjs" \
    "$DEPLOY_DIR/scripts/database-evidence.mjs" \
    "$DEPLOY_DIR/scripts/image-provenance-evidence.mjs" \
    "$DEPLOY_DIR/scripts/mail-evidence.mjs" \
    "$DEPLOY_DIR/scripts/merge-queue-rollout-evidence.mjs" \
    "$DEPLOY_DIR/scripts/observability-evidence.mjs" \
    "$DEPLOY_DIR/scripts/pilot-bootstrap.mjs" \
    "$DEPLOY_DIR/scripts/production-evidence-assemble.mjs" \
    "$DEPLOY_DIR/scripts/production-evidence-inventory.mjs" \
    "$DEPLOY_DIR/scripts/repository-evidence.mjs" \
    "$DEPLOY_DIR/scripts/runner-smoke-evidence.mjs" \
    "$DEPLOY_DIR/scripts/secret-management-evidence.mjs" \
    "$DEPLOY_DIR/scripts/security-review-evidence.mjs" \
    "$DEPLOY_DIR/scripts/sso-evidence.mjs" \
    "$DEPLOY_DIR/scripts/sso-smoke-evidence.mjs" \
    "$DEPLOY_DIR/scripts/steward-evidence.mjs" \
    "$DEPLOY_DIR/scripts/storage-evidence.mjs" \
    "$DEPLOY_DIR/scripts/runner-evidence.sh" \
    "$DEPLOY_DIR/scripts/restore-check.sh" \
    "$DEPLOY_DIR/scripts/restore-drill.sh" \
    "$DEPLOY_DIR/scripts/restore-offsite-check.sh" \
    "$DEPLOY_DIR/scripts/run-scheduled-backup.sh" \
    "$DEPLOY_DIR/systemd/eliza-hub-backup.service.example" \
    "$DEPLOY_DIR/systemd/eliza-hub-backup.timer.example" \
    "$DEPLOY_DIR/release/production-evidence.example.json" \
    "$DEPLOY_DIR/runner/config.example.yml" \
    "$REPO_ROOT/scripts/private-reference-scan.sh" \
    "$REPO_ROOT/services/merge-steward/package.json"; do
    [[ -f "$file" ]] || {
      printf 'missing required release file: %s\n' "$file" >&2
      return 1
    }
  done
}

main() {
  require_command git
  require_command docker
  require_command grep
  eliza_prepare_artifact_dirs

  log "using env file: $ENV_FILE"
  log "using repo: $REPO_ROOT"
  log "using artifact root: $ELIZA_ARTIFACT_ROOT"
  log "using tmp root: $ELIZA_TMP_ROOT"
  log "RELEASE_GATE_MODE=$RELEASE_GATE_MODE VALIDATE_RUNNER=$VALIDATE_RUNNER VALIDATE_PRODUCTION_GATE=$VALIDATE_PRODUCTION_GATE VALIDATE_PRODUCTION_INVENTORY=$VALIDATE_PRODUCTION_INVENTORY RUN_TESTS=$RUN_TESTS"

  run_check "required files exist" check_required_files
  run_check "git worktree is clean" check_git_clean
  run_check "shell scripts parse" check_shell_syntax
  run_check "shell scripts pass ShellCheck" check_shell_lint
  run_check "deployment node scripts parse" check_node_syntax
  run_check "Hetzner and Cloudflare infrastructure validates" check_infrastructure_config
  run_check "private reference scan passes" check_private_references
  run_check "private env validates" check_private_env
  run_check "base compose renders" check_compose_base
  run_check "steward OIDC env renders" check_compose_steward_oidc_env
  run_check "runner compose renders" check_compose_runner
  run_check "runner isolation invariants hold" check_runner_isolation
  run_check "production evidence gate passes when enabled" check_production_gate
  run_check "Merge Steward check/test/audit pass" check_node_suite

  rm -f "$RELEASE_GATE_STDOUT" "$RELEASE_GATE_STDERR"

  if ((FAILED > 0)); then
    fail_now "$FAILED release gate check(s) failed"
  fi

  log "release gate passed"
}

main "$@"
