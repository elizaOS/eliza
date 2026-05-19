#!/bin/sh

set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
RUNTIME="${ELIZAOS_MILADY_APP_STAGE:-${ROOT}/tails/config/chroot_local-includes/usr/share/elizaos/milady-app}"
BUN="${RUNTIME}/bin/bun"
ENTRY="${RUNTIME}/Resources/app/eliza-dist/entry.js"
PORT="${ELIZAOS_RUNTIME_SMOKE_PORT:-31349}"
HOME_DIR="$(mktemp -d /tmp/elizaos-runtime-smoke.XXXXXX)"
LOG_FILE="${HOME_DIR}/server.log"

cleanup() {
    if [ "${PID:-}" ]; then
        kill "${PID}" 2>/dev/null || true
        wait "${PID}" 2>/dev/null || true
    fi
    rm -rf "${HOME_DIR}"
}
trap cleanup EXIT INT TERM

if [ ! -x "${BUN}" ]; then
    echo "missing bundled Bun: ${BUN}" >&2
    exit 1
fi

if [ ! -f "${ENTRY}" ]; then
    echo "missing runtime entry: ${ENTRY}" >&2
    exit 1
fi

export HOME="${HOME_DIR}"
export PATH="${RUNTIME}/bin:/usr/bin:/bin:/usr/local/bin"
export NODE_PATH="${RUNTIME}/Resources/app/eliza-dist/node_modules"
export ELIZA_STATE_DIR="${HOME_DIR}/.eliza"
export MILADY_STATE_DIR="${ELIZA_STATE_DIR}"
export XDG_CONFIG_HOME="${ELIZA_STATE_DIR}/xdg-config"
export XDG_CACHE_HOME="${ELIZA_STATE_DIR}/xdg-cache"
export XDG_DATA_HOME="${ELIZA_STATE_DIR}/xdg-data"
export XDG_STATE_HOME="${ELIZA_STATE_DIR}/xdg-state"
export ELIZAOS_LIVE_EMBEDDING_FALLBACK=1
export ELIZA_DISABLE_PROACTIVE_AGENT=1
export ELIZAOS_LIVE_USB=1
export ELIZAOS_PRIVACY_MODE=1
export ELIZA_API_PORT="${PORT}"
export ELIZA_PORT="${PORT}"
export ELIZA_API_BIND=127.0.0.1
export ELIZA_API_STRICT_PORT=1
export ELIZA_DESKTOP_API_BASE="http://127.0.0.1:${PORT}"
export NO_PROXY="127.0.0.1,localhost"

cd "${RUNTIME}/Resources/app/eliza-dist"
"${BUN}" entry.js start >"${LOG_FILE}" 2>&1 &
PID="$!"

ready=0
i=0
while [ "${i}" -lt 90 ]; do
    if curl --noproxy '*' -fsS "http://127.0.0.1:${PORT}/api/auth/status" >/dev/null 2>&1; then
        ready=1
        break
    fi
    if ! kill -0 "${PID}" 2>/dev/null; then
        break
    fi
    i=$((i + 1))
    sleep 1
done

if [ "${ready}" != 1 ]; then
    echo "runtime API did not become ready" >&2
    tail -160 "${LOG_FILE}" >&2 || true
    exit 1
fi

check_endpoint() {
    endpoint="$1"
    expected="$2"
    body="${HOME_DIR}/body"
    code="$(
        curl --noproxy '*' -sS -o "${body}" -w '%{http_code}' \
            "http://127.0.0.1:${PORT}${endpoint}" || true
    )"
    if [ "${code}" != "${expected}" ]; then
        echo "${endpoint}: expected HTTP ${expected}, got ${code}" >&2
        cat "${body}" >&2 || true
        tail -160 "${LOG_FILE}" >&2 || true
        exit 1
    fi
}

check_endpoint /api/health 200
grep -q '"ready":true' "${HOME_DIR}/body"
grep -q '"failed":0' "${HOME_DIR}/body"

check_endpoint /api/auth/status 200
check_endpoint /api/onboarding/status 200
check_endpoint /api/onboarding/options 200
grep -q '"providers"' "${HOME_DIR}/body"

check_endpoint /api/logs 200

if grep -q 'Request handler failed' "${LOG_FILE}"; then
    echo "runtime request handler logged a failure" >&2
    grep 'Request handler failed' "${LOG_FILE}" >&2
    exit 1
fi

echo "runtime API smoke passed"
