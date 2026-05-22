#!/bin/sh
set -eu

URL="${1:-http://127.0.0.1:31337}"
export ELIZA_TERMINAL_TUI=1
export ELIZA_AGENT_URL="${URL}"
export ELIZA_API_URL="${URL}"

if [ -x /opt/elizaos/bin/elizaos ]; then
    /opt/elizaos/bin/elizaos tui-smoke --api "${URL}"
    echo "elizaos-tui-ready url=${URL}"
    exit 0
fi

if [ -x /opt/elizaos/bin/bun ] && [ -f /opt/elizaos/app/agent-bundle.js ]; then
    /opt/elizaos/bin/bun /opt/elizaos/app/agent-bundle.js tui-smoke --api "${URL}"
    echo "elizaos-tui-ready url=${URL}"
    exit 0
fi

if [ -x /opt/elizaos/bin/bun ] && [ -f /opt/elizaos/app/server.js ]; then
    /opt/elizaos/bin/bun /opt/elizaos/app/server.js tui-smoke --api "${URL}"
    echo "elizaos-tui-ready url=${URL}"
    exit 0
fi

echo "elizaos terminal TUI smoke unavailable: no packaged elizaOS CLI entrypoint" >&2
exit 1
