#!/bin/sh
set -eu

PORT="${ELIZA_API_PORT:-31337}"
export ELIZA_STATE_DIR="${ELIZA_STATE_DIR:-/var/lib/elizaos}"
AGENT_RUNTIME_LOG="${ELIZA_AGENT_RUNTIME_LOG:-/var/log/elizaos/agent-runtime.log}"
ARCH="$(dpkg --print-architecture 2>/dev/null || true)"
AGENT_RUNTIME="${ELIZA_AGENT_RUNTIME:-auto}"

emit_marker() {
    echo "$*"
    echo "$*" >/dev/kmsg 2>/dev/null || true
    echo "$*" >/dev/ttyS0 2>/dev/null || true
}

dump_runtime_log_tail() {
    [ -f "${AGENT_RUNTIME_LOG}" ] || return 0
    tail -n 120 "${AGENT_RUNTIME_LOG}" 2>/dev/null | while IFS= read -r LINE; do
        echo "${LINE}"
        echo "${LINE}" >/dev/ttyS0 2>/dev/null || true
    done
}

run_agent_command() {
    RUNTIME="$1"
    shift
    emit_marker "elizaos-agent-entrypoint runtime=${RUNTIME} path=$1"
    mkdir -p "$(dirname "${AGENT_RUNTIME_LOG}")" 2>/dev/null || true
    if ! touch "${AGENT_RUNTIME_LOG}" 2>/dev/null; then
        AGENT_RUNTIME_LOG="${ELIZA_STATE_DIR}/agent-runtime.log"
        touch "${AGENT_RUNTIME_LOG}" 2>/dev/null || true
    fi
    set +e
    "$@" >>"${AGENT_RUNTIME_LOG}" 2>&1
    RC="$?"
    set -e
    emit_marker "elizaos-agent-exited runtime=${RUNTIME} rc=${RC}"
    if [ "${RC}" -ne 0 ]; then
        dump_runtime_log_tail
    fi
    exit "${RC}"
}

run_node_agent_bundle() {
    if command -v node >/dev/null 2>&1 && [ -f /opt/elizaos/app/agent-bundle.js ]; then
        run_agent_command node-agent-bundle node /opt/elizaos/app/agent-bundle.js serve --headless --port="${PORT}"
    fi
}

# riscv64 still stages Bun for provenance and future use, but the current
# no-JIT Bun artifact is not reliable for the full agent entrypoint. Prefer
# Debian nodejs for the live service so /api/health can come up for the kiosk.
if [ "${AGENT_RUNTIME}" = "node-agent-bundle" ] || [ "${ARCH}" = "riscv64" ]; then
    run_node_agent_bundle
fi

# Prefer the self-contained desktop runtime: the Electrobun bundle ships
# eliza-dist with the full node_modules tree (1072 packages incl. pglite,
# node-llama-cpp, onnxruntime) baked in. The bare agent-bundle.js is NOT
# self-contained — it tries to install those deps at runtime, which fills the
# live image's tmpfs overlay (ENOSPC) so the agent never binds the port. Run
# from eliza-dist so node_modules resolves locally with zero runtime install.
ELIZA_DIST=/opt/elizaos/app/Resources/app/eliza-dist
if [ -x /opt/elizaos/bin/bun ] && [ -f "${ELIZA_DIST}/index.js" ]; then
    cd "${ELIZA_DIST}"
    run_agent_command bun-eliza-dist /opt/elizaos/bin/bun "${ELIZA_DIST}/index.js" serve --headless --port="${PORT}"
fi

if [ -x /opt/elizaos/bin/elizaos ]; then
    run_agent_command elizaos-cli /opt/elizaos/bin/elizaos serve --headless --port="${PORT}"
fi

if [ -x /opt/elizaos/bin/bun ] && [ -f /opt/elizaos/app/agent-bundle.js ]; then
    run_agent_command bun-agent-bundle /opt/elizaos/bin/bun /opt/elizaos/app/agent-bundle.js serve --headless --port="${PORT}"
fi

if [ -x /opt/elizaos/bin/bun ] && [ -f /opt/elizaos/app/server.js ]; then
    run_agent_command bun-server /opt/elizaos/bin/bun /opt/elizaos/app/server.js --headless --port="${PORT}"
fi

emit_marker "elizaos-agent-exited runtime=missing-payload rc=127"
echo "elizaos agent payload missing: expected /opt/elizaos/bin/elizaos or bun plus agent-bundle.js" >&2
exit 127
