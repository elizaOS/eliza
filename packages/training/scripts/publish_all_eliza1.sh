#!/usr/bin/env bash
# publish_all_eliza1.sh — drive the Eliza-1 publish orchestrator per tier.
#
# Thin wrapper. The actual end-to-end pipeline lives in
# scripts/publish/orchestrator.py:
#
#   layout → kernel verify → eval gates → manifest → README → HF push → git tag
#
# This script's only job is to walk the tier matrix and dispatch one
# orchestrator invocation per tier. There is NO continue-on-error: any
# tier that fails any stage exits non-zero and aborts the matrix walk.
# There is no skip-eval / skip-verify / publish-anyway flag — see
# packages/training/AGENTS.md §6 and packages/inference/AGENTS.md §6.
#
# The only flag that bypasses HF push is --dry-run, which performs every
# check but does not push.
#
# Layout: each tier is published from its own bundle directory. Pass the
# parent directory via --bundles-root; per-tier dirs are
# <root>/<tier>/. Per-tier directory layout is the §2 bundle (text/,
# tts/, asr/, vision/, dflash/, cache/, evals/, licenses/).
#
# Metal verification is hardware-only. To publish a tier that includes
# the Metal backend (0_8b, 2b, 4b, 9b, 27b, 27b-256k) you
# must record a metal_verify.json on a verified host (run
# packages/inference/verify/metal_verify there) and pass it via
# --metal-verification-<tier> PATH OR by placing it at
# <bundles-root>/<tier>/evals/metal_verify.json (the orchestrator picks
# up that path automatically when passed via --metal-verification).
#
# Usage:
#   scripts/publish_all_eliza1.sh --bundles-root ./bundles
#   scripts/publish_all_eliza1.sh --bundles-root ./bundles --dry-run
#   scripts/publish_all_eliza1.sh --bundles-root ./bundles --filter-tier 4b
#   scripts/publish_all_eliza1.sh --bundles-root ./bundles --metal-verification-9b /path/to/metal.json
#
# Env:
#   HF_TOKEN  required for actual upload (not for --dry-run).

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_PATH="${SCRIPT_DIR}/$(basename "${BASH_SOURCE[0]}")"
readonly TRAINING_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${TRAINING_ROOT}"

readonly TIERS=("0_8b" "2b" "4b" "9b" "27b" "27b-256k" "27b-1m")

DRY_RUN=0
PUBLIC=0
FILTER_TIER=""
BUNDLES_ROOT=""
METAL_PATH_0_8B=""
METAL_PATH_2B=""
METAL_PATH_4B=""
METAL_PATH_9B=""
METAL_PATH_27B=""
METAL_PATH_27B_256K=""
METAL_PATH_27B_1M=""

usage() {
  sed -n '2,40{s/^# //;s/^#//;p;}' "${SCRIPT_PATH}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)            DRY_RUN=1; shift ;;
    --public)             PUBLIC=1; shift ;;
    --filter-tier)        FILTER_TIER="$2"; shift 2 ;;
    --bundles-root)       BUNDLES_ROOT="$2"; shift 2 ;;
    --metal-verification-0_8b)    METAL_PATH_0_8B="$2"; shift 2 ;;
    --metal-verification-2b)      METAL_PATH_2B="$2"; shift 2 ;;
    --metal-verification-4b)      METAL_PATH_4B="$2"; shift 2 ;;
    --metal-verification-9b)      METAL_PATH_9B="$2"; shift 2 ;;
    --metal-verification-27b)     METAL_PATH_27B="$2"; shift 2 ;;
    --metal-verification-27b-256k) METAL_PATH_27B_256K="$2"; shift 2 ;;
    --metal-verification-27b-1m)  METAL_PATH_27B_1M="$2"; shift 2 ;;
    -h|--help)            usage; exit 0 ;;
    *)
      echo "unknown arg: $1" >&2
      usage
      exit 2 ;;
  esac
done

if [[ -z "${BUNDLES_ROOT}" ]]; then
  echo "--bundles-root is required" >&2
  exit 2
fi

UV_BIN=""
if command -v uv >/dev/null 2>&1; then
  UV_BIN="$(command -v uv)"
elif [[ -x "${HOME}/.local/bin/uv" ]]; then
  UV_BIN="${HOME}/.local/bin/uv"
elif [[ -x "/opt/homebrew/bin/uv" ]]; then
  UV_BIN="/opt/homebrew/bin/uv"
fi

if [[ -n "${UV_BIN}" && -f "${TRAINING_ROOT}/pyproject.toml" ]]; then
  RUNNER=("${UV_BIN}" run --with pyyaml --with huggingface_hub --with jinja2 python -m scripts.publish.orchestrator)
elif command -v python3 >/dev/null 2>&1; then
  RUNNER=(python3 -m scripts.publish.orchestrator)
else
  RUNNER=(python -m scripts.publish.orchestrator)
fi

declare -i N_TOTAL=0 N_OK=0 N_FAILED=0
RESULTS=()

metal_path_for_tier() {
  case "$1" in
    0_8b)      printf '%s' "${METAL_PATH_0_8B}" ;;
    2b)        printf '%s' "${METAL_PATH_2B}" ;;
    4b)        printf '%s' "${METAL_PATH_4B}" ;;
    9b)        printf '%s' "${METAL_PATH_9B}" ;;
    27b)       printf '%s' "${METAL_PATH_27B}" ;;
    27b-256k)  printf '%s' "${METAL_PATH_27B_256K}" ;;
    27b-1m)    printf '%s' "${METAL_PATH_27B_1M}" ;;
    *)         printf '%s' "" ;;
  esac
}

publish_one() {
  local tier="$1"
  local bundle_dir="${BUNDLES_ROOT}/${tier}"
  local metal_path

  N_TOTAL+=1

  if [[ ! -d "${bundle_dir}" ]]; then
    echo "[fail] ${tier}: bundle directory missing (${bundle_dir})"
    RESULTS+=("FAIL  ${tier}  (no bundle dir)")
    N_FAILED+=1
    return 1
  fi

  local -a args=(
    --tier "${tier}"
    --bundle-dir "${bundle_dir}"
  )
  (( DRY_RUN == 1 )) && args+=(--dry-run)
  (( PUBLIC == 1 )) && args+=(--public)

  metal_path="$(metal_path_for_tier "${tier}")"
  if [[ -n "${metal_path}" ]]; then
    args+=(--metal-verification "${metal_path}")
  elif [[ -f "${bundle_dir}/evals/metal_verify.json" ]]; then
    args+=(--metal-verification "${bundle_dir}/evals/metal_verify.json")
  fi

  echo
  echo "==> publish ${tier}"
  echo "    bundle:  ${bundle_dir}"
  echo "    cmd:     ${RUNNER[*]} ${args[*]}"

  if "${RUNNER[@]}" "${args[@]}"; then
    RESULTS+=("OK    ${tier}")
    N_OK+=1
    return 0
  else
    local exit_code=$?
    RESULTS+=("FAIL  ${tier}  (exit ${exit_code})")
    N_FAILED+=1
    return "${exit_code}"
  fi
}

FIRST_FAILURE_EXIT=0
for tier in "${TIERS[@]}"; do
  if [[ -n "${FILTER_TIER}" && "${FILTER_TIER}" != "${tier}" ]]; then
    continue
  fi
  # Per AGENTS.md §6: any failure aborts the run. No "publish what
  # works and skip the rest" behavior. We still want the summary printed,
  # so capture the failing exit code, stop the matrix walk, and report it.
  publish_one "${tier}" || { FIRST_FAILURE_EXIT=$?; break; }
done

echo
echo "==> publish summary"
for r in "${RESULTS[@]}"; do
  echo "    ${r}"
done
echo "==> totals: ${N_TOTAL} considered, ${N_OK} ok, ${N_FAILED} failed"

if (( N_FAILED > 0 )); then
  # Propagate the orchestrator's structured exit code so callers can tell
  # release-evidence failures (16) from layout failures (10), etc.
  exit "${FIRST_FAILURE_EXIT:-1}"
fi
