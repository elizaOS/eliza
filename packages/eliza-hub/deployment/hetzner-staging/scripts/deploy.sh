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
DEPLOY_MODE="${DEPLOY_MODE:-}"
DEPLOY_DRY_RUN="${DEPLOY_DRY_RUN:-true}"
DEPLOY_PULL_IMAGES="${DEPLOY_PULL_IMAGES:-false}"
DEPLOY_RUNNER="${DEPLOY_RUNNER:-false}"
DEPLOY_RUN_POST_CHECK="${DEPLOY_RUN_POST_CHECK:-true}"
DEPLOY_VALIDATE_ENV="${DEPLOY_VALIDATE_ENV:-true}"
DEPLOY_VERIFY_IMAGES="${DEPLOY_VERIFY_IMAGES:-true}"
DEPLOY_EVIDENCE_OUTPUT="${DEPLOY_EVIDENCE_OUTPUT:-$(eliza_artifact_path eliza-hub-deploy-evidence.json)}"
DEPLOY_MIGRATE_LOG="${DEPLOY_MIGRATE_LOG:-$(eliza_artifact_path merge-steward-migrate.log)}"
DEPLOY_POST_DEPLOY_EVIDENCE_OUTPUT="${DEPLOY_POST_DEPLOY_EVIDENCE_OUTPUT:-$(eliza_artifact_path eliza-hub-post-deploy-evidence.json)}"
DEPLOY_STEP_LOG="${DEPLOY_STEP_LOG:-$(eliza_tmp_path eliza-hub-deploy-steps.tsv)}"
DEPLOY_STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

log() {
  printf '[deploy] %s\n' "$*"
}

fail_now() {
  printf '[deploy] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: deploy.sh --mode first-boot|rolling [--apply] [--runner] [--pull]

Runs the Eliza Hub staging deploy sequence.

Defaults are intentionally safe:
  DEPLOY_DRY_RUN=true       Print and record planned commands without changing services.
  DEPLOY_VALIDATE_ENV=true  Run validate-env.sh before planning service changes.
  DEPLOY_RUN_POST_CHECK=true

Environment:
  ENV_FILE                  Private deployment env file.
  COMPOSE_FILE              Base compose file.
  RUNNER_COMPOSE_FILE       Actions runner compose overlay.
  DEPLOY_EVIDENCE_OUTPUT    JSON plan/execution evidence output.
  DEPLOY_MIGRATE_LOG        merge-steward-migrate output path for live runs.
  DEPLOY_POST_DEPLOY_EVIDENCE_OUTPUT
                            post-deploy verification evidence output path.

Examples:
  DEPLOY_MODE=first-boot deployment/hetzner-staging/scripts/deploy.sh
  deployment/hetzner-staging/scripts/deploy.sh --mode rolling --apply --pull
USAGE
}

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      -h|--help)
        usage
        exit 0
        ;;
      --mode)
        shift
        [[ $# -gt 0 ]] || fail_now "--mode requires first-boot or rolling"
        DEPLOY_MODE="$1"
        ;;
      --mode=*)
        DEPLOY_MODE="${1#--mode=}"
        ;;
      --first-boot)
        DEPLOY_MODE="first-boot"
        ;;
      --rolling)
        DEPLOY_MODE="rolling"
        ;;
      --apply)
        DEPLOY_DRY_RUN=false
        ;;
      --dry-run)
        DEPLOY_DRY_RUN=true
        ;;
      --pull)
        DEPLOY_PULL_IMAGES=true
        ;;
      --no-pull)
        DEPLOY_PULL_IMAGES=false
        ;;
      --runner)
        DEPLOY_RUNNER=true
        ;;
      --no-runner)
        DEPLOY_RUNNER=false
        ;;
      --post-check)
        DEPLOY_RUN_POST_CHECK=true
        ;;
      --no-post-check)
        DEPLOY_RUN_POST_CHECK=false
        ;;
      *)
        fail_now "unknown argument: $1"
        ;;
    esac
    shift
  done
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail_now "missing required command: $1"
}

shell_join() {
  local joined=""
  local quoted
  local arg

  for arg in "$@"; do
    printf -v quoted '%q' "$arg"
    joined="${joined}${joined:+ }$quoted"
  done

  printf '%s' "$joined"
}

record_step() {
  local phase="$1"
  local name="$2"
  shift 2

  printf '%s\t%s\t%s\n' "$phase" "$name" "$(shell_join "$@")" >>"$DEPLOY_STEP_LOG"
}

record_shell_step() {
  local phase="$1"
  local name="$2"
  local command="$3"

  printf '%s\t%s\t%s\n' "$phase" "$name" "$command" >>"$DEPLOY_STEP_LOG"
}

run_step() {
  local phase="$1"
  local name="$2"
  shift 2

  record_step "$phase" "$name" "$@"
  if is_true "$DEPLOY_DRY_RUN"; then
    log "dry-run: $(shell_join "$@")"
    return 0
  fi

  "$@"
}

base_compose_cmd() {
  # shellcheck disable=SC2178
  local -n output=$1
  shift

  output=(docker compose)
  if [[ -f "$ENV_FILE" ]]; then
    output+=(--env-file "$ENV_FILE")
  fi
  output+=(-f "$COMPOSE_FILE" --profile steward "$@")
}

runner_compose_cmd() {
  # shellcheck disable=SC2178
  local -n output=$1
  shift

  output=(docker compose)
  if [[ -f "$ENV_FILE" ]]; then
    output+=(--env-file "$ENV_FILE")
  fi
  output+=(-f "$COMPOSE_FILE" -f "$RUNNER_COMPOSE_FILE" --profile steward --profile actions-runner "$@")
}

run_base_compose() {
  local phase="$1"
  local name="$2"
  shift 2
  local cmd

  base_compose_cmd cmd "$@"
  run_step "$phase" "$name" "${cmd[@]}"
}

run_runner_compose() {
  local phase="$1"
  local name="$2"
  shift 2
  local cmd

  runner_compose_cmd cmd "$@"
  run_step "$phase" "$name" "${cmd[@]}"
}

run_migration() {
  local phase="$1"
  shift
  local cmd
  local command_text

  base_compose_cmd cmd "$@"
  command_text="$(shell_join "${cmd[@]}") > $(shell_join "$DEPLOY_MIGRATE_LOG") 2>&1"
  record_shell_step "$phase" "run merge steward migrations" "$command_text"

  if is_true "$DEPLOY_DRY_RUN"; then
    log "dry-run: $command_text"
    return 0
  fi

  mkdir -p "$(dirname "$DEPLOY_MIGRATE_LOG")"
  "${cmd[@]}" >"$DEPLOY_MIGRATE_LOG" 2>&1
}

validate_mode() {
  case "$DEPLOY_MODE" in
    first-boot|rolling) ;;
    "")
      fail_now "DEPLOY_MODE is required; use --mode first-boot or --mode rolling"
      ;;
    *)
      fail_now "DEPLOY_MODE must be first-boot or rolling"
      ;;
  esac
}

validate_environment() {
  safe_load_env_file "$ENV_FILE" "${ALLOW_ENV_ONLY:-false}" "deploy"

  if is_true "$DEPLOY_VALIDATE_ENV"; then
    run_step "preflight" "validate private env" \
      env ENV_FILE="$ENV_FILE" VALIDATE_STEWARD=true VALIDATE_RUNNER="$DEPLOY_RUNNER" "$SCRIPT_DIR/validate-env.sh"
  fi
}

verify_image() {
  local label="$1"
  local image="$2"

  [[ -n "$image" ]] || fail_now "missing image for $label"
  run_step "preflight" "verify $label image exists" docker image inspect "$image"
}

verify_images() {
  if ! is_true "$DEPLOY_VERIFY_IMAGES"; then
    return 0
  fi

  verify_image "Forgejo" "${FORGEJO_IMAGE:-}"
  verify_image "Merge Steward" "${MERGE_STEWARD_IMAGE:-}"
  if is_true "$DEPLOY_RUNNER"; then
    verify_image "Forgejo runner" "${FORGEJO_RUNNER_IMAGE:-}"
    verify_image "Actions DIND" "${FORGEJO_RUNNER_DIND_IMAGE:-docker:28-dind}"
  fi
}

run_common_preflight() {
  validate_environment

  if ! is_true "$DEPLOY_DRY_RUN"; then
    require_command docker
  fi

  if is_true "$DEPLOY_PULL_IMAGES"; then
    run_base_compose "preflight" "pull approved images" pull
    if is_true "$DEPLOY_RUNNER"; then
      run_runner_compose "preflight" "pull runner images" pull
    fi
  fi

  verify_images
}

run_first_boot() {
  run_base_compose "first-boot" "start persistent dependencies" up -d --wait postgres forgejo
  run_base_compose "first-boot" "show dependency health" ps postgres forgejo
  run_migration "first-boot" up merge-steward-migrate
  run_base_compose "first-boot" "start merge steward" up -d merge-steward
}

run_rolling() {
  run_base_compose "rolling" "verify dependency health" ps postgres forgejo
  run_migration "rolling" up --no-deps merge-steward-migrate
  run_base_compose "rolling" "restart application services" up -d --wait forgejo merge-steward
}

run_runner_if_requested() {
  if ! is_true "$DEPLOY_RUNNER"; then
    return 0
  fi

  run_runner_compose "runner" "start isolated runner stack" up -d --wait actions-dind actions-runner
}

run_post_deploy_check() {
  if ! is_true "$DEPLOY_RUN_POST_CHECK"; then
    return 0
  fi

  run_step "post-deploy" "run post deploy checks" \
    env ENV_FILE="$ENV_FILE" \
      COMPOSE_FILE="$COMPOSE_FILE" \
      POST_DEPLOY_EVIDENCE_OUTPUT="$DEPLOY_POST_DEPLOY_EVIDENCE_OUTPUT" \
      "$SCRIPT_DIR/post-deploy-check.sh"
}

write_evidence() {
  local status="$1"

  mkdir -p "$(dirname "$DEPLOY_EVIDENCE_OUTPUT")"
  DEPLOY_STATUS="$status" \
  DEPLOY_FINISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
  DEPLOY_STARTED_AT="$DEPLOY_STARTED_AT" \
  DEPLOY_MODE="$DEPLOY_MODE" \
  DEPLOY_DRY_RUN="$DEPLOY_DRY_RUN" \
  DEPLOY_PULL_IMAGES="$DEPLOY_PULL_IMAGES" \
  DEPLOY_RUNNER="$DEPLOY_RUNNER" \
  DEPLOY_RUN_POST_CHECK="$DEPLOY_RUN_POST_CHECK" \
  DEPLOY_VALIDATE_ENV="$DEPLOY_VALIDATE_ENV" \
  DEPLOY_VERIFY_IMAGES="$DEPLOY_VERIFY_IMAGES" \
  DEPLOY_EVIDENCE_OUTPUT="$DEPLOY_EVIDENCE_OUTPUT" \
  DEPLOY_MIGRATE_LOG="$DEPLOY_MIGRATE_LOG" \
  DEPLOY_POST_DEPLOY_EVIDENCE_OUTPUT="$DEPLOY_POST_DEPLOY_EVIDENCE_OUTPUT" \
  DEPLOY_STEP_LOG="$DEPLOY_STEP_LOG" \
  ENV_FILE="$ENV_FILE" \
  COMPOSE_FILE="$COMPOSE_FILE" \
  RUNNER_COMPOSE_FILE="$RUNNER_COMPOSE_FILE" \
  node <<'NODE'
const fs = require("node:fs");

const stepLog = process.env.DEPLOY_STEP_LOG;
const lines = fs.existsSync(stepLog) ? fs.readFileSync(stepLog, "utf8").trim().split("\n").filter(Boolean) : [];
const steps = lines.map((line, index) => {
  const [phase = "", name = "", ...rest] = line.split("\t");
  return {
    index: index + 1,
    phase,
    name,
    command: rest.join("\t"),
  };
});

const evidence = {
  schema: "https://eliza.hub/schemas/deploy-evidence.v1",
  status: process.env.DEPLOY_STATUS,
  mode: process.env.DEPLOY_MODE,
  dryRun: process.env.DEPLOY_DRY_RUN === "true",
  startedAt: process.env.DEPLOY_STARTED_AT,
  finishedAt: process.env.DEPLOY_FINISHED_AT,
  options: {
    pullImages: process.env.DEPLOY_PULL_IMAGES === "true",
    runner: process.env.DEPLOY_RUNNER === "true",
    postDeployCheck: process.env.DEPLOY_RUN_POST_CHECK === "true",
    validateEnv: process.env.DEPLOY_VALIDATE_ENV === "true",
    verifyImages: process.env.DEPLOY_VERIFY_IMAGES === "true",
  },
  files: {
    envFile: process.env.ENV_FILE,
    composeFile: process.env.COMPOSE_FILE,
    runnerComposeFile: process.env.RUNNER_COMPOSE_FILE,
    migrationLog: process.env.DEPLOY_MIGRATE_LOG,
    postDeployEvidence: process.env.DEPLOY_POST_DEPLOY_EVIDENCE_OUTPUT,
  },
  steps,
};

fs.writeFileSync(process.env.DEPLOY_EVIDENCE_OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
NODE
  log "wrote deploy evidence: $DEPLOY_EVIDENCE_OUTPUT"
}

main() {
  parse_args "$@"
  validate_mode
  eliza_prepare_artifact_dirs
  : >"$DEPLOY_STEP_LOG"

  log "mode: $DEPLOY_MODE"
  log "dry run: $DEPLOY_DRY_RUN"
  log "using env file: $ENV_FILE"
  log "using compose file: $COMPOSE_FILE"
  log "using artifact root: $ELIZA_ARTIFACT_ROOT"

  run_common_preflight

  case "$DEPLOY_MODE" in
    first-boot) run_first_boot ;;
    rolling) run_rolling ;;
  esac

  run_runner_if_requested
  run_post_deploy_check
  write_evidence "passed"

  if is_true "$DEPLOY_DRY_RUN"; then
    log "dry-run complete; rerun with --apply or DEPLOY_DRY_RUN=false to execute"
  else
    log "deploy completed"
  fi
}

main "$@"
