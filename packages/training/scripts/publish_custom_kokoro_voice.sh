#!/usr/bin/env bash
# publish_custom_kokoro_voice.sh — stage a fine-tuned Kokoro voice into a
# per-tier Eliza-1 bundle.
#
# Sibling to publish_all_eliza1.sh. The full publish orchestrator
# (scripts/publish/orchestrator.py) drives the per-tier upload; this
# script's only job is to copy a finished voice bundle (the output of
# scripts/kokoro/package_voice_for_release.py) into
# <bundles-root>/<tier>/tts/<voice-name>/ before the orchestrator runs, and
# to verify the gate report before the copy.
#
# It does NOT edit voice-presets.ts. That is intentionally a code-review
# step — the manifest fragment under <release-dir>/manifest-fragment.json
# is the artifact a reviewer reads to decide what to merge.
#
# Usage:
#   scripts/publish_custom_kokoro_voice.sh \
#       --release-dir /tmp/kokoro-runs/my_voice/release/my_voice \
#       --bundles-root ./bundles \
#       --tier 0_8b
#
#   # Skip the eval gate (requires a written justification per AGENTS.md §6):
#   scripts/publish_custom_kokoro_voice.sh \
#       --release-dir ./release/my_voice \
#       --bundles-root ./bundles \
#       --tier 9b \
#       --allow-gate-fail "tracked under <issue/PR url>"
#
# Tiers must match the Eliza-1 catalog set: 0_8b 2b 4b 9b 27b.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TRAINING_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Keep in sync with `ELIZA_1_TIER_IDS` at
# `packages/shared/src/local-inference/catalog.ts` and with the manifest
# module at `packages/training/scripts/manifest/eliza1_manifest.py:38-46`.
# R7 §"side bugs" flagged the prior `4b` omission as a publish-blocking bug.
readonly VALID_TIERS=("0_8b" "2b" "4b" "9b" "27b")

RELEASE_DIR=""
BUNDLES_ROOT=""
TIER=""
ALLOW_GATE_FAIL=""
DRY_RUN=0

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}"
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release-dir) RELEASE_DIR="$2"; shift 2 ;;
    --bundles-root) BUNDLES_ROOT="$2"; shift 2 ;;
    --tier) TIER="$2"; shift 2 ;;
    --allow-gate-fail) ALLOW_GATE_FAIL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

if [ -z "$RELEASE_DIR" ] || [ -z "$BUNDLES_ROOT" ] || [ -z "$TIER" ]; then
  echo "--release-dir, --bundles-root, and --tier are required" >&2
  usage
fi

# Tier whitelist match. Shell `[[ in array ]]` is fragile; use a loop.
TIER_OK=0
for t in "${VALID_TIERS[@]}"; do
  if [ "$t" = "$TIER" ]; then TIER_OK=1; break; fi
done
if [ "$TIER_OK" -eq 0 ]; then
  echo "unknown tier: $TIER (valid: ${VALID_TIERS[*]})" >&2
  exit 2
fi

if [ ! -d "$RELEASE_DIR" ]; then
  echo "--release-dir does not exist: $RELEASE_DIR" >&2
  exit 2
fi

# Required artifacts. package_voice_for_release.py produces all five.
REQUIRED=(voice.bin kokoro.onnx voice-preset.json eval.json manifest-fragment.json)
MISSING=()
for f in "${REQUIRED[@]}"; do
  if [ ! -f "$RELEASE_DIR/$f" ]; then
    MISSING+=("$f")
  fi
done
if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "release bundle missing required artifacts: ${MISSING[*]}" >&2
  echo "(produced by packages/training/scripts/kokoro/package_voice_for_release.py)" >&2
  exit 2
fi

# Eval gate check. eval.json carries gateResult.passed = true|false.
EVAL_JSON="$RELEASE_DIR/eval.json"
PASSED=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('gateResult', {}).get('passed', False))" "$EVAL_JSON")
if [ "$PASSED" != "True" ]; then
  if [ -n "$ALLOW_GATE_FAIL" ]; then
    echo "WARNING: eval gates did NOT pass; proceeding under --allow-gate-fail."
    echo "Justification: $ALLOW_GATE_FAIL"
  else
    echo "eval gates did not pass for $RELEASE_DIR" >&2
    echo "see $EVAL_JSON; pass --allow-gate-fail '<reason>' to override" >&2
    exit 3
  fi
fi

# Derive the voice id from the manifest fragment so we never trust the
# directory name implicitly.
VOICE_NAME=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['voice']['id'])" "$RELEASE_DIR/manifest-fragment.json")
if [ -z "$VOICE_NAME" ]; then
  echo "manifest-fragment.json did not declare a voice.id" >&2
  exit 3
fi

DEST="$BUNDLES_ROOT/$TIER/tts/$VOICE_NAME"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] would stage $RELEASE_DIR → $DEST"
  exit 0
fi

mkdir -p "$DEST"
cp -p "$RELEASE_DIR/voice.bin" "$DEST/$VOICE_NAME.bin"
cp -p "$RELEASE_DIR/kokoro.onnx" "$DEST/kokoro.onnx"
cp -p "$RELEASE_DIR/voice-preset.json" "$DEST/voice-preset.json"
cp -p "$RELEASE_DIR/manifest-fragment.json" "$DEST/manifest-fragment.json"
cp -p "$RELEASE_DIR/eval.json" "$DEST/eval.json"

# Append a new row to `VOICE_MODEL_VERSIONS` (machine twin) and a matching
# H3 to `models/voice/CHANGELOG.md` (human-readable). The helper is
# idempotent — re-running with the same (id, version) is a no-op.
#
# Inputs are derived from manifest-fragment.json + voice-preset.json so the
# helper sees exactly what's been staged into the bundle. We default the id
# to `kokoro` because this script is kokoro-specific; sub-model ids for the
# other publish flows wire in their own helpers separately.
APPEND_HELPER="${TRAINING_ROOT}/scripts/append_voice_model_version.py"
if [ -x "$APPEND_HELPER" ] || command -v python3 >/dev/null; then
  VERSION=$(python3 -c "import json,sys; m=json.load(open(sys.argv[1])); print(m['voice'].get('version','0.1.0'))" "$RELEASE_DIR/manifest-fragment.json")
  PARENT_VERSION=$(python3 -c "import json,sys; m=json.load(open(sys.argv[1])); print(m['voice'].get('parentVersion',''))" "$RELEASE_DIR/manifest-fragment.json")
  VOICE_BIN_SHA=$(python3 -c "import json,sys; m=json.load(open(sys.argv[1])); print(m.get('blob',{}).get('sha256',''))" "$RELEASE_DIR/voice-preset.json")
  VOICE_BIN_SIZE=$(python3 -c "import json,sys; m=json.load(open(sys.argv[1])); print(m.get('blob',{}).get('sizeBytes','0'))" "$RELEASE_DIR/voice-preset.json")
  VOICE_BIN_FILE=$(python3 -c "import json,sys; m=json.load(open(sys.argv[1])); print(m.get('blob',{}).get('filename','voice.bin'))" "$RELEASE_DIR/voice-preset.json")
  HF_REPO=$(python3 -c "import json,sys; m=json.load(open(sys.argv[1])); print(m['voice'].get('hfRepo','elizalabs/eliza-1'))" "$RELEASE_DIR/manifest-fragment.json")
  HF_REV=$(python3 -c "import json,sys; m=json.load(open(sys.argv[1])); print(m['voice'].get('hfRevision','main'))" "$RELEASE_DIR/manifest-fragment.json")
  CHANGELOG_ENTRY=$(python3 -c "import json,sys; m=json.load(open(sys.argv[1])); print(m['voice'].get('changelogEntry', f\"Kokoro same clone v{m['voice'].get('version','?')}.\"))" "$RELEASE_DIR/manifest-fragment.json")

  EXTRA_FLAGS=()
  if [ -n "$PARENT_VERSION" ]; then
    EXTRA_FLAGS+=("--parent-version" "$PARENT_VERSION" "--net-improvement" "true")
  fi
  if [ -n "$VOICE_BIN_SHA" ]; then
    EXTRA_FLAGS+=("--asset" "${VOICE_BIN_FILE}:${VOICE_BIN_SHA}:${VOICE_BIN_SIZE}:fp16")
  fi

  python3 "$APPEND_HELPER" \
    --id kokoro \
    --version "$VERSION" \
    --hf-repo "$HF_REPO" \
    --hf-revision "$HF_REV" \
    --min-bundle "0.0.0" \
    --changelog-entry "$CHANGELOG_ENTRY" \
    --append-changelog \
    "${EXTRA_FLAGS[@]}" \
    || echo "WARNING: append_voice_model_version.py failed; review manually." >&2
fi

cat <<EOF

Staged voice "$VOICE_NAME" into $DEST.

Next steps:
  1. Append the \`voice\` block from \`$DEST/manifest-fragment.json\` to
     packages/app-core/src/services/local-inference/voice/kokoro/voice-presets.ts
     (code-review step — this script intentionally does not edit it).
  2. Re-run packages/training/scripts/publish_all_eliza1.sh \\
       --bundles-root "$BUNDLES_ROOT" --filter-tier "$TIER"

See docs/eliza-1-kokoro-finetune.md for the full operator guide.
EOF
