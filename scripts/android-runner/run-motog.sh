#!/usr/bin/env bash
# run-motog.sh — Android arm64 runner: cross-compile the v0.4.0-milady
# llama.cpp fork for arm64-v8a, push the on-device agent bundle plus
# libllama / DFlash llama-server, stage an Eliza-1 GGUF on the device,
# hit /api/health and a 5-prompt
# chat round-trip, then tear down the adb forward.
#
# Designed to run cold against a Moto G7+ class arm64-v8a phone with
# at least 4 GB RAM.
#
# Usage:
#   bash scripts/android-runner/run-motog.sh                  # default end-to-end
#   bash scripts/android-runner/run-motog.sh --skip-build      # reuse libllama
#   bash scripts/android-runner/run-motog.sh --skip-bundle     # reuse pushed bundle
#   bash scripts/android-runner/run-motog.sh --skip-models     # don't push GGUFs
#   bash scripts/android-runner/run-motog.sh --no-chat         # health only
#
# Env knobs (all optional):
#   ANDROID_RUNNER_SERIAL    adb serial (default: first arm64-v8a device)
#   ANDROID_RUNNER_ELIZA1_GGUF   path to an Eliza-1 GGUF
#   ANDROID_RUNNER_REPORT_DIR    override report output dir
#   ANDROID_RUNNER_PACKAGE       override package id (default: ai.milady.milady)
#   ANDROID_RUNNER_PORT          host-side adb-forward port (default: 31337)
#
# Refusal contract:
#   - Refuses if no adb device is connected.
#   - Refuses if the device's ro.product.cpu.abi is not arm64-v8a.
#   - Refuses if a passed Eliza-1 GGUF does not exist.
#   - Refuses on Linux/macOS host hosts only when adb is missing — the
#     cross-compile for arm64-v8a uses zig and runs on any x86_64 / arm64
#     host.

set -euo pipefail

# -- Resolve repo root ---------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

DATE_STAMP="$(date -u +%Y-%m-%d)"
REPORT_DIR="${ANDROID_RUNNER_REPORT_DIR:-${REPO_ROOT}/reports/porting/${DATE_STAMP}}"
REPORT_FILE="${REPORT_DIR}/motog-smoke.md"
TMP_LOG="$(mktemp -t motog-smoke.XXXXXX.log)"
PACKAGE="${ANDROID_RUNNER_PACKAGE:-ai.milady.milady}"
HOST_PORT="${ANDROID_RUNNER_PORT:-31337}"
DEVICE_PORT="${ANDROID_RUNNER_DEVICE_PORT:-31337}"

mkdir -p "${REPORT_DIR}"

# -- Logging helpers -----------------------------------------------------------
log() { printf '[android-runner/motog] %s\n' "$*" | tee -a "${TMP_LOG}"; }
fail() { printf '[android-runner/motog] FAIL: %s\n' "$*" | tee -a "${TMP_LOG}" >&2; exit 1; }

# -- Argument parsing ----------------------------------------------------------
SKIP_BUILD=0
SKIP_BUNDLE=0
SKIP_MODELS=0
NO_CHAT=0
for arg in "$@"; do
  case "${arg}" in
    --skip-build) SKIP_BUILD=1 ;;
    --skip-bundle) SKIP_BUNDLE=1 ;;
    --skip-models) SKIP_MODELS=1 ;;
    --no-chat) NO_CHAT=1 ;;
    -h|--help)
      sed -n '2,32p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) fail "unknown arg: ${arg}" ;;
  esac
done

# -- 1. Host preflight ---------------------------------------------------------
log "preflight: tooling check"
for tool in adb node zig cmake bun git; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    fail "missing tool on host: ${tool}"
  fi
done

# -- 2. Device discovery -------------------------------------------------------
log "preflight: adb device discovery"
DEVICES_OUT="$(adb devices 2>&1 || true)"
ONLINE_SERIALS=$(printf '%s\n' "${DEVICES_OUT}" \
  | awk 'NR>1 && $2=="device" {print $1}')

if [ -z "${ONLINE_SERIALS}" ]; then
  fail "no adb devices online. Connect the Moto G via USB, enable developer options + USB debugging, and authorise this host."
fi

if [ -n "${ANDROID_RUNNER_SERIAL:-}" ]; then
  if ! printf '%s\n' "${ONLINE_SERIALS}" | grep -Fxq "${ANDROID_RUNNER_SERIAL}"; then
    fail "ANDROID_RUNNER_SERIAL=${ANDROID_RUNNER_SERIAL} not in online devices: $(echo "${ONLINE_SERIALS}" | tr '\n' ' ')"
  fi
  SERIAL="${ANDROID_RUNNER_SERIAL}"
else
  # Pick the first arm64-v8a device automatically.
  SERIAL=""
  while IFS= read -r candidate; do
    [ -z "${candidate}" ] && continue
    abi=$(adb -s "${candidate}" shell getprop ro.product.cpu.abi 2>/dev/null | tr -d '\r' || echo unknown)
    if [ "${abi}" = "arm64-v8a" ]; then
      SERIAL="${candidate}"
      break
    fi
  done < <(printf '%s\n' "${ONLINE_SERIALS}")
  if [ -z "${SERIAL}" ]; then
    fail "no arm64-v8a devices online. The kit only supports arm64. ABIs seen: $(while IFS= read -r d; do printf '%s=%s ' "${d}" "$(adb -s "${d}" shell getprop ro.product.cpu.abi 2>/dev/null | tr -d '\r')"; done <<<"${ONLINE_SERIALS}")"
  fi
fi
log "preflight: using serial=${SERIAL}"

DEVICE_ABI=$(adb -s "${SERIAL}" shell getprop ro.product.cpu.abi 2>/dev/null | tr -d '\r' || echo unknown)
DEVICE_MODEL=$(adb -s "${SERIAL}" shell getprop ro.product.model 2>/dev/null | tr -d '\r' || echo unknown)
DEVICE_API=$(adb -s "${SERIAL}" shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r' || echo unknown)
DEVICE_RAM_KB=$(adb -s "${SERIAL}" shell cat /proc/meminfo 2>/dev/null | awk '/MemTotal/ {print $2}' | tr -d '\r' || echo 0)
DEVICE_RAM_GB=$(awk -v kb="${DEVICE_RAM_KB:-0}" 'BEGIN { printf "%.1f", kb/1024/1024 }')

if [ "${DEVICE_ABI}" != "arm64-v8a" ]; then
  fail "device ABI is '${DEVICE_ABI}', not arm64-v8a. The kit refuses non-arm64 phones; for cuttlefish x86_64 use scripts/aosp/smoke-cuttlefish.mjs."
fi

log "preflight: model=${DEVICE_MODEL} abi=${DEVICE_ABI} api=${DEVICE_API} ram=${DEVICE_RAM_GB}GB"

# Eliza-1 mobile needs a 4 GB class device for a useful smoke run; 6 GB+
# is recommended.
if [ -n "${DEVICE_RAM_KB}" ] && [ "${DEVICE_RAM_KB}" -lt $((3500*1024)) ]; then
  log "WARN: device RAM ${DEVICE_RAM_GB}GB is below the 4GB minimum for Eliza-1 mobile. Loading may OOM. Continuing — set ANDROID_RUNNER_FORCE=1 to suppress this hint."
fi

# -- 3. Verify the package is installed ---------------------------------------
PKG_LIST=$(adb -s "${SERIAL}" shell pm list packages "${PACKAGE}" 2>/dev/null | tr -d '\r')
if ! printf '%s\n' "${PKG_LIST}" | grep -Fxq "package:${PACKAGE}"; then
  fail "package ${PACKAGE} is not installed on ${SERIAL}. Sideload the Milady APK first: \`adb install path/to/milady.apk\`."
fi
log "preflight: package ${PACKAGE} installed"

# Many on-device app data ops need root. On a debuggable / userdebug
# build, `adb root` enables it; on a userbuild the agent runs as the
# package uid and we use run-as for file writes. Try root first; if it
# fails, fall back to run-as.
ROOT_AVAILABLE=0
if adb -s "${SERIAL}" root 2>&1 | grep -qiE 'restarting adbd as root|already running as root'; then
  # Wait for adbd reconnect after `adb root`.
  sleep 2 || true
  adb -s "${SERIAL}" wait-for-device 2>/dev/null || true
  if adb -s "${SERIAL}" shell id 2>/dev/null | grep -q 'uid=0'; then
    ROOT_AVAILABLE=1
    log "preflight: adb root succeeded"
  fi
fi
if [ "${ROOT_AVAILABLE}" = "0" ]; then
  log "preflight: adb root unavailable (production build); using run-as ${PACKAGE}"
fi

push_to_app_data() {
  # $1 = host path
  # $2 = device path under the app's private files dir, relative to
  #      /data/data/<pkg>/files/
  local host="$1"
  local rel="$2"
  if [ "${ROOT_AVAILABLE}" = "1" ]; then
    adb -s "${SERIAL}" push "${host}" "/data/data/${PACKAGE}/files/${rel}" >/dev/null
    adb -s "${SERIAL}" shell chown -R u0_a36:u0_a36 "/data/data/${PACKAGE}/files/${rel}" 2>/dev/null || true
  else
    # run-as path: stage to /data/local/tmp first, then run-as cat into
    # the app's private dir.
    local stem
    stem="$(basename "${host}")"
    adb -s "${SERIAL}" push "${host}" "/data/local/tmp/${stem}" >/dev/null
    adb -s "${SERIAL}" shell "run-as ${PACKAGE} sh -c 'mkdir -p \$(dirname files/${rel}) && cat /data/local/tmp/${stem} > files/${rel}'"
    adb -s "${SERIAL}" shell rm -f "/data/local/tmp/${stem}" 2>/dev/null || true
  fi
}

# -- 4. Build / cache libllama for arm64-v8a ----------------------------------
LIB_OUT_DIR="${REPO_ROOT}/.cache/android-runner/arm64-v8a"
mkdir -p "${LIB_OUT_DIR}"

# Use a sentinel file containing the LLAMA_CPP_TAG so a tag-bump busts
# the cache. The compile-libllama.mjs script bakes the same tag into
# its checkout sentinel, so we just mirror it.
LLAMA_CPP_TAG=$(grep -E 'LLAMA_CPP_TAG = ' "${REPO_ROOT}/packages/app-core/scripts/aosp/compile-libllama.mjs" | head -1 | sed 's/.*"\(v[^"]*\)".*/\1/')
SENTINEL="${LIB_OUT_DIR}/.built-${LLAMA_CPP_TAG}"

if [ "${SKIP_BUILD}" = "1" ]; then
  log "build: --skip-build set; expecting prior libllama.so at ${LIB_OUT_DIR}"
elif [ -f "${SENTINEL}" ] && [ -f "${LIB_OUT_DIR}/arm64-v8a/libllama.so" ]; then
  log "build: cached arm64-v8a libllama.so present (tag=${LLAMA_CPP_TAG}); reusing"
else
  log "build: cross-compiling libllama.so for arm64-v8a (tag=${LLAMA_CPP_TAG})"
  rm -rf "${LIB_OUT_DIR}/arm64-v8a"
  node "${REPO_ROOT}/packages/app-core/scripts/aosp/compile-libllama.mjs" \
    --abi arm64-v8a \
    --assets-dir "${LIB_OUT_DIR}" \
    --jobs "$(nproc 2>/dev/null || echo 4)" 2>&1 | tee -a "${TMP_LOG}"
  if [ ! -f "${LIB_OUT_DIR}/arm64-v8a/libllama.so" ] \
    || [ ! -f "${LIB_OUT_DIR}/arm64-v8a/llama-server" ]; then
    fail "compile-libllama.mjs did not produce libllama.so + llama-server in ${LIB_OUT_DIR}/arm64-v8a/"
  fi
  printf '%s\n' "${LLAMA_CPP_TAG}" > "${SENTINEL}"
fi

# Verify the produced libllama.so is actually arm64.
LIB_FILE_INFO=$(file "${LIB_OUT_DIR}/arm64-v8a/libllama.so" 2>/dev/null || echo unknown)
if ! printf '%s' "${LIB_FILE_INFO}" | grep -q 'aarch64'; then
  fail "libllama.so is not aarch64 (file reports: ${LIB_FILE_INFO}). Re-build with --abi arm64-v8a."
fi
log "build: libllama.so OK (${LIB_FILE_INFO})"

# -- 5. Build / locate the agent bundle ---------------------------------------
BUNDLE_DIR="${REPO_ROOT}/packages/agent/dist-mobile"
if [ "${SKIP_BUNDLE}" = "1" ]; then
  log "bundle: --skip-bundle set; expecting prior agent-bundle.js at ${BUNDLE_DIR}"
  if [ ! -f "${BUNDLE_DIR}/agent-bundle.js" ]; then
    fail "agent-bundle.js missing at ${BUNDLE_DIR}; run \`bun run --cwd packages/agent build:mobile\` or drop --skip-bundle"
  fi
elif [ -f "${BUNDLE_DIR}/agent-bundle.js" ] && [ "${ANDROID_RUNNER_FORCE_REBUILD:-0}" != "1" ]; then
  log "bundle: reusing existing agent-bundle.js ($(du -h "${BUNDLE_DIR}/agent-bundle.js" | awk '{print $1}'))"
else
  log "bundle: building mobile bundle via packages/agent build:mobile"
  bun run --cwd packages/agent build:mobile 2>&1 | tee -a "${TMP_LOG}"
fi

BUNDLE_MD5=$(md5sum "${BUNDLE_DIR}/agent-bundle.js" | awk '{print $1}')
log "bundle: md5=${BUNDLE_MD5}"

# -- 6. Resolve Eliza-1 GGUF ---------------------------------------------------
ELIZA1_GGUF="${ANDROID_RUNNER_ELIZA1_GGUF:-}"

if [ "${SKIP_MODELS}" = "0" ]; then
  if [ -z "${ELIZA1_GGUF}" ]; then
    # Try common cache locations.
    while IFS= read -r found; do
      if [ -n "${found}" ] && [ -f "${found}" ]; then
        ELIZA1_GGUF="${found}"
        break
      fi
    done < <(
      {
        find "${HOME}/.cache/eliza/local-inference/models" -maxdepth 5 -type f -iname '*eliza-1-mobile*.gguf' 2>/dev/null
        find "${HOME}/.eliza/local-inference/models" -maxdepth 5 -type f -iname '*eliza-1-mobile*.gguf' 2>/dev/null
        find "${HOME}/.milady/local-inference/models" -maxdepth 5 -type f -iname '*eliza-1-mobile*.gguf' 2>/dev/null
      } | head -1
    )
  fi
  if [ -z "${ELIZA1_GGUF}" ]; then
    log "WARN: Eliza-1 mobile GGUF not found."
    log "      Set ANDROID_RUNNER_ELIZA1_GGUF or download via:"
    log "        hf download elizalabs/eliza-1-mobile-1_7b text/eliza-1-mobile-1_7b-32k.gguf --local-dir ~/.cache/eliza/local-inference/models/eliza-1-mobile-1_7b"
    SKIP_MODELS=1
  else
    log "models: eliza1=${ELIZA1_GGUF} ($(du -h "${ELIZA1_GGUF}" | awk '{print $1}'))"
  fi
fi

# -- 7. Stop the agent service before pushing files ---------------------------
log "device: stopping ${PACKAGE}"
adb -s "${SERIAL}" shell am force-stop "${PACKAGE}" 2>/dev/null || true
adb -s "${SERIAL}" shell pkill -9 -f "files/agent/" 2>/dev/null || true
sleep 2 || true

# -- 8. Push agent bundle + libllama family + model ---------------------------
log "device: pushing agent bundle"
push_to_app_data "${BUNDLE_DIR}/agent-bundle.js" "agent/agent-bundle.js"
for asset in pglite.wasm initdb.wasm pglite.data plugins-manifest.json; do
  if [ -f "${BUNDLE_DIR}/${asset}" ]; then
    push_to_app_data "${BUNDLE_DIR}/${asset}" "agent/${asset}"
  fi
done

log "device: pushing arm64-v8a libllama family + DFlash llama-server"
for libfile in libllama.so libllama.so.0 libggml.so libggml.so.0 \
               libggml-base.so libggml-base.so.0 libggml-cpu.so libggml-cpu.so.0 \
               libeliza-llama-shim.so llama-server; do
  src="${LIB_OUT_DIR}/arm64-v8a/${libfile}"
  if [ -f "${src}" ]; then
    push_to_app_data "${src}" "agent/arm64-v8a/${libfile}"
  fi
done
adb -s "${SERIAL}" shell "run-as ${PACKAGE} chmod 755 files/agent/arm64-v8a/llama-server 2>/dev/null || true"

if [ "${SKIP_MODELS}" = "0" ] && [ -n "${ELIZA1_GGUF}" ]; then
  log "device: pushing Eliza-1 model (this may take several minutes over USB)"
  push_to_app_data "${ELIZA1_GGUF}" "agent/models/$(basename "${ELIZA1_GGUF}")"
fi

# -- 9. Restart the agent service ---------------------------------------------
log "device: starting ElizaAgentService"
adb -s "${SERIAL}" shell am start-foreground-service \
  -n "${PACKAGE}/.ElizaAgentService" 2>&1 | tee -a "${TMP_LOG}" || \
  adb -s "${SERIAL}" shell monkey -p "${PACKAGE}" \
    -c android.intent.category.LAUNCHER 1 2>&1 | tee -a "${TMP_LOG}"

# -- 10. adb forward + /api/health --------------------------------------------
adb -s "${SERIAL}" forward "tcp:${HOST_PORT}" "tcp:${DEVICE_PORT}" >/dev/null
log "forward: tcp:${HOST_PORT} -> tcp:${DEVICE_PORT}"

cleanup() {
  log "cleanup: removing adb forward"
  adb -s "${SERIAL}" forward --remove "tcp:${HOST_PORT}" 2>/dev/null || true
}
trap cleanup EXIT

HEALTH_DEADLINE=$(( $(date +%s) + 600 ))
HEALTH_OK=0
HEALTH_BODY=""
log "health: polling http://127.0.0.1:${HOST_PORT}/api/health (up to 10 min)"
while [ "$(date +%s)" -lt "${HEALTH_DEADLINE}" ]; do
  if HEALTH_BODY=$(curl -sf --max-time 3 "http://127.0.0.1:${HOST_PORT}/api/health" 2>/dev/null); then
    HEALTH_OK=1
    break
  fi
  sleep 5
done

if [ "${HEALTH_OK}" = "0" ]; then
  log "health: did not respond within 600s. Last 30 lines of agent.log:"
  adb -s "${SERIAL}" shell "run-as ${PACKAGE} tail -30 files/agent/agent.log" 2>&1 | tee -a "${TMP_LOG}" || true
  CHAT_STATUS="SKIP"
  CHAT_DETAIL="health endpoint never responded; chat skipped"
else
  log "health: PASS — body=${HEALTH_BODY}"
fi

# -- 11. 5-prompt chat round-trip --------------------------------------------
CHAT_STATUS="${CHAT_STATUS:-SKIP}"
CHAT_DETAIL="${CHAT_DETAIL:-not run}"
CHAT_REPLIES=""
CHAT_TOTAL_MS=0

if [ "${HEALTH_OK}" = "1" ] && [ "${NO_CHAT}" = "0" ]; then
  log "chat: 5-prompt round-trip"
  PROMPTS=(
    "hi, who are you?"
    "what's 2 + 2?"
    "name a planet."
    "tell me a one-line joke."
    "say goodbye in three words."
  )
  CHAT_FAILS=0
  for i in "${!PROMPTS[@]}"; do
    pidx=$((i + 1))
    p="${PROMPTS[$i]}"
    log "chat: prompt ${pidx}/5: ${p}"
    started=$(date +%s%3N)
    body="$(jq -nc --arg p "${p}" '{messages:[{role:"user",content:$p}], stream:false, max_tokens:48, model:"eliza-1-mobile-1_7b"}' 2>/dev/null \
        || printf '{"messages":[{"role":"user","content":"%s"}],"stream":false,"max_tokens":48,"model":"eliza-1-mobile-1_7b"}' "${p}")"
    out=$(curl -sf --max-time 1800 \
        -H 'Content-Type: application/json' \
        -X POST \
        --data-raw "${body}" \
        "http://127.0.0.1:${HOST_PORT}/v1/chat/completions" 2>&1 || echo "__CURL_FAIL__")
    ended=$(date +%s%3N)
    dt=$((ended - started))
    CHAT_TOTAL_MS=$((CHAT_TOTAL_MS + dt))
    if [ "${out}" = "__CURL_FAIL__" ] || [ -z "${out}" ]; then
      log "chat: ${pidx}/5 FAIL (no response in ${dt}ms)"
      CHAT_FAILS=$((CHAT_FAILS + 1))
      CHAT_REPLIES+="${pidx}. ${p} -> [no response in ${dt}ms]"$'\n'
      continue
    fi
    reply=$(printf '%s' "${out}" \
      | jq -r '.choices[0].message.content // .choices[0].delta.content // .text // empty' 2>/dev/null \
      | head -c 400)
    if [ -z "${reply}" ]; then
      log "chat: ${pidx}/5 FAIL (empty content; body head: $(printf '%s' "${out}" | head -c 200))"
      CHAT_FAILS=$((CHAT_FAILS + 1))
      CHAT_REPLIES+="${pidx}. ${p} -> [empty response in ${dt}ms]"$'\n'
    else
      log "chat: ${pidx}/5 OK in ${dt}ms — ${reply}"
      CHAT_REPLIES+="${pidx}. ${p} -> ${reply} (${dt}ms)"$'\n'
    fi
  done
  if [ "${CHAT_FAILS}" = "0" ]; then
    CHAT_STATUS="PASS"
    CHAT_DETAIL="5/5 prompts produced non-empty replies in $((CHAT_TOTAL_MS/1000))s wall-clock"
  else
    CHAT_STATUS="FAIL"
    CHAT_DETAIL="${CHAT_FAILS}/5 prompts failed; total wall-clock $((CHAT_TOTAL_MS/1000))s"
  fi
elif [ "${NO_CHAT}" = "1" ]; then
  CHAT_STATUS="SKIP"
  CHAT_DETAIL="--no-chat passed"
fi

# -- 12. Capture device-side log tail ----------------------------------------
DEVICE_LOG_TAIL=$(adb -s "${SERIAL}" shell "run-as ${PACKAGE} tail -50 files/agent/agent.log 2>/dev/null" 2>/dev/null \
  || adb -s "${SERIAL}" shell "tail -50 /data/data/${PACKAGE}/files/agent/agent.log 2>/dev/null" 2>/dev/null \
  || echo "(could not read agent.log)")

# -- 13. Write report --------------------------------------------------------
{
  printf '# Moto G arm64 smoke — %s\n\n' "${DATE_STAMP}"
  printf 'Run by `scripts/android-runner/run-motog.sh` on host `%s` (%s).\n\n' \
    "$(hostname 2>/dev/null || echo unknown)" "$(uname -srm)"
  printf '## Device\n\n'
  printf -- '- Serial: `%s`\n' "${SERIAL}"
  printf -- '- Model: `%s`\n' "${DEVICE_MODEL}"
  printf -- '- ABI: `%s`\n' "${DEVICE_ABI}"
  printf -- '- API level: `%s`\n' "${DEVICE_API}"
  printf -- '- RAM: `%s GB`\n' "${DEVICE_RAM_GB}"
  printf -- '- Package: `%s`\n\n' "${PACKAGE}"

  printf '## Toolchain\n\n'
  printf -- '- llama.cpp pin: `%s`\n' "${LLAMA_CPP_TAG}"
  printf -- '- libllama.so: `%s`\n' "$(file "${LIB_OUT_DIR}/arm64-v8a/libllama.so" 2>/dev/null || echo missing)"
  printf -- '- agent-bundle.js md5: `%s`\n\n' "${BUNDLE_MD5}"

  printf '## Health\n\n'
  if [ "${HEALTH_OK}" = "1" ]; then
    printf -- '- Status: PASS\n'
    printf -- '- Body: `%s`\n\n' "${HEALTH_BODY}"
  else
    printf -- '- Status: FAIL\n'
    printf -- '- Detail: `/api/health` did not respond within 600 s.\n\n'
  fi

  printf '## Chat round-trip (5 prompts, Eliza-1)\n\n'
  printf -- '- Status: %s\n' "${CHAT_STATUS}"
  printf -- '- Detail: %s\n\n' "${CHAT_DETAIL}"
  if [ -n "${CHAT_REPLIES}" ]; then
    printf '```\n%s```\n\n' "${CHAT_REPLIES}"
  fi

  printf '## Device-side agent.log tail\n\n'
  printf '```\n%s\n```\n\n' "${DEVICE_LOG_TAIL}"

  printf '## Host-side runner log tail\n\n'
  printf '```\n'
  tail -c 4096 "${TMP_LOG}"
  printf '\n```\n'
} > "${REPORT_FILE}"

log "report: ${REPORT_FILE}"

# -- 14. Exit code reflects worst sub-step ------------------------------------
EXIT=0
if [ "${HEALTH_OK}" = "0" ]; then
  EXIT=1
elif [ "${CHAT_STATUS}" = "FAIL" ]; then
  EXIT=2
fi
exit ${EXIT}
