#!/usr/bin/env bash
# hf-transfer-eliza1.sh — move the legacy Eliza-1 HuggingFace model repos out
# of the old `milady-ai` namespace into the canonical `elizaos` org, and create
# the per-tier `elizaos/eliza-1-<tier>` bundle repos that don't exist yet.
#
# Context: the codebase already publishes to `elizaos/eliza-1-<tier>`
# (`packages/training/scripts/publish/orchestrator.py:ELIZA_1_HF_ORG = "elizaos"`),
# but the *uploaded* repos from the pre-rename pipeline live under
# `huggingface.co/milady-ai/*` (the old `-milady-optimized` / `-milady-drafter`
# bundle naming — see `packages/inference/reports/porting/2026-05-10/eliza-1-repos/README.md`,
# formerly `milady-ai-repos/`). HF preserves git history + download stats across
# a `repo move`, so moving (not re-uploading) is the right operation. The new
# canonical per-tier bundle repos are created empty here; the real bytes land
# via `packages/training/scripts/publish_all_eliza1.sh` once the base-v1 evals +
# hardware evidence are green (see RELEASE_V1.md §10).
#
# Auth: requires an `HF_TOKEN` with WRITE access to BOTH the `milady-ai` org
# (source — to move out of it) and the `elizaos` org (destination + create).
# `huggingface-cli` (>= 0.24, ships with `huggingface_hub[cli]`) reads `HF_TOKEN`
# from the env or `~/.cache/huggingface/token`. There is no CI path for this — an
# org admin runs it once.
#
# Default mode is DRY-RUN: prints exactly what it would do, touches nothing.
# Pass `--execute` to actually perform the moves/creates.
#
# Usage:
#   scripts/hf-transfer-eliza1.sh                 # dry-run: print the plan
#   scripts/hf-transfer-eliza1.sh --execute       # perform the moves + creates
#   scripts/hf-transfer-eliza1.sh --execute --skip-creates   # only move legacy repos
#   scripts/hf-transfer-eliza1.sh --execute --skip-moves     # only create new tier repos
#
# Exit status: non-zero on the first failed move/create in --execute mode (HF's
# `repo move` is idempotent-ish — a repo already at the destination is reported,
# not a hard error here, so a partially-completed run can be re-run).

set -euo pipefail

SRC_ORG="milady-ai"
DST_ORG="elizaos"
EXECUTE=0
SKIP_MOVES=0
SKIP_CREATES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute)       EXECUTE=1; shift ;;
    --skip-moves)    SKIP_MOVES=1; shift ;;
    --skip-creates)  SKIP_CREATES=1; shift ;;
    --src-org)       SRC_ORG="$2"; shift 2 ;;
    --dst-org)       DST_ORG="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0 ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2 ;;
  esac
done

# --- legacy repos to move (milady-ai/<old>  ->  elizaos/<new>) -----------------
# Pairs are "<old-name-under-src-org> <new-name-under-dst-org>". The `-milady-`
# infix is dropped per the rename; the per-tier *-optimized / *-drafter bundle
# repos keep their base-model-derived names. Source: the directory inventory in
# packages/inference/reports/porting/2026-05-10/eliza-1-repos/ + that dir's
# README.md "Historical note".
LEGACY_MOVES=(
  "eliza-1-2b-milady-optimized       eliza-1-2b-optimized"
  "eliza-1-9b-milady-optimized       eliza-1-9b-optimized"
  "eliza-1-27b-milady-optimized      eliza-1-27b-optimized"
  "qwen3.5-4b-milady-optimized       qwen3.5-4b-optimized"
  "qwen3.5-4b-milady-drafter         qwen3.5-4b-drafter"
  "qwen3.5-9b-milady-optimized       qwen3.5-9b-optimized"
  "qwen3.5-9b-milady-drafter         qwen3.5-9b-drafter"
  "qwen3.6-27b-milady-optimized      qwen3.6-27b-optimized"
  "qwen3.6-27b-milady-drafter        qwen3.6-27b-drafter"
  "bonsai-8b-1bit-milady-optimized   bonsai-8b-1bit-optimized"
  # If the legacy repos were already created without the `-milady-` infix
  # (some pipeline runs did this), the source name == the destination name;
  # `repo move milady-ai/X elizaos/X` still does the org transfer.
  "eliza-1-2b-optimized              eliza-1-2b-optimized"
  "eliza-1-9b-optimized              eliza-1-9b-optimized"
  "eliza-1-27b-optimized             eliza-1-27b-optimized"
  "qwen3.5-4b-optimized              qwen3.5-4b-optimized"
  "qwen3.5-4b-drafter                qwen3.5-4b-drafter"
  "qwen3.5-9b-optimized              qwen3.5-9b-optimized"
  "qwen3.5-9b-drafter                qwen3.5-9b-drafter"
  "qwen3.6-27b-optimized             qwen3.6-27b-optimized"
  "qwen3.6-27b-drafter               qwen3.6-27b-drafter"
  "bonsai-8b-1bit-optimized          bonsai-8b-1bit-optimized"
)

# --- canonical per-tier bundle repos to create (elizaos/eliza-1-<tier>) --------
# These match `packages/training/scripts/publish/orchestrator.py` (tier matrix in
# publish_all_eliza1.sh + the 27b-1m tier in the catalog). `repo create` is a
# no-op if the repo already exists.
TIER_REPOS=(
  "eliza-1-0_6b"
  "eliza-1-1_7b"
  "eliza-1-9b"
  "eliza-1-27b"
  "eliza-1-27b-256k"
  "eliza-1-27b-1m"
)

run() {
  # Echo the command; run it only in --execute mode.
  echo "  + $*"
  if [[ "$EXECUTE" -eq 1 ]]; then
    "$@"
  fi
}

if ! command -v huggingface-cli >/dev/null 2>&1; then
  echo "huggingface-cli not found. Install with: uv pip install 'huggingface_hub[cli]>=0.24'" >&2
  [[ "$EXECUTE" -eq 1 ]] && exit 1
  echo "(dry-run continues; commands below are what WOULD run)"
fi

if [[ "$EXECUTE" -eq 1 && -z "${HF_TOKEN:-}" ]]; then
  if [[ ! -f "${HOME}/.cache/huggingface/token" ]]; then
    echo "HF_TOKEN not set and ~/.cache/huggingface/token missing." >&2
    echo "Set HF_TOKEN to a token with WRITE access to both '${SRC_ORG}' and '${DST_ORG}'." >&2
    exit 1
  fi
fi

echo "=== Eliza-1 HuggingFace transfer ==="
echo "  source org:      ${SRC_ORG}"
echo "  destination org: ${DST_ORG}"
echo "  mode:            $([[ $EXECUTE -eq 1 ]] && echo EXECUTE || echo DRY-RUN)"
echo

if [[ "$SKIP_MOVES" -eq 0 ]]; then
  echo "--- 1. Move legacy bundle repos out of ${SRC_ORG} ---"
  echo "    (HF preserves git history + download stats across a repo move)"
  for pair in "${LEGACY_MOVES[@]}"; do
    read -r OLD NEW <<<"$pair"
    echo "  move ${SRC_ORG}/${OLD}  ->  ${DST_ORG}/${NEW}"
    # `huggingface-cli repo move` exits non-zero if the source repo does not
    # exist; tolerate that in --execute (some names in LEGACY_MOVES are
    # alternates) but surface every other failure.
    if [[ "$EXECUTE" -eq 1 ]]; then
      if huggingface-cli repo move "${SRC_ORG}/${OLD}" "${DST_ORG}/${NEW}"; then
        echo "    moved."
      else
        echo "    (skipped: ${SRC_ORG}/${OLD} not found or already moved)"
      fi
    else
      echo "  + huggingface-cli repo move ${SRC_ORG}/${OLD} ${DST_ORG}/${NEW}"
    fi
  done
  echo
fi

if [[ "$SKIP_CREATES" -eq 0 ]]; then
  echo "--- 2. Create canonical per-tier bundle repos under ${DST_ORG} (empty; publish fills them) ---"
  for name in "${TIER_REPOS[@]}"; do
    echo "  create ${DST_ORG}/${name}"
    # `--exist-ok` makes this idempotent.
    run huggingface-cli repo create "${DST_ORG}/${name}" --repo-type model --exist-ok
  done
  echo
fi

echo "--- 3. After transfer ---"
echo "  Refresh the catalog from the new namespace:"
echo "    uv run python packages/training/scripts/sync_catalog_from_hf.py --org ${DST_ORG} \\"
echo "        --out packages/inference/reports/porting/\$(date -u +%Y-%m-%d)/catalog-diff.json"
echo "  Phone-equivalent download check:"
echo "    node scripts/verify-phone-download.mjs --diff-first --model-id eliza-1-1_7b"
echo
if [[ "$EXECUTE" -eq 1 ]]; then
  echo "Done. Verify on https://huggingface.co/${DST_ORG}"
else
  echo "Dry-run complete. Re-run with --execute (and an HF_TOKEN with write access"
  echo "to both '${SRC_ORG}' and '${DST_ORG}') to perform the moves + creates."
fi
