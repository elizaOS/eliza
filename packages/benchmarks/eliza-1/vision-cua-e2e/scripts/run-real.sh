#!/usr/bin/env bash
#
# Real-mode launcher for the eliza-1 vision + CUA E2E harness.
#
# Wires the harness against the live runtime stack (real capture, real OCR,
# real IMAGE_DESCRIPTION provider, real click). Designed to be safe by default:
# the click goes into a controlled X11 helper window we spawn here (and tear
# down on exit), never the user's live desktop.
#
# Preconditions checked before launch:
#   1. A desktop is reachable (DISPLAY or WAYLAND_DISPLAY set).
#   2. An IMAGE_DESCRIPTION provider is loadable — either a cloud key
#      (ANTHROPIC_API_KEY / OPENAI_API_KEY) or a local-inference bundle
#      under ~/.eliza/local-inference/models/ that ships an mmproj.
#   3. A controllable helper window binary (`xeyes` by default) is on PATH
#      so the click target can be clamped to a harmless on-screen rect.
#
# Trace JSON lands in reports/eliza1-vision-cua-e2e-real-<timestamp>.json.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PKG_DIR="$( cd "${SCRIPT_DIR}/.." && pwd )"
REPORT_DIR="${PKG_DIR}/reports"
mkdir -p "${REPORT_DIR}"

# ── 1. Display probe ────────────────────────────────────────────────────────
if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
  echo "[run-real] FATAL: no DISPLAY / WAYLAND_DISPLAY — host is headless." >&2
  echo "[run-real] Real-mode capture requires a reachable desktop session." >&2
  exit 64
fi

# ── 2. IMAGE_DESCRIPTION provider probe ─────────────────────────────────────
HAS_PROVIDER=0
PROVIDER_NOTE=""

if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  HAS_PROVIDER=1
  PROVIDER_NOTE="ANTHROPIC_API_KEY"
elif [[ -n "${OPENAI_API_KEY:-}" ]]; then
  HAS_PROVIDER=1
  PROVIDER_NOTE="OPENAI_API_KEY (note: not yet wired by the harness)"
else
  # Look for a local-inference bundle that ships a *vision* mmproj.
  # Note: ASR projectors (asr/eliza-1-asr-mmproj.gguf) are NOT vision —
  # restrict the probe to the vision/ subdirectory of each bundle.
  for bundle_root in "${HOME}/.milady/local-inference/models" "${HOME}/.eliza/local-inference/models"; do
    if [[ -d "${bundle_root}" ]]; then
      vision_mmproj_count=$(find "${bundle_root}" -type f -path '*/vision/*' \
        \( -name '*mmproj*.gguf' -o -name 'mmproj*.gguf' \) 2>/dev/null | wc -l)
      if [[ "${vision_mmproj_count}" -gt 0 ]]; then
        HAS_PROVIDER=1
        PROVIDER_NOTE="local-inference vision bundle under ${bundle_root}"
        break
      fi
    fi
  done
fi

if [[ "${HAS_PROVIDER}" -eq 0 ]]; then
  cat >&2 <<'EOF'
[run-real] FATAL: no IMAGE_DESCRIPTION provider available.
[run-real] Set one of:
[run-real]   - ANTHROPIC_API_KEY  (cloud Anthropic IMAGE_DESCRIPTION)
[run-real]   - OPENAI_API_KEY     (cloud OpenAI IMAGE_DESCRIPTION — pending)
[run-real]   - install an eliza-1 bundle under ~/.eliza/local-inference/models/
[run-real]     that ships a vision/*mmproj*.gguf (e.g. eliza-1-2b.bundle).
EOF
  exit 65
fi

echo "[run-real] desktop: DISPLAY='${DISPLAY:-}' WAYLAND_DISPLAY='${WAYLAND_DISPLAY:-}'"
echo "[run-real] vision provider: ${PROVIDER_NOTE}"

# ── 3. Controlled helper window ─────────────────────────────────────────────
HELPER_BIN="${ELIZA_VISION_CUA_E2E_CONTROLLED_WINDOW_BINARY:-xeyes}"
HELPER_PID=""

if ! command -v "${HELPER_BIN}" >/dev/null 2>&1; then
  echo "[run-real] WARNING: helper binary '${HELPER_BIN}' not found on PATH." >&2
  echo "[run-real] Falling back to noop-click mode (clicks will be recorded but never dispatched)." >&2
  export ELIZA_VISION_CUA_E2E_NO_CONTROLLED_WINDOW=1
else
  # Spawn the helper. Use setsid so we own the session and can kill it cleanly.
  "${HELPER_BIN}" >/dev/null 2>&1 &
  HELPER_PID=$!
  echo "[run-real] spawned controlled helper '${HELPER_BIN}' pid=${HELPER_PID}"
fi

cleanup() {
  local rc=$?
  if [[ -n "${HELPER_PID}" ]] && kill -0 "${HELPER_PID}" 2>/dev/null; then
    kill -TERM "${HELPER_PID}" 2>/dev/null || true
    sleep 0.1
    kill -KILL "${HELPER_PID}" 2>/dev/null || true
    echo "[run-real] killed helper pid=${HELPER_PID}"
  fi
  exit "${rc}"
}
trap cleanup EXIT INT TERM

# ── 4. Run the harness ──────────────────────────────────────────────────────
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
REPORT_PATH="${REPORT_DIR}/eliza1-vision-cua-e2e-real-${TIMESTAMP}.json"

export ELIZA_VISION_CUA_E2E_REAL=1
export ELIZA_VISION_CUA_E2E_REPORT_PATH="${REPORT_PATH}"

echo "[run-real] launching harness; trace will land at ${REPORT_PATH}"
cd "${PKG_DIR}"
bun run vitest run pipeline.e2e.test.ts
