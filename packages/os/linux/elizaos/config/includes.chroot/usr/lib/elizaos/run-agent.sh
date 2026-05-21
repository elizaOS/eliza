#!/bin/sh
set -eu

PORT="${ELIZA_API_PORT:-31337}"
export ELIZA_STATE_DIR="${ELIZA_STATE_DIR:-/var/lib/elizaos}"

if [ -x /opt/elizaos/bin/elizaos ]; then
    exec /opt/elizaos/bin/elizaos serve --headless --port="${PORT}"
fi

if [ -x /opt/elizaos/bin/bun ] && [ -f /opt/elizaos/app/agent-bundle.js ]; then
    exec /opt/elizaos/bin/bun /opt/elizaos/app/agent-bundle.js serve --headless --port="${PORT}"
fi

if [ -x /opt/elizaos/bin/bun ] && [ -f /opt/elizaos/app/server.js ]; then
    exec /opt/elizaos/bin/bun /opt/elizaos/app/server.js --headless --port="${PORT}"
fi

echo "elizaos agent payload missing: expected /opt/elizaos/bin/elizaos or bun plus agent-bundle.js" >&2
exit 127
