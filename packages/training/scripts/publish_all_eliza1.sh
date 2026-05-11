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
# the Metal backend (0_6b, 1_7b, 9b, 27b, 27b-256k) you
# must record a metal_verify.json on a verified host (run
# packages/inference/verify/metal_verify there) and pass it via
# --metal-verification-<tier> PATH OR by placing it at
# <bundles-root>/<tier>/evals/metal_verify.json (the orchestrator picks
# up that path automatically when passed via --metal-verification).
#
# Usage:
#   scripts/publish_all_eliza1.sh --bundles-root ./bundles
#   scripts/publish_all_eliza1.sh --bundles-root ./bundles --dry-run
#   scripts/publish_all_eliza1.sh --bundles-root ./bundles --filter-tier 9b
#   scripts/publish_all_eliza1.sh --bundles-root ./bundles --metal-verification-9b /path/to/metal.json
#
# Env:
#   HF_TOKEN  required for actual upload (not for --dry-run).

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TRAINING_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${TRAINING_ROOT}"

readonly TIERS=("0_6b" "1_7b" "9b" "27b" "27b-256k")

DRY_RUN=0
PUBLIC=0
FILTER_TIER=""
BUNDLES_ROOT=""
declare -A METAL_PATHS=()

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \?//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)            DRY_RUN=1; shift ;;
    --public)             PUBLIC=1; shift ;;
    --filter-tier)        FILTER_TIER="$2"; shift 2 ;;
    --bundles-root)       BUNDLES_ROOT="$2"; shift 2 ;;
    --metal-verification-0_6b)    METAL_PATHS[0_6b]="$2"; shift 2 ;;
    --metal-verification-1_7b)  METAL_PATHS[1_7b]="$2"; shift 2 ;;
    --metal-verification-9b)   METAL_PATHS[9b]="$2"; shift 2 ;;
    --metal-verification-27b)      METAL_PATHS[27b]="$2"; shift 2 ;;
    --metal-verification-27b-256k) METAL_PATHS[27b-256k]="$2"; shift 2 ;;
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

if command -v uv >/dev/null 2>&1 && [[ -f "${TRAINING_ROOT}/pyproject.toml" ]]; then
  RUNNER=(uv run --with pyyaml --with huggingface_hub --with jinja2 python -m scripts.publish.orchestrator)
else
  RUNNER=(python -m scripts.publish.orchestrator)
fi

declare -i N_TOTAL=0 N_OK=0 N_FAILED=0
RESULTS=()

publish_one() {
  local tier="$1"
  local bundle_dir="${BUNDLES_ROOT}/${tier}"

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

  if [[ -n "${METAL_PATHS[${tier}]:-}" ]]; then
    args+=(--metal-verification "${METAL_PATHS[${tier}]}")
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

for tier in "${TIERS[@]}"; do
  if [[ -n "${FILTER_TIER}" && "${FILTER_TIER}" != "${tier}" ]]; then
    continue
  fi
  # Per AGENTS.md §6: any failure aborts the run. No "publish what
  # works and skip the rest" behavior.
  publish_one "${tier}"
done

echo
echo "==> publish summary"
for r in "${RESULTS[@]}"; do
  echo "    ${r}"
done
echo "==> totals: ${N_TOTAL} considered, ${N_OK} ok, ${N_FAILED} failed"

if (( N_FAILED > 0 )); then
  exit 1
fi
