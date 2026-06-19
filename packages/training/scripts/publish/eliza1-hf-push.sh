#!/usr/bin/env bash
# eliza1-hf-push.sh — fail-closed wrapper around the Eliza-1 HF publisher.
#
# This script REFUSES to push to Hugging Face unless BOTH of the following
# are true:
#
#   1. ``HF_TOKEN`` (or ``HUGGINGFACE_HUB_TOKEN``) is set to a non-empty value.
#   2. The caller passed ``--yes-i-will-pay`` on the command line.
#
# Even with both conditions met it does NOT call ``hf upload`` directly —
# it dispatches to ``scripts.publish.publish_eliza1_model_repo`` which
# itself enforces the eval/manifest/release-evidence gates per
# ``packages/training/AGENTS.md`` §6 and refuses any tier that is not
# ``uploadable``.
#
# Without ``--yes-i-will-pay`` (or without ``HF_TOKEN``) it prints what
# would run via ``hf upload`` and exits non-zero. That is the dry-run
# path: zero HF API calls, zero bytes transferred, zero spend.
#
# Usage:
#   bash packages/training/scripts/publish/eliza1-hf-push.sh
#       (no args → prints would-be commands, exits non-zero)
#
#   HF_TOKEN=hf_xxx bash packages/training/scripts/publish/eliza1-hf-push.sh \
#       --yes-i-will-pay [--bundles-root DIR] [--tier 0_8b ...]
#
# Other flags (passed through to publish_eliza1_model_repo):
#   --bundles-root DIR      Default: ~/.eliza/local-inference/models
#   --tier TIER             Repeat to limit which tiers are pushed.
#   --strict-voice-policy   Promote voice warnings to errors.
#   --large-folder-upload   Use HfApi.upload_large_folder (recommended for
#                           multi-GiB GGUF tiers).
#   --large-folder-workers N

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TRAINING_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

YES_I_WILL_PAY=0
PASSTHROUGH=()

for arg in "$@"; do
  case "${arg}" in
    --yes-i-will-pay)
      YES_I_WILL_PAY=1
      ;;
    *)
      PASSTHROUGH+=("${arg}")
      ;;
  esac
done

# Pick the HF token without unbound-var noise.
TOKEN="${HF_TOKEN:-${HUGGINGFACE_HUB_TOKEN:-}}"

if [[ -z "${TOKEN}" || "${YES_I_WILL_PAY}" -ne 1 ]]; then
  cat >&2 <<'MSG'
eliza1-hf-push: refusing to push to Hugging Face.

This wrapper requires BOTH:
  - HF_TOKEN (or HUGGINGFACE_HUB_TOKEN) set to a non-empty value, AND
  - --yes-i-will-pay passed on the command line.

Without both, no HF upload is attempted. The would-be command is:

  cd packages/training && \
    python3 -m scripts.publish.publish_eliza1_model_repo \
      --bundles-root ~/.eliza/local-inference/models

To dry-run the per-tier plan instead (no HF API calls), run:

  node packages/training/scripts/publish/eliza1-hf-stage.mjs --dry-run

To dry-run via the underlying CLI:

  HF_TOKEN= huggingface-cli upload --help   # confirm hf is installed
  cd packages/training && \
    python3 -m scripts.publish.publish_eliza1_model_repo \
      --bundles-root ~/.eliza/local-inference/models \
      --dry-run --allow-missing --report /tmp/eliza1-hf-plan.json

See packages/training/reports/eliza1-hf-readiness-2026-05-14.md for the
per-tier blocker ledger before paying for an upload.
MSG
  exit 2
fi

cd "${TRAINING_ROOT}"

PYTHON="${PYTHON:-python3}"
if ! command -v "${PYTHON}" >/dev/null 2>&1; then
  echo "eliza1-hf-push: ${PYTHON} not on PATH." >&2
  exit 127
fi

echo "eliza1-hf-push: HF_TOKEN present and --yes-i-will-pay acknowledged." >&2
echo "eliza1-hf-push: dispatching to scripts.publish.publish_eliza1_model_repo." >&2
echo "eliza1-hf-push: any tier not 'uploadable' will block the push (gate-honest)." >&2

exec env HF_TOKEN="${TOKEN}" "${PYTHON}" -m scripts.publish.publish_eliza1_model_repo \
  "${PASSTHROUGH[@]}"
