#!/usr/bin/env bash
set -Eeuo pipefail

# Smoke-test the production Docker build path used by .github/workflows/build-docker.yml.
#
# What this does:
#   1. Installs deps with bun using the committed lockfile
#   2. Builds required runtime/UI artifacts for Dockerfile.ci
#   3. Builds the production image locally
#   4. Boots the container running the REAL agent entrypoint and probes
#      /api/health or /api/status, failing if the agent crashes on startup
#
# The boot probe runs the image's default command (APP_CMD_START =
# the absolute tsx loader plus `packages/agent/dist/bin.js start`), i.e. the
# actual production entrypoint. It does NOT substitute a stub health server, so a
# broken runtime dependency closure (missing zod / @elizaos/core / chalk /
# etc.) surfaces as a RED build instead of shipping a container that crashes
# the moment it boots in production.
#
# Usage:
#   bash packages/app-core/scripts/docker-ci-smoke.sh [--tag TAG] [--version VERSION] [--skip-smoke]
#   # Verify an already-built/pulled image without rebuilding:
#   DOCKER_IMAGE=ghcr.io/... bash packages/app-core/scripts/docker-ci-smoke.sh --boot-verify-only
#
# Environment:
#   BUN_VERSION          Bun version to install/use in CI (default: 1.3.9)
#   SMOKE_PORT           Host port to bind for smoke boot (default: 32138)
#   SMOKE_TIMEOUT_SEC    Max wait for boot probe (default: 420)
#   DOCKER_IMAGE         Override image tag completely
#   BOOT_VERIFY_ONLY     If "true", skip the build and only boot-verify
#                        DOCKER_IMAGE (must be set). Equivalent to
#                        --boot-verify-only.
#   SMOKE_CHARACTER_JSON Optional minimal character JSON injected via
#                        ELIZA_AGENT_CHARACTER_JSON for the boot.
#   BOOT_KPI_ENFORCE     If "1", a cold-start readyMs budget breach (measured
#                        boot readyMs > boot.coldReadyMs from
#                        packages/benchmarks/loadperf/budgets.json) FAILS the
#                        smoke. Default (unset/!=1) is WARN-FIRST: a breach is
#                        reported via a ::warning:: line but does NOT fail. Flip
#                        this to "1" in the workflow once the baseline is
#                        confirmed green in CI. The KPI measurement is additive
#                        and only runs in --boot-verify-only mode; a measurement
#                        failure (missing jq/budget) never fails a smoke that
#                        otherwise passed.

BUN_VERSION="${BUN_VERSION:-1.3.10}"
SMOKE_PORT="${SMOKE_PORT:-32138}"
CONTAINER_PORT="${CONTAINER_PORT:-42138}"
SMOKE_TIMEOUT_SEC="${SMOKE_TIMEOUT_SEC:-420}"
SKIP_SMOKE=false
BOOT_VERIFY_ONLY="${BOOT_VERIFY_ONLY:-false}"
TAG="docker-smoke"
VERSION=""

# Log signatures that mean the agent crashed during startup. If any of these
# show up in the container logs we fail immediately rather than waiting out the
# full timeout. These are the exact failure modes (missing runtime deps,
# entrypoint blowups) that previously shipped green because the smoke step
# booted a stub health server instead of the real entrypoint.
#
# Kept deliberately specific to module-resolution failures and explicit
# fatal-startup markers so a benign warning that merely contains a generic word
# (FATAL, Cannot read properties of undefined, ...) does not flap the gate. The
# container-exit and health-timeout checks below are the backstops for any crash
# that does not print one of these.
BOOT_CRASH_PATTERNS=(
  'Cannot find package'
  'Cannot find module'
  'ERR_MODULE_NOT_FOUND'
  'ERR_REQUIRE_ESM'
  'MODULE_NOT_FOUND'
  # Defense-in-depth: the agent boots under the tsx loader (see APP_CMD_START),
  # so .ts extensions resolve at runtime today. But if a workspace package ever
  # shipped without a built dist, link-docker-local-app-packages.mjs rewrites its
  # exports to ./src/*.ts, and importing that under a tsx-less or mislinked boot
  # would throw ERR_UNKNOWN_FILE_EXTENSION on the core boot path. Fail fast on that
  # signature instead of waiting out the full health timeout.
  'ERR_UNKNOWN_FILE_EXTENSION'
  'Unknown file extension'
  # The real entrypoint fatal: bin.ts's top-level catch prints exactly this and
  # exits 1 (packages/agent/src/bin.ts). Anchored to that prefix on purpose — a
  # bare 'Failed to start' substring also matches benign, by-design-non-fatal
  # WARNs such as "Service lifeops_scheduled_task_runner not found or failed to
  # start" (scheduling boot-seed, which logs "tasks can still be scheduled at
  # runtime"), which false-flapped this gate.
  '[eliza-autonomous] Failed to start'
  'crashed during init'
)

log() {
  printf '[docker-ci-smoke] %s\n' "$*"
}

# Portable millisecond epoch timer used by the boot-KPI cold-start measurement.
# Prefers bash 5's EPOCHREALTIME (no subprocess), falls back to GNU date
# (%s%3N), then python3, then whole-second `date` * 1000. Always prints an
# integer count of milliseconds. Never used for liveness decisions, only for
# the additive boot-KPI readyMs value, so a coarse fallback is harmless.
now_ms() {
  if [[ -n "${EPOCHREALTIME:-}" ]]; then
    # EPOCHREALTIME is "<seconds>.<microseconds>"; strip the dot and trim to ms.
    local er="${EPOCHREALTIME/[.,]/}"
    printf '%s\n' "${er:0:${#er}-3}"
    return 0
  fi
  local d
  d="$(date +%s%3N 2>/dev/null || true)"
  if [[ "$d" =~ ^[0-9]+$ && "$d" != *N ]]; then
    printf '%s\n' "$d"
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import time; print(int(time.time()*1000))'
    return 0
  fi
  printf '%s\n' "$(( $(date +%s) * 1000 ))"
}

on_error() {
  local status=$?
  local line="${BASH_LINENO[0]:-0}"
  local command="${BASH_COMMAND:-unknown}"
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    printf '::error file=packages/app-core/scripts/docker-ci-smoke.sh,line=%s::docker-ci-smoke command failed with exit code %s: %s\n' "$line" "$status" "$command" >&2
  fi
}

trap on_error ERR

fail() {
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    printf '::error::docker-ci-smoke: %s\n' "$*" >&2
  fi
  printf '[docker-ci-smoke] ERROR: %s\n' "$*" >&2
  exit 1
}

find_docker_bin() {
  local candidate
  for candidate in "${DOCKER_BIN:-}" "$(command -v docker 2>/dev/null || true)" \
    /usr/local/bin/docker /opt/homebrew/bin/docker \
    /Applications/Docker.app/Contents/Resources/bin/docker; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

load_env_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      TAG="$2"
      shift 2
      ;;
    --version)
      VERSION="$2"
      shift 2
      ;;
    --skip-smoke)
      SKIP_SMOKE=true
      shift
      ;;
    --boot-verify-only)
      BOOT_VERIFY_ONLY=true
      shift
      ;;
    -h|--help)
      sed -n '1,24p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

[[ -f package.json ]] || fail "Run from the repo root"
if [[ -d packages/app-core ]]; then
  # Inside the eliza repo (canonical layout): app-core at packages/,
  # the app entry point at packages/app/.
  APP_CORE_DIR="packages/app-core"
  PACKAGES_DIR="packages"
  APP_DIR="packages/app"
  PLUGINS_DIR="plugins"
elif [[ -d eliza/packages/app-core ]]; then
  # Inside the eliza outer repo where eliza is a submodule: app-core
  # is nested under eliza/, while the host app can live in apps/app.
  APP_CORE_DIR="eliza/packages/app-core"
  PACKAGES_DIR="eliza/packages"
  if [[ -d apps/app ]]; then
    APP_DIR="apps/app"
  else
    APP_DIR="eliza/packages/app"
  fi
  PLUGINS_DIR="eliza/plugins"
else
  fail "packages/app-core not found"
fi
APP_CORE_SCRIPTS_DIR="$APP_CORE_DIR/scripts"
AGENT_DIR="$PACKAGES_DIR/agent"
RM_PATH_RECURSIVE=(node "$PACKAGES_DIR/scripts/rm-path-recursive.mjs")
# @elizaos/core source lives under packages/core (current) or packages/typescript
# (legacy). Prefer the current name; fall back to the legacy path so older branches
# still work.
if [[ -f "$PACKAGES_DIR/core/package.json" ]]; then
  TYPESCRIPT_DIR="$PACKAGES_DIR/core"
else
  TYPESCRIPT_DIR="$PACKAGES_DIR/typescript"
fi

[[ -f "$APP_CORE_DIR/deploy/Dockerfile.ci" ]] || fail "$APP_CORE_DIR/deploy/Dockerfile.ci not found"
[[ -f "$APP_CORE_DIR/deploy/.dockerignore.ci" ]] || fail "$APP_CORE_DIR/deploy/.dockerignore.ci not found"
[[ -d "$APP_DIR" ]] || fail "$APP_DIR not found"

load_env_file "$APP_CORE_DIR/deploy/deploy.defaults.env"
load_env_file "deploy/deploy.env"

APP_IMAGE="${APP_IMAGE:-eliza/agent}"
APP_ENTRYPOINT="${APP_ENTRYPOINT:-$AGENT_DIR/dist/bin.js}"
APP_CMD_START="${APP_CMD_START:-node --import /opt/tsx/node_modules/tsx/dist/loader.mjs ${APP_ENTRYPOINT} start}"
APP_PORT="${APP_PORT:-2138}"
APP_API_BIND="${APP_API_BIND:-127.0.0.1}"
OCI_SOURCE="${OCI_SOURCE:-}"
OCI_TITLE="${OCI_TITLE:-elizaOS Agent}"
OCI_DESCRIPTION="${OCI_DESCRIPTION:-elizaOS agent runtime}"
OCI_LICENSES="${OCI_LICENSES:-MIT}"

if [[ -z "$VERSION" ]]; then
  VERSION="v$(node -p "require('./package.json').version")-docker-smoke"
fi
VERSION_CLEAN="${VERSION#v}"
SOURCE_SHA="$(git rev-parse HEAD)"
DOCKER_IMAGE="${DOCKER_IMAGE:-${APP_IMAGE}:${TAG}}"
CONTAINER_NAME="eliza-docker-smoke-${TAG//[^a-zA-Z0-9_.-]/-}"
mkdir -p "$REPO_ROOT/.tmp/qa"
SMOKE_ARTIFACT_DIR="$(mktemp -d "$REPO_ROOT/.tmp/qa/docker-ci-smoke-XXXXXX")"

log "Repo root: $REPO_ROOT"
log "Version: $VERSION"
log "Image: $DOCKER_IMAGE"
log "Smoke port: $SMOKE_PORT"
log "Container port override: $CONTAINER_PORT"
log "Artifact dir: $SMOKE_ARTIFACT_DIR"

# bun/node are only needed for the build path. In boot-verify-only mode we
# just run an already-built image, so don't hard-require them.
if [[ "$BOOT_VERIFY_ONLY" != "true" ]]; then
  command -v node >/dev/null 2>&1 || fail "node is required"
  command -v bun >/dev/null 2>&1 || fail "bun is required"
  BUN_BIN="$(command -v bun)"
fi

DOCKER_BIN="$(find_docker_bin)" || fail "docker is required"

"$DOCKER_BIN" info >/dev/null 2>&1 || fail "docker daemon is not available"

DOCKERIGNORE_BACKUP="$(mktemp)"
HAD_ROOT_DOCKERIGNORE=0
if [[ -f .dockerignore ]]; then
  HAD_ROOT_DOCKERIGNORE=1
  cp .dockerignore "$DOCKERIGNORE_BACKUP"
else
  : >"$DOCKERIGNORE_BACKUP"
fi
cleanup() {
  set +e
  local containers_file
  containers_file="$(mktemp 2>/dev/null || printf '%s\n' "$SMOKE_ARTIFACT_DIR/docker-containers.txt")"
  timeout 10 "$DOCKER_BIN" ps -a --format '{{.Names}}' >"$containers_file" 2>&1 || true
  if grep -Fxq "$CONTAINER_NAME" "$containers_file" 2>/dev/null; then
    timeout 15 "$DOCKER_BIN" inspect "$CONTAINER_NAME" >"$SMOKE_ARTIFACT_DIR/container-inspect.json" 2>&1 || true
    timeout 30 "$DOCKER_BIN" logs "$CONTAINER_NAME" >"$SMOKE_ARTIFACT_DIR/container.log" 2>&1 || true
    timeout 10 "$DOCKER_BIN" rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
  rm -f "$containers_file" >/dev/null 2>&1 || true
  if [[ -f "$DOCKERIGNORE_BACKUP" ]]; then
    if [[ "$HAD_ROOT_DOCKERIGNORE" == "1" ]]; then
      cp "$DOCKERIGNORE_BACKUP" .dockerignore >/dev/null 2>&1 || true
    else
      rm -f .dockerignore >/dev/null 2>&1 || true
    fi
    rm -f "$DOCKERIGNORE_BACKUP" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# boot_verify boots the just-built (or pre-supplied) image running the REAL
# agent entrypoint and fails the script if the agent crashes on startup or
# never serves health. This is the gate that stops a container that crashes on
# boot (missing runtime deps, broken entrypoint) from shipping green.
boot_verify() {
  log "Starting container boot verification (real agent entrypoint)"
  log "Command under test: ${APP_CMD_START}"

  # A tiny, valid character so the agent has a concrete identity to boot with.
  # The runtime falls back to a bundled default if this is unset, but pinning
  # one keeps the boot deterministic across branches.
  local character_json
  character_json="${SMOKE_CHARACTER_JSON:-{\"name\":\"CiSmoke\",\"bio\":[\"CI boot verification agent.\"],\"system\":\"You are a CI boot probe.\"}}"

  # Unique pglite data dir per run avoids the data-dir lock that makes a
  # second container on the same host fail to acquire the store.
  local pglite_dir="/tmp/ci-db-${RANDOM}-${RANDOM}"

  "$DOCKER_BIN" rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  # Boot-KPI cold-start: stamp the instant just before the container starts.
  # The elapsed time from here to the FIRST /api/health (or /api/status) ready
  # is the cold readyMs we compare against boot.coldReadyMs. Only meaningful in
  # --boot-verify-only mode (the workflow's gate); see emit_boot_kpi below.
  BOOT_KPI_START_MS=""
  BOOT_KPI_READY_MS=""
  if [[ "$BOOT_VERIFY_ONLY" == "true" ]]; then
    BOOT_KPI_START_MS="$(now_ms 2>/dev/null || true)"
  fi
  # NOTE: no command override here. The container runs its default CMD
  # (APP_CMD_START = the real absolute tsx loader plus agent dist start).
  # Substituting a stub health server is exactly what let broken
  # images ship green before; do not reintroduce it.
  "$DOCKER_BIN" run -d \
    --name "$CONTAINER_NAME" \
    -e PORT="$CONTAINER_PORT" \
    -e APP_PORT="$CONTAINER_PORT" \
    -e ELIZA_PORT="$CONTAINER_PORT" \
    -e ELIZA_API_PORT="$CONTAINER_PORT" \
    -e ELIZA_AGENT_PORT="$CONTAINER_PORT" \
    -e APP_API_BIND=0.0.0.0 \
    -e ELIZA_API_BIND=0.0.0.0 \
    -e AGENT_API_BIND=0.0.0.0 \
    -e ELIZA_AGENT_CHARACTER_JSON="$character_json" \
    -e ELIZA_STATE_DIR=/tmp/eliza-smoke/state \
    -e ELIZA_CONFIG_DIR=/tmp/eliza-smoke/config \
    -e ELIZA_WORKSPACE_DIR=/tmp/eliza-smoke/workspace \
    -e ELIZA_VAULT_PASSPHRASE=docker-smoke-vault-passphrase \
    -e PGLITE_DATA_DIR="$pglite_dir" \
    -e ELIZA_DISABLE_LOCAL_EMBEDDINGS=1 \
    -p "${SMOKE_PORT}:${CONTAINER_PORT}" \
    "$DOCKER_IMAGE" >/dev/null

  local status_url="http://127.0.0.1:${SMOKE_PORT}/api/status"
  local health_url="http://127.0.0.1:${SMOKE_PORT}/api/health"

  # Boot-KPI: record the FIRST instant any probe reports ready. Called from the
  # 200/401 success paths below so the readyMs reflects the very first health
  # success, not the end of confirm_ok's confirmation re-probes. Stamps once and
  # only in --boot-verify-only mode; never affects the liveness return value.
  mark_first_ready() {
    if [[ "$BOOT_VERIFY_ONLY" == "true" && -z "${BOOT_KPI_READY_MS:-}" ]]; then
      BOOT_KPI_READY_MS="$(now_ms 2>/dev/null || true)"
    fi
  }

  probe_ok() {
    local url="$1"
    local out="$2"
    local code
    code="$(curl -sS --connect-timeout 1 --max-time 3 -o "$out" -w '%{http_code}' "$url" || true)"
    case "$code" in
      200)
        mark_first_ready
        return 0
        ;;
      401)
        if grep -q 'Unauthorized' "$out" 2>/dev/null; then
          mark_first_ready
          return 0
        fi
        ;;
    esac
    return 1
  }

  # Scan container logs for known crash signatures. Returns 0 (match) when the
  # agent has crashed on startup so we can fail fast with a clear message
  # instead of waiting out the whole timeout.
  scan_crash() {
    local logs_file="$1"
    local pattern
    for pattern in "${BOOT_CRASH_PATTERNS[@]}"; do
      if grep -qiF "$pattern" "$logs_file" 2>/dev/null; then
        printf '%s' "$pattern"
        return 0
      fi
    done
    return 1
  }

  # Confirm health by probing a few times in a row before declaring success,
  # so a single transient curl failure does not flap the gate.
  confirm_ok() {
    local url="$1"
    local out="$2"
    local i
    for i in 1 2 3; do
      probe_ok "$url" "$out" || return 1
      [[ "$i" -lt 3 ]] && sleep 1
    done
    return 0
  }

  # Post-health observation window: after health first comes up, keep watching
  # the container for a short window so a crash that happens just AFTER the
  # server binds (async plugin/runtime init blowing up post-listen) still turns
  # the gate RED instead of slipping through. Only scans logs emitted AFTER the
  # passed-in checkpoint ("$1", an RFC3339 UTC timestamp captured when health
  # first succeeded) so a benign pre-health crash signature can't false-positive.
  # Returns non-zero if the container dies or logs a crash signature in-window.
  confirm_stable() {
    local since="$1"
    local window="${BOOT_STABLE_WINDOW_SEC:-15}"
    local stable_logs="$SMOKE_ARTIFACT_DIR/post-health.log"
    local stable_deadline=$((SECONDS + window))
    while (( SECONDS < stable_deadline )); do
      timeout 30 "$DOCKER_BIN" logs --since "$since" "$CONTAINER_NAME" >"$stable_logs" 2>&1 || true
      local m
      if m="$(scan_crash "$stable_logs")"; then
        log "Crash signature appeared after health came up: '${m}'"
        timeout 30 "$DOCKER_BIN" logs --tail 120 "$CONTAINER_NAME" || true
        return 1
      fi
      if ! timeout 10 "$DOCKER_BIN" ps --format '{{.Names}}' 2>/dev/null | grep -Fxq "$CONTAINER_NAME"; then
        local code
        code="$(timeout 10 "$DOCKER_BIN" inspect -f '{{.State.ExitCode}}' "$CONTAINER_NAME" 2>/dev/null || echo '?')"
        log "Container exited (exit code ${code}) during the post-health window"
        timeout 30 "$DOCKER_BIN" logs --tail 120 "$CONTAINER_NAME" || true
        return 1
      fi
      sleep 3
    done
    return 0
  }

  # Boot-KPI cold-start budget (item 5 of #8812). Computes cold readyMs from the
  # pre-`docker run` checkpoint to the FIRST health/status success, reads the
  # boot.coldReadyMs budget from packages/benchmarks/loadperf/budgets.json, and
  # reports the comparison. WARN-FIRST: a breach prints a ::warning:: line and
  # returns 0 (does not fail) UNLESS BOOT_KPI_ENFORCE=1, in which case it returns
  # 1 so the caller can fail the smoke. Every measurement step is guarded so a
  # missing jq / budget / timer NEVER turns a liveness-passing boot RED.
  # peakRss is intentionally NOT measured: `docker stats` reports an inst
  # sample, not the boot peak, so a number here would be misleading.
  emit_boot_kpi() {
    if [[ "$BOOT_VERIFY_ONLY" != "true" ]]; then
      return 0
    fi
    if [[ -z "${BOOT_KPI_START_MS:-}" || -z "${BOOT_KPI_READY_MS:-}" ]]; then
      log "[boot-kpi] cold readyMs: not measured (missing start/ready timestamp)"
      return 0
    fi

    local ready_ms
    ready_ms=$(( BOOT_KPI_READY_MS - BOOT_KPI_START_MS ))
    if (( ready_ms < 0 )); then
      log "[boot-kpi] cold readyMs: not measured (non-monotonic clock)"
      return 0
    fi

    # Default budget mirrors packages/benchmarks/loadperf/budgets.json boot.coldReadyMs.
    local budget_default=25000
    local budget="$budget_default"
    local budgets_file="$REPO_ROOT/packages/benchmarks/loadperf/budgets.json"
    if command -v jq >/dev/null 2>&1 && [[ -f "$budgets_file" ]]; then
      local parsed
      parsed="$(jq -r '.boot.coldReadyMs // empty' "$budgets_file" 2>/dev/null || true)"
      if [[ "$parsed" =~ ^[0-9]+$ ]]; then
        budget="$parsed"
      else
        log "[boot-kpi] WARNING: could not read boot.coldReadyMs from $budgets_file; using default ${budget_default}ms"
      fi
    else
      log "[boot-kpi] WARNING: jq or budgets.json unavailable; using default coldReadyMs budget ${budget_default}ms"
    fi

    # Record runner contention alongside readyMs (#8812 item 5). Boot is
    # single-threaded and import-bound, so a heavily loaded runner inflates
    # readyMs; we log loadavg/cpu so a breach can be triaged, and (below) refuse
    # to FAIL on a breach when the runner is clearly overloaded, so enforcement
    # only catches a genuine boot-time regression — not transient runner load.
    local load1="" cpus="" contended="false"
    if [[ -r /proc/loadavg ]]; then
      load1="$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || true)"
    fi
    cpus="$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)"
    log "[boot-kpi] runner loadavg(1m)=${load1:-?} cpus=${cpus}"
    # Heavy contention = loadavg(1m) above 2x the cpu count. Float compare via
    # awk (no bc dependency); guarded so a missing loadavg never trips it.
    if [[ -n "$load1" && "$cpus" =~ ^[0-9]+$ ]]; then
      if awk -v l="$load1" -v c="$cpus" 'BEGIN{exit !(l > 2*c)}' 2>/dev/null; then
        contended="true"
      fi
    fi

    log "[boot-kpi] cold readyMs=${ready_ms} budget=${budget}"
    log "[boot-kpi] peakRss: not measured (docker stats samples instantaneously, not boot peak)"

    if (( ready_ms > budget )); then
      local msg="boot-kpi cold readyMs=${ready_ms} exceeded budget=${budget} (boot.coldReadyMs)"
      if [[ "${BOOT_KPI_ENFORCE:-}" == "1" && "$contended" == "true" ]]; then
        if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
          printf '::warning::%s — runner contended (loadavg %s over %s cpus), not failing\n' "$msg" "$load1" "$cpus" >&2
        fi
        log "[boot-kpi] WARNING (runner contended, loadavg ${load1} over ${cpus} cpus — not failing): $msg"
        return 0
      fi
      if [[ "${BOOT_KPI_ENFORCE:-}" == "1" ]]; then
        if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
          printf '::error::%s\n' "$msg" >&2
        fi
        log "[boot-kpi] ENFORCING: $msg"
        return 1
      fi
      if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
        printf '::warning::%s (warn-first; set BOOT_KPI_ENFORCE=1 to gate)\n' "$msg" >&2
      fi
      log "[boot-kpi] WARNING (warn-first, not failing): $msg"
      log "[boot-kpi] Set BOOT_KPI_ENFORCE=1 to make this breach fail CI."
      return 0
    fi

    log "[boot-kpi] within budget (readyMs ${ready_ms} <= ${budget})"
    return 0
  }

  local logs_file="$SMOKE_ARTIFACT_DIR/boot.log"
  local deadline=$((SECONDS + SMOKE_TIMEOUT_SEC))
  local last_log_dump=0
  while (( SECONDS < deadline )); do
    timeout 30 "$DOCKER_BIN" logs "$CONTAINER_NAME" >"$logs_file" 2>&1 || true

    # Fail fast on a known crash signature in the logs.
    local matched
    if matched="$(scan_crash "$logs_file")"; then
      log "Detected startup crash signature in container logs: '${matched}'"
      timeout 30 "$DOCKER_BIN" logs --tail 120 "$CONTAINER_NAME" || true
      log "Preserved failure artifacts in $SMOKE_ARTIFACT_DIR"
      fail "Agent crashed on startup (matched '${matched}'); image is NOT bootable"
    fi

    local running_containers_file
    running_containers_file="$(mktemp 2>/dev/null || printf '%s\n' "$SMOKE_ARTIFACT_DIR/docker-running-containers.txt")"
    timeout 10 "$DOCKER_BIN" ps --format '{{.Names}}' >"$running_containers_file" 2>&1 || true
    if ! grep -Fxq "$CONTAINER_NAME" "$running_containers_file" 2>/dev/null; then
      rm -f "$running_containers_file" >/dev/null 2>&1 || true
      local exit_code
      exit_code="$(timeout 10 "$DOCKER_BIN" inspect -f '{{.State.ExitCode}}' "$CONTAINER_NAME" 2>/dev/null || echo '?')"
      timeout 30 "$DOCKER_BIN" logs --tail 120 "$CONTAINER_NAME" || true
      log "Preserved failure artifacts in $SMOKE_ARTIFACT_DIR"
      fail "Container exited (exit code ${exit_code}) before health came up; image is NOT bootable"
    fi
    rm -f "$running_containers_file" >/dev/null 2>&1 || true

    if (( SECONDS - last_log_dump >= 30 )); then
      last_log_dump=$SECONDS
      log "Container still booting; recent logs follow"
      timeout 10 "$DOCKER_BIN" logs --tail 80 "$CONTAINER_NAME" || true
    fi

    if confirm_ok "$health_url" /tmp/eliza-docker-health.txt; then
      # Boot-KPI readyMs was already stamped by probe_ok (mark_first_ready) at
      # the FIRST health success, BEFORE the post-health stability window.
      log "Health probe succeeded against the real entrypoint: $health_url"
      cat /tmp/eliza-docker-health.txt
      local health_ts
      health_ts="$(date -u +%Y-%m-%dT%H:%M:%S 2>/dev/null || echo '')"
      if confirm_stable "$health_ts"; then
        log "Boot verified: agent stayed up after health came up"
        emit_boot_kpi || fail "boot-kpi cold readyMs budget exceeded (BOOT_KPI_ENFORCE=1)"
        return 0
      fi
      fail "Agent served health then crashed during the post-health window; image is NOT bootable"
    fi

    if confirm_ok "$status_url" /tmp/eliza-docker-status.txt; then
      # Boot-KPI readyMs was already stamped by probe_ok (mark_first_ready) at
      # the FIRST status success.
      log "Status probe succeeded against the real entrypoint: $status_url"
      cat /tmp/eliza-docker-status.txt
      local status_ts
      status_ts="$(date -u +%Y-%m-%dT%H:%M:%S 2>/dev/null || echo '')"
      if confirm_stable "$status_ts"; then
        log "Boot verified: agent stayed up after status came up"
        emit_boot_kpi || fail "boot-kpi cold readyMs budget exceeded (BOOT_KPI_ENFORCE=1)"
        return 0
      fi
      fail "Agent served status then crashed during the post-health window; image is NOT bootable"
    fi

    sleep 5
  done

  timeout 30 "$DOCKER_BIN" logs --tail 120 "$CONTAINER_NAME" || true
  log "Preserved timeout artifacts in $SMOKE_ARTIFACT_DIR"
  fail "Timed out waiting for the real agent to serve health (${SMOKE_TIMEOUT_SEC}s); image is NOT bootable"
}

# Boot-verify-only mode: skip the entire build and just verify a pre-built
# image (DOCKER_IMAGE must be set/pullable). Used by the build workflow to
# verify the image it just built locally before pushing.
if [[ "$BOOT_VERIFY_ONLY" == "true" ]]; then
  log "Boot-verify-only mode: skipping build, verifying $DOCKER_IMAGE"
  if ! "$DOCKER_BIN" image inspect "$DOCKER_IMAGE" >/dev/null 2>&1; then
    log "Image $DOCKER_IMAGE not present locally; attempting pull"
    "$DOCKER_BIN" pull "$DOCKER_IMAGE" >/dev/null 2>&1 || fail "Image $DOCKER_IMAGE not available locally and pull failed"
  fi
  if $SKIP_SMOKE; then
    log "Skipping runtime boot (--skip-smoke)"
    exit 0
  fi
  boot_verify
  exit 0
fi

log "Installing dependencies"
node "$APP_CORE_SCRIPTS_DIR/init-submodules.mjs"
ELIZA_SKIP_LOCAL_UPSTREAMS=1 ELIZA_SKIP_LOCAL_UPSTREAMS=1 node "$APP_CORE_SCRIPTS_DIR/disable-local-eliza-workspace.mjs"
for attempt in 1 2 3; do
  if ELIZA_SKIP_LOCAL_UPSTREAMS=1 "$BUN_BIN" install --ignore-scripts --no-frozen-lockfile; then
    break
  fi
  if [[ "$attempt" -eq 3 ]]; then
    log "bun install failed after 3 attempts"
    exit 1
  fi
  log "bun install attempt $attempt failed; retrying in 30s..."
  sleep 30
done
# --ignore-scripts avoids running the full repo postinstall during the package
# install, but build tools still need their platform binaries materialized.
node node_modules/esbuild/install.js 2>/dev/null || true
node node_modules/bun/install.js 2>/dev/null || true
if [[ -d "$REPO_ROOT/.eliza.ci-disabled" && ! -d "$REPO_ROOT/eliza" ]]; then
  log "Restoring eliza/ from .eliza.ci-disabled for downstream build steps"
  mv "$REPO_ROOT/.eliza.ci-disabled" "$REPO_ROOT/eliza"
fi
export ELIZA_SKIP_LOCAL_UPSTREAMS=1
export ELIZA_SKIP_LOCAL_UPSTREAMS=1

log "Installing published-workspace fallback dependencies"
if [[ -f "$REPO_ROOT/scripts/install-published-workspace-fallback-deps.sh" ]]; then
  bash "$REPO_ROOT/scripts/install-published-workspace-fallback-deps.sh"
else
  log "No published-workspace fallback dependency script found; skipping"
fi

log "Running repository postinstall"
if [[ -f packages/scripts/setup-upstreams.mjs ]]; then
  SKIP_AVATAR_CLONE=1 ELIZA_NO_VISION_DEPS=1 node "$APP_CORE_SCRIPTS_DIR/run-repo-setup.mjs"
else
  node packages/scripts/patch-nested-core-dist.mjs || true
  node "$APP_CORE_SCRIPTS_DIR/ensure-shared-i18n-data.mjs"
  node "$APP_CORE_SCRIPTS_DIR/patch-deps.mjs" || true
  node "$APP_CORE_SCRIPTS_DIR/ensure-type-package-aliases.mjs" || true
fi
# @elizaos/contracts must be built BEFORE @elizaos/core: core's
# tsconfig.declarations.json maps `@elizaos/contracts` to
# `../contracts/dist/index.d.ts`, so the declarations build aborts with
# TS2307 if dist/ doesn't exist yet.
if [[ -f packages/contracts/package.json ]] && jq -e '.scripts.build' packages/contracts/package.json >/dev/null; then
  log "Building @elizaos/contracts (required by core declarations)"
  pushd packages/contracts >/dev/null
  "$BUN_BIN" run build
  popd >/dev/null
  mkdir -p node_modules/@elizaos
  "${RM_PATH_RECURSIVE[@]}" node_modules/@elizaos/contracts
  ln -s ../../packages/contracts node_modules/@elizaos/contracts
fi

# @elizaos/logger must also be built BEFORE @elizaos/core: core's
# tsconfig.declarations.json maps `@elizaos/logger` to
# `../logger/dist/index.d.ts`, so the declarations build aborts with TS2307
# (src/logger.ts) if dist/ doesn't exist yet.
if [[ -f packages/logger/package.json ]] && jq -e '.scripts.build' packages/logger/package.json >/dev/null; then
  log "Building @elizaos/logger (required by core declarations)"
  pushd packages/logger >/dev/null
  "$BUN_BIN" run build
  popd >/dev/null
  mkdir -p node_modules/@elizaos
  "${RM_PATH_RECURSIVE[@]}" node_modules/@elizaos/logger
  ln -s ../../packages/logger node_modules/@elizaos/logger
fi

# @elizaos/cloud-routing must also be built BEFORE @elizaos/core: core's
# tsconfig.declarations.json maps `@elizaos/cloud-routing` to
# `../cloud/routing/dist/index.d.ts`, so the declarations build aborts with
# TS2307 (src/cloud-routing.ts) if dist/ doesn't exist yet.
if [[ -f packages/cloud/routing/package.json ]] && jq -e '.scripts.build' packages/cloud/routing/package.json >/dev/null; then
  log "Building @elizaos/cloud-routing (required by core declarations)"
  pushd packages/cloud/routing >/dev/null
  "$BUN_BIN" run build
  popd >/dev/null
  mkdir -p node_modules/@elizaos
  "${RM_PATH_RECURSIVE[@]}" node_modules/@elizaos/cloud-routing
  ln -s ../../packages/cloud/routing node_modules/@elizaos/cloud-routing
fi

if [[ -f "$TYPESCRIPT_DIR/package.json" ]]; then
  log "Building @elizaos/core source artifacts"
  pushd "$TYPESCRIPT_DIR" >/dev/null
  "$BUN_BIN" run build.ts --node-only
  popd >/dev/null
  node packages/scripts/prepare-package-dist.mjs "$TYPESCRIPT_DIR"
  CORE_NODE_MODULE="node_modules/@elizaos/core"
  "${RM_PATH_RECURSIVE[@]}" "$CORE_NODE_MODULE"
  mkdir -p "$(dirname "$CORE_NODE_MODULE")"
  ln -s "../../$TYPESCRIPT_DIR" "$CORE_NODE_MODULE"
  node packages/scripts/patch-nested-core-dist.mjs || true
else
  log "No local @elizaos/core source package found at $TYPESCRIPT_DIR; using installed package"
fi

log "Building shared/cloud package artifacts"
# plugin-streaming imports @elizaos/cloud-routing during its declarations build,
# so Docker smoke needs the local workspace package built and linked.
for package_dir in packages/shared packages/cloud/sdk packages/cloud/routing packages/skills; do
  if [[ -f "$package_dir/package.json" ]] && jq -e '.scripts.build' "$package_dir/package.json" >/dev/null; then
    log "Building $(node -p "require('./$package_dir/package.json').name") workspace artifacts"
    pushd "$package_dir" >/dev/null
    "$BUN_BIN" run build
    popd >/dev/null
  fi
done
mkdir -p node_modules/@elizaos
"${RM_PATH_RECURSIVE[@]}" node_modules/@elizaos/shared node_modules/@elizaos/cloud-sdk node_modules/@elizaos/cloud-routing node_modules/@elizaos/skills
ln -s ../../packages/shared node_modules/@elizaos/shared
ln -s ../../packages/cloud/sdk node_modules/@elizaos/cloud-sdk
ln -s ../../packages/cloud/routing node_modules/@elizaos/cloud-routing
ln -s ../../packages/skills node_modules/@elizaos/skills

log "Building Capacitor plugins"
"$BUN_BIN" packages/app-core/scripts/build-native-plugins.mjs

WHATSAPP_PLUGIN_TS_DIR="$PLUGINS_DIR/plugin-whatsapp/typescript"
if [[ -f "$WHATSAPP_PLUGIN_TS_DIR/package.json" ]]; then
  log "Building @elizaos/plugin-whatsapp workspace artifacts"
  pushd "$WHATSAPP_PLUGIN_TS_DIR" >/dev/null
  "$BUN_BIN" run build
  popd >/dev/null
fi

# The agent statically imports a small set of plugins at boot. Their
# package.json `main`/`exports` point at `dist/...`, so the dist must exist
# inside the COPY-into-Docker tree or the runtime fails with
# ERR_MODULE_NOT_FOUND. Build them explicitly here — `bun install
# --ignore-scripts` skipped per-package postinstall hooks.
for plugin in \
  plugin-sql \
  plugin-video \
  plugin-agent-skills \
  plugin-app-manager \
  plugin-pdf \
  plugin-browser \
  plugin-capacitor-bridge \
  plugin-coding-tools \
  plugin-commands \
  plugin-computeruse \
  plugin-discord \
  plugin-elizacloud \
  plugin-imessage \
  plugin-local-inference \
  plugin-mcp \
  plugin-signal \
  plugin-streaming \
  plugin-telegram \
  plugin-whatsapp \
  plugin-workflow \
  plugin-x402; do
  plugin_dir="$PLUGINS_DIR/$plugin"
  if [[ -f "$plugin_dir/package.json" ]]; then
    if jq -e '.scripts.build' "$plugin_dir/package.json" >/dev/null; then
      log "Building @elizaos/$plugin workspace artifacts"
      pushd "$plugin_dir" >/dev/null
      "$BUN_BIN" run build
      popd >/dev/null
    fi
  fi
done

log "Building all @elizaos/app workspace deps (turbo, --force to bypass cache)"
# apps/app's build:web (Vite) resolves every workspace package via its
# `exports` map, which points at `dist/`. Without prior builds those
# entry points don't exist and Vite errors with
#   "Failed to resolve entry for package \"@elizaos/shared\""
#   "Cannot find module '@elizaos/ui/dist/config/app-config.js'"
# build:docker-dist only emits the agent package, so we run the full
# turbo build of @elizaos/app's dep graph (build:core covers a subset
# but misses @elizaos/ui and the @elizaos/app-* surface packages).
# --force forces fresh builds, sidestepping any poisoned remote cache
# that contains partial dist artifacts.
"$BUN_BIN" run build:client -- --force

log "Building agent workspace"
pushd "$AGENT_DIR" >/dev/null
"$BUN_BIN" run build:docker-dist
popd >/dev/null

if [[ -f tsdown.config.ts || -f tsdown.config.mts || -f tsdown.config.js || -f tsdown.config.mjs ]]; then
  log "Building runtime dist"
  npx tsdown
  echo '{"type":"module"}' > dist/package.json
  node --import tsx scripts/write-build-info.ts 2>/dev/null || true
else
  log "No root tsdown config found; using built agent entrypoint"
fi

log "Building app UI"
pushd "$APP_DIR" >/dev/null
NODE_ENV=production "$BUN_BIN" run build:web
popd >/dev/null

if [[ -n "${CORE_NODE_MODULE:-}" && -f "$TYPESCRIPT_DIR/dist/package.json" ]]; then
  log "Relinking @elizaos/core to built dist for Docker runtime"
  "${RM_PATH_RECURSIVE[@]}" "$CORE_NODE_MODULE"
  mkdir -p "$(dirname "$CORE_NODE_MODULE")"
  ln -s "../../$TYPESCRIPT_DIR/dist" "$CORE_NODE_MODULE"
fi

log "Preparing CI dockerignore"
cp "$APP_CORE_DIR/deploy/.dockerignore.ci" .dockerignore

log "Ensuring $AGENT_DIR is present in workspaces for Docker relink"
AGENT_DIR="$AGENT_DIR" node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const agentDir = process.env.AGENT_DIR;
if (!pkg.workspaces) pkg.workspaces = [];
const coversAgentDir = (workspace) => {
  const target = agentDir.replace(/\/+$/, '');
  const pattern = String(workspace).replace(/\/+$/, '');
  if (pattern === target) return true;
  if (!pattern.endsWith('/*')) return false;
  const base = pattern.slice(0, -2);
  if (!target.startsWith(base + '/')) return false;
  return !target.slice(base.length + 1).includes('/');
};
if (!pkg.workspaces.some(coversAgentDir)) {
  pkg.workspaces.push(agentDir);
}
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('Ensured ' + agentDir + ' is present in workspaces');
"

log "Building Docker image"
log "Docker build disk usage"
df -h "$REPO_ROOT" || true
"$DOCKER_BIN" system df || true
available_kb="$(df -Pk "$REPO_ROOT" | awk 'NR == 2 { print $4 }')"
minimum_kb=$((18 * 1024 * 1024))
if [[ -n "$available_kb" && "$available_kb" -lt "$minimum_kb" ]]; then
  fail "Insufficient disk for Docker smoke build: available=$((available_kb / 1024 / 1024))GiB required>=18GiB"
fi
"$DOCKER_BIN" build \
  --file "$APP_CORE_DIR/deploy/Dockerfile.ci" \
  --tag "$DOCKER_IMAGE" \
  --build-arg "BUN_VERSION=$BUN_VERSION" \
  --build-arg "APP_CORE_DIR=$APP_CORE_DIR" \
  --build-arg "AGENT_DIR=$AGENT_DIR" \
  --build-arg "APP_DIR=$APP_DIR" \
  --build-arg "APP_ENTRYPOINT=$APP_ENTRYPOINT" \
  --build-arg "APP_CMD_START=$APP_CMD_START" \
  --build-arg "APP_PORT=$APP_PORT" \
  --build-arg "APP_API_BIND=$APP_API_BIND" \
  --build-arg "OCI_SOURCE=$OCI_SOURCE" \
  --build-arg "OCI_TITLE=$OCI_TITLE" \
  --build-arg "OCI_DESCRIPTION=$OCI_DESCRIPTION" \
  --build-arg "OCI_LICENSES=$OCI_LICENSES" \
  --build-arg "VERSION=$VERSION" \
  --build-arg "VERSION_CLEAN=$VERSION_CLEAN" \
  --build-arg "REVISION=$SOURCE_SHA" \
  .

if $SKIP_SMOKE; then
  log "Skipping runtime smoke boot (--skip-smoke)"
  exit 0
fi

boot_verify
