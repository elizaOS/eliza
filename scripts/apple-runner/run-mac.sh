#!/usr/bin/env bash
# run-mac.sh — Apple Silicon Mac runner: build elizaOS/llama.cpp with
# -DGGML_METAL=ON for darwin-arm64-metal, run metal_verify against all 5
# kernel fixtures, and run a tiny llama-cli smoke that exercises Metal.
#
# Designed to be executed cold on a fresh M-series Mac with Xcode CLT
# installed. All paths are derived; no global env required.
#
# Usage:
#   bash scripts/apple-runner/run-mac.sh            # default run
#   bash scripts/apple-runner/run-mac.sh --skip-build  # reuse existing build
#   APPLE_RUNNER_REF=master bash scripts/apple-runner/run-mac.sh
#
# Env knobs (all optional):
#   APPLE_RUNNER_REPO         git URL to clone (default: elizaOS/llama.cpp)
#   APPLE_RUNNER_REF          tag/branch/SHA (default: v0.1.0-milady)
#   APPLE_RUNNER_FALLBACK_REF if APPLE_RUNNER_REF is missing, fall back to
#                             this ref (default: master)
#   APPLE_RUNNER_SMOKE_MODEL  absolute path to a Q4_K_M GGUF for the smoke
#                             generation. If unset, the script tries common
#                             cache locations, then skips the gen smoke
#                             with a clear message.
#   APPLE_RUNNER_REPORT_DIR   override the report output directory.

set -euo pipefail

# -- Resolve repo root ---------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

# -- Constants -----------------------------------------------------------------
APPLE_RUNNER_REPO="${APPLE_RUNNER_REPO:-https://github.com/elizaOS/llama.cpp.git}"
APPLE_RUNNER_REF="${APPLE_RUNNER_REF:-v0.1.0-milady}"
APPLE_RUNNER_FALLBACK_REF="${APPLE_RUNNER_FALLBACK_REF:-master}"

DATE_STAMP="$(date -u +%Y-%m-%d)"
REPORT_DIR="${APPLE_RUNNER_REPORT_DIR:-${REPO_ROOT}/reports/porting/${DATE_STAMP}}"
REPORT_FILE="${REPORT_DIR}/mac-metal-smoke.md"
TMP_LOG="$(mktemp -t mac-metal-smoke.XXXXXX.log)"

mkdir -p "${REPORT_DIR}"

# -- Logging helpers -----------------------------------------------------------
log() { printf '[apple-runner/mac] %s\n' "$*" | tee -a "${TMP_LOG}"; }
fail() { printf '[apple-runner/mac] FAIL: %s\n' "$*" | tee -a "${TMP_LOG}" >&2; exit 1; }

# -- Argument parsing ----------------------------------------------------------
SKIP_BUILD=0
SKIP_VERIFY=0
SKIP_SMOKE=0
for arg in "$@"; do
  case "${arg}" in
    --skip-build) SKIP_BUILD=1 ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    --skip-smoke) SKIP_SMOKE=1 ;;
    -h|--help)
      sed -n '2,25p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) fail "unknown arg: ${arg}" ;;
  esac
done

# -- 1. Host preflight ---------------------------------------------------------
log "preflight: verifying macOS host"
if [ "$(uname -s)" != "Darwin" ]; then
  fail "macOS host required (uname -s = $(uname -s))"
fi
if [ "$(uname -m)" != "arm64" ]; then
  fail "Apple Silicon required (uname -m = $(uname -m)); macOS x86_64 is out of scope"
fi

log "preflight: verifying Xcode Command Line Tools"
if ! command -v xcrun >/dev/null 2>&1; then
  fail "xcrun not found in PATH; run: xcode-select --install"
fi
if ! xcrun --find metal >/dev/null 2>&1; then
  fail "xcrun --find metal failed; install Xcode (not just CLT) for Metal toolchain"
fi
if ! xcrun --find xcodebuild >/dev/null 2>&1; then
  fail "xcrun --find xcodebuild failed; install Xcode (not just CLT)"
fi
DEVELOPER_DIR_RESOLVED="$(xcode-select -p 2>/dev/null || echo unknown)"
log "preflight: DEVELOPER_DIR=${DEVELOPER_DIR_RESOLVED}"

for tool in cmake bun git make clang clang++; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    fail "missing required tool: ${tool}"
  fi
done

# Free disk in GB on the cache + state dir partitions.
DISK_FREE_GB="$(df -g "${HOME}" 2>/dev/null | awk 'NR==2 {print $4}')"
log "preflight: free disk on \$HOME partition = ${DISK_FREE_GB} GB"
if [ -n "${DISK_FREE_GB}" ] && [ "${DISK_FREE_GB}" -lt 10 ]; then
  fail "need ~10 GB free for llama.cpp checkout + build (have ${DISK_FREE_GB} GB)"
fi

# -- 2. Build llama.cpp Metal target -------------------------------------------
BUILD_SCRIPT="${REPO_ROOT}/packages/app-core/scripts/build-llama-cpp-dflash.mjs"
if [ ! -f "${BUILD_SCRIPT}" ]; then
  fail "build script missing at ${BUILD_SCRIPT}"
fi

ELIZA_STATE_DIR="${ELIZA_STATE_DIR:-${HOME}/.eliza}"
DARWIN_OUT_DIR="${ELIZA_STATE_DIR}/local-inference/bin/dflash/darwin-arm64-metal"

if [ "${SKIP_BUILD}" = "1" ]; then
  log "build: --skip-build set; expecting prior artifacts in ${DARWIN_OUT_DIR}"
elif [ -f "${DARWIN_OUT_DIR}/llama-cli" ] && [ "${APPLE_RUNNER_FORCE_REBUILD:-0}" != "1" ]; then
  log "build: existing artifacts found in ${DARWIN_OUT_DIR}; reusing (set APPLE_RUNNER_FORCE_REBUILD=1 to rebuild)"
else
  log "build: invoking dflash build for darwin-arm64-metal (ref=${APPLE_RUNNER_REF})"
  RESOLVED_REF="${APPLE_RUNNER_REF}"
  if ! git ls-remote --exit-code --tags --heads "${APPLE_RUNNER_REPO}" "${APPLE_RUNNER_REF}" >/dev/null 2>&1; then
    log "build: ref '${APPLE_RUNNER_REF}' not found on remote; falling back to '${APPLE_RUNNER_FALLBACK_REF}'"
    RESOLVED_REF="${APPLE_RUNNER_FALLBACK_REF}"
  fi
  ELIZA_DFLASH_LLAMA_CPP_REMOTE="${APPLE_RUNNER_REPO}" \
  ELIZA_DFLASH_LLAMA_CPP_REF="${RESOLVED_REF}" \
    bun run "${BUILD_SCRIPT}" --target darwin-arm64-metal --ref "${RESOLVED_REF}" 2>&1 | tee -a "${TMP_LOG}"
fi

if [ ! -f "${DARWIN_OUT_DIR}/llama-cli" ]; then
  fail "build did not produce ${DARWIN_OUT_DIR}/llama-cli"
fi
LLAMA_CLI="${DARWIN_OUT_DIR}/llama-cli"

CAPABILITIES_JSON="${DARWIN_OUT_DIR}/CAPABILITIES.json"
if [ -f "${CAPABILITIES_JSON}" ]; then
  log "build: CAPABILITIES.json present"
else
  log "build: WARNING — no CAPABILITIES.json"
fi

# -- 3. Build verifier harness -------------------------------------------------
KERNELS_VERIFY_DIR="${REPO_ROOT}/local-inference/kernels/verify"
if [ ! -d "${KERNELS_VERIFY_DIR}" ]; then
  fail "kernel verify directory missing: ${KERNELS_VERIFY_DIR}"
fi

if [ "${SKIP_VERIFY}" = "1" ]; then
  log "verify: --skip-verify set; skipping verifier build + run"
else
  log "verify: building reference + metal harness"
  ( cd "${KERNELS_VERIFY_DIR}" && make reference-test ) 2>&1 | tee -a "${TMP_LOG}"
  ( cd "${KERNELS_VERIFY_DIR}" && make metal ) 2>&1 | tee -a "${TMP_LOG}"
  if [ ! -x "${KERNELS_VERIFY_DIR}/metal_verify" ]; then
    fail "metal_verify binary not produced"
  fi
fi

# -- 4. Run metal_verify against all 5 fixtures --------------------------------
declare -a KERNEL_NAMES=(turbo3 turbo4 turbo3_tcq qjl polar)
declare -a KERNEL_ENTRIES=(
  "kernel_turbo3_dot"
  "kernel_turbo4_dot"
  "kernel_turbo3_tcq_dot"
  "kernel_attn_score_qjl1_256"
  "kernel_mul_mv_q4_polar_f32"
)
declare -a KERNEL_RESULTS=()
TOTAL_FIXTURES=${#KERNEL_NAMES[@]}
PASS_COUNT=0

if [ "${SKIP_VERIFY}" = "1" ]; then
  log "verify: skipped, no kernel fixtures exercised"
else
  for i in "${!KERNEL_NAMES[@]}"; do
    name="${KERNEL_NAMES[$i]}"
    entry="${KERNEL_ENTRIES[$i]}"
    metal_src="${REPO_ROOT}/local-inference/kernels/metal/${name}.metal"
    fixture="${KERNELS_VERIFY_DIR}/fixtures/${name}.json"
    if [ ! -f "${metal_src}" ]; then
      log "verify: SKIP ${name} (missing ${metal_src})"
      KERNEL_RESULTS+=("${name}|SKIP|missing-source")
      continue
    fi
    if [ ! -f "${fixture}" ]; then
      log "verify: SKIP ${name} (missing fixture)"
      KERNEL_RESULTS+=("${name}|SKIP|missing-fixture")
      continue
    fi
    log "verify: running metal_verify on ${name}"
    set +e
    "${KERNELS_VERIFY_DIR}/metal_verify" "${metal_src}" "${entry}" "${fixture}" 2>&1 | tee -a "${TMP_LOG}"
    rc=${PIPESTATUS[0]}
    set -e
    if [ "${rc}" -eq 0 ]; then
      KERNEL_RESULTS+=("${name}|PASS|all outputs within tol=1e-3")
      PASS_COUNT=$((PASS_COUNT + 1))
    else
      KERNEL_RESULTS+=("${name}|FAIL|metal_verify exit=${rc}")
    fi
  done
fi

# -- 5. Smoke: load a small Q4_K_M model + 10 tokens via Metal -----------------
SMOKE_STATUS="SKIP"
SMOKE_DETAIL="not run"
SMOKE_TEXT=""
SMOKE_MODEL_FOUND=""

if [ "${SKIP_SMOKE}" = "1" ]; then
  SMOKE_DETAIL="skipped via --skip-smoke"
else
  declare -a CANDIDATE_MODELS=()
  if [ -n "${APPLE_RUNNER_SMOKE_MODEL:-}" ] && [ -f "${APPLE_RUNNER_SMOKE_MODEL}" ]; then
    CANDIDATE_MODELS+=("${APPLE_RUNNER_SMOKE_MODEL}")
  fi
  # Common managed-state cache layouts: try a few well-known small Q4_K_M
  # ggufs the local-inference catalog ships with.
  while IFS= read -r found; do
    CANDIDATE_MODELS+=("${found}")
  done < <(
    {
      find "${ELIZA_STATE_DIR}/local-inference/models" -maxdepth 4 -type f -name '*Q4_K_M*.gguf' 2>/dev/null
      find "${HOME}/Library/Caches/Eliza" -maxdepth 6 -type f -name '*Q4_K_M*.gguf' 2>/dev/null
      find "${HOME}/.cache/eliza" -maxdepth 6 -type f -name '*Q4_K_M*.gguf' 2>/dev/null
    } | head -3
  )

  for candidate in "${CANDIDATE_MODELS[@]}"; do
    if [ -f "${candidate}" ]; then
      SMOKE_MODEL_FOUND="${candidate}"
      break
    fi
  done

  if [ -z "${SMOKE_MODEL_FOUND}" ]; then
    SMOKE_DETAIL="no Q4_K_M GGUF found; set APPLE_RUNNER_SMOKE_MODEL to enable smoke"
    log "smoke: ${SMOKE_DETAIL}"
  else
    log "smoke: using model ${SMOKE_MODEL_FOUND}"
    SMOKE_STDERR="$(mktemp -t mac-metal-smoke.stderr.XXXXXX.log)"
    SMOKE_STDOUT="$(mktemp -t mac-metal-smoke.stdout.XXXXXX.log)"
    set +e
    # cache-type k=tbq4_0 v=tbq3_0 mirrors the on-device routing target.
    # If the build doesn't yet expose those keys, we still capture the
    # MTLDevice / "Metal" lines from stderr to confirm GPU acceleration.
    "${LLAMA_CLI}" \
      --model "${SMOKE_MODEL_FOUND}" \
      --prompt "Hello, this is a Metal smoke test." \
      -n 10 \
      --no-conversation \
      --temp 0 \
      --cache-type-k tbq4_0 \
      --cache-type-v tbq3_0 \
      >"${SMOKE_STDOUT}" 2>"${SMOKE_STDERR}"
    SMOKE_RC=$?
    set -e

    SMOKE_TEXT="$(cat "${SMOKE_STDOUT}" | tail -c 1024)"
    METAL_HIT=$(grep -E -c '(MTLDevice|metal|Metal)' "${SMOKE_STDERR}" 2>/dev/null || echo 0)

    if [ "${SMOKE_RC}" -eq 0 ] && [ "${METAL_HIT}" -gt 0 ]; then
      SMOKE_STATUS="PASS"
      SMOKE_DETAIL="generated text via Metal (rc=0, ${METAL_HIT} Metal stderr lines)"
    elif [ "${SMOKE_RC}" -eq 0 ]; then
      # Some llama-cli builds tag the device as "Apple GPU" without the
      # literal "Metal" string — fall back to that.
      APPLE_HIT=$(grep -E -c '(Apple [A-Z][0-9]|MPS|GPU)' "${SMOKE_STDERR}" 2>/dev/null || echo 0)
      if [ "${APPLE_HIT}" -gt 0 ]; then
        SMOKE_STATUS="PASS"
        SMOKE_DETAIL="generated text on Apple GPU (rc=0, ${APPLE_HIT} GPU stderr lines)"
      else
        SMOKE_STATUS="FAIL"
        SMOKE_DETAIL="rc=0 but no Metal/GPU markers in stderr; check ${SMOKE_STDERR}"
      fi
    else
      SMOKE_STATUS="FAIL"
      SMOKE_DETAIL="llama-cli exit=${SMOKE_RC}; tail of stderr: $(tail -n 5 "${SMOKE_STDERR}" | tr '\n' ' ')"
    fi
    log "smoke: status=${SMOKE_STATUS} detail=${SMOKE_DETAIL}"
  fi
fi

# -- 6. Write report -----------------------------------------------------------
{
  printf '# Mac Metal smoke — %s\n\n' "${DATE_STAMP}"
  printf 'Run by `scripts/apple-runner/run-mac.sh` on host `%s` (Darwin %s, %s).\n\n' \
    "$(hostname)" "$(uname -r)" "$(uname -m)"
  printf '## Toolchain\n\n'
  printf -- '- DEVELOPER_DIR: `%s`\n' "${DEVELOPER_DIR_RESOLVED}"
  printf -- '- xcrun metal: `%s`\n' "$(xcrun --find metal 2>/dev/null || echo NOT FOUND)"
  printf -- '- xcrun xcodebuild: `%s`\n' "$(xcrun --find xcodebuild 2>/dev/null || echo NOT FOUND)"
  printf -- '- cmake: `%s`\n' "$(cmake --version 2>/dev/null | head -1)"
  printf -- '- bun: `%s`\n' "$(bun --version 2>/dev/null)"
  printf -- '- llama.cpp ref: `%s` (fork: `%s`)\n\n' "${APPLE_RUNNER_REF}" "${APPLE_RUNNER_REPO}"

  printf '## Build\n\n'
  printf -- '- Output: `%s`\n' "${DARWIN_OUT_DIR}"
  if [ -f "${CAPABILITIES_JSON}" ]; then
    printf -- '- CAPABILITIES.json:\n\n'
    printf '```\n'
    cat "${CAPABILITIES_JSON}"
    printf '\n```\n'
  else
    printf -- '- CAPABILITIES.json: missing\n'
  fi
  printf '\n'

  printf '## Kernel verification (metal_verify)\n\n'
  printf '| kernel | status | detail |\n'
  printf '|---|---|---|\n'
  for entry in "${KERNEL_RESULTS[@]}"; do
    name=${entry%%|*}; rest=${entry#*|}; status=${rest%%|*}; detail=${rest#*|}
    printf '| %s | %s | %s |\n' "${name}" "${status}" "${detail}"
  done
  printf '\n%s passed / %s total\n\n' "${PASS_COUNT}" "${TOTAL_FIXTURES}"

  printf '## llama-cli Metal smoke\n\n'
  printf -- '- Status: %s\n' "${SMOKE_STATUS}"
  printf -- '- Detail: %s\n' "${SMOKE_DETAIL}"
  if [ -n "${SMOKE_MODEL_FOUND}" ]; then
    printf -- '- Model: `%s`\n' "${SMOKE_MODEL_FOUND}"
  fi
  if [ -n "${SMOKE_TEXT}" ]; then
    printf -- '- Generated tail (last ~1KB):\n\n'
    printf '```\n%s\n```\n' "${SMOKE_TEXT}"
  fi
  printf '\n'

  printf '## Full log\n\n'
  printf '```\n'
  tail -c 8192 "${TMP_LOG}"
  printf '\n```\n'
} > "${REPORT_FILE}"

log "report written: ${REPORT_FILE}"

# -- 7. Exit code reflects worst sub-step --------------------------------------
EXIT=0
if [ "${SKIP_VERIFY}" != "1" ] && [ "${PASS_COUNT}" -ne "${TOTAL_FIXTURES}" ]; then
  log "verify: ${PASS_COUNT}/${TOTAL_FIXTURES} kernels passed"
  EXIT=1
fi
if [ "${SMOKE_STATUS}" = "FAIL" ]; then
  EXIT=2
fi
exit ${EXIT}
