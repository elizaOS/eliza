#!/usr/bin/env bash
# Register the Eliza-1 sizes against an Eliza Cloud deployment.
#
# Eliza Cloud doesn't ship a public CLI for model registration today;
# routing is configured by:
#   1. Adding a catalog entry per `vast/eliza-1-<size>` model id in
#      `packages/cloud/shared/src/lib/models/catalog.ts` so the Worker
#      knows the model exists and which provider to forward to.
#   2. Upserting a Vast template per size (one-time per quant flavor)
#      via `packages/cloud/scripts/vast/upsert-template.ts`.
#   3. Provisioning a Vast Serverless endpoint per template via
#      `packages/cloud/scripts/vast/provision-endpoint.ts`.
#   4. Setting the resulting `VAST_BASE_URL` and `VAST_API_KEY`
#      wrangler secrets so the Cloud Worker can authenticate.
#
# This script does step 2 + step 3 for all three sizes in sequence,
# pulling the env from the cloud service's canonical manifests. The
# catalog edit (step 1) is a manual one-line PR per size — see
# `../README.md` for the exact diff.
#
# Required env:
#   VASTAI_API_KEY     — vastai_… key with template + endpoint perms
#   PYWORKER_REPO      — git URL of the eliza monorepo (default: elizaOS/eliza)
#   PYWORKER_REF       — pinned commit / branch / tag
#
# Optional env:
#   ELIZA_REPO_ROOT       — path to the eliza monorepo (default: derived from
#                           this script's repository location)
#   SIZES                 — space-separated subset (default: "2b 9b 27b")
#   DRY_RUN               — set to 1 to print commands without executing

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELIZA_REPO_ROOT="${ELIZA_REPO_ROOT:-$(cd "${SCRIPT_DIR}/../../../.." && pwd)}"
MANIFEST_DIR="${ELIZA_REPO_ROOT}/packages/cloud/services/vast-pyworker/manifests"
SIZES="${SIZES:-2b 9b 27b}"
DRY_RUN="${DRY_RUN:-0}"

: "${VASTAI_API_KEY:?Set VASTAI_API_KEY=vastai_…}"
: "${PYWORKER_REPO:=https://github.com/elizaOS/eliza.git}"
: "${PYWORKER_REF:?Set PYWORKER_REF to a pinned commit / branch / tag}"

if [ ! -f "$ELIZA_REPO_ROOT/package.json" ]; then
  echo "[register] eliza checkout not found at $ELIZA_REPO_ROOT" >&2
  echo "[register] set ELIZA_REPO_ROOT to override." >&2
  exit 1
fi
if [ ! -x "$(command -v jq)" ]; then
  echo "[register] this script needs 'jq' for JSON parsing" >&2
  exit 1
fi
if [ ! -x "$(command -v bun)" ]; then
  echo "[register] this script needs 'bun' to run the upsert/provision scripts" >&2
  exit 1
fi

run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '[dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

for size in $SIZES; do
  manifest="${MANIFEST_DIR}/eliza-1-${size}.json"
  if [ ! -f "$manifest" ]; then
    echo "[register] no manifest at $manifest — skipping" >&2
    continue
  fi
  echo "[register] === eliza-1-${size} ==="

  model_repo=$(jq -r '.vast_template_env.MODEL_REPO' "$manifest")
  model_alias=$(jq -r '.vast_template_env.MODEL_ALIAS' "$manifest")
  template_name="eliza-cloud-eliza-1-${size}-gguf"

  # Step 2: upsert Vast template (idempotent).
  template_id_var="VAST_TEMPLATE_ID_$(printf '%s' "$size" | tr '[:lower:]' '[:upper:]')"
  echo "[register] upserting template ${template_name} (model=${model_repo})"
  template_output=$(
    VASTAI_API_KEY="$VASTAI_API_KEY" \
    VAST_TEMPLATE_NAME="$template_name" \
    VAST_RUNTIME=llama \
    ELIZA_VAST_MANIFEST="$manifest" \
    PYWORKER_REPO="$PYWORKER_REPO" \
    PYWORKER_REF="$PYWORKER_REF" \
    MODEL_REPO="$model_repo" \
    MODEL_ALIAS="$model_alias" \
    run bun "${ELIZA_REPO_ROOT}/packages/cloud/scripts/vast/upsert-template.ts"
  )
  echo "$template_output"
  if [ "$DRY_RUN" = "1" ]; then continue; fi

  template_id=$(echo "$template_output" | sed -n 's/.*VAST_TEMPLATE_ID=\([0-9][0-9]*\).*/\1/p' | tail -1)
  if [ -z "${template_id:-}" ]; then
    echo "[register] could not parse template id from upsert output for ${size}" >&2
    continue
  fi
  printf 'export %s=%s\n' "$template_id_var" "$template_id"

  # Step 3: provision endpoint against the template.
  echo "[register] provisioning endpoint for template ${template_id}"
  VASTAI_API_KEY="$VASTAI_API_KEY" \
  VAST_TEMPLATE_ID="$template_id" \
    run bun "${ELIZA_REPO_ROOT}/packages/cloud/scripts/vast/provision-endpoint.ts"
done

cat <<'POSTSTEPS'
[register] Done.

Next manual steps (one-time, per size):
  1. Add a catalog entry per Vast alias in
     packages/cloud/shared/src/lib/models/catalog.ts
     (mirror the existing vast/eliza-1-27b row).
  2. Push wrangler secrets so the Cloud Worker can reach the endpoint:
       wrangler secret put VAST_BASE_URL    # e.g. https://run.vast.ai/route/<endpoint-id>
       wrangler secret put VAST_API_KEY     # endpoint-scoped token
  3. Redeploy the Worker; cloud-side `vast/eliza-1-<size>` requests
     will now route through VastProvider.

Reference docs:
  - packages/cloud/services/vast-pyworker/README.md
  - packages/training/cloud/README.md
POSTSTEPS
