#!/bin/sh
export NODE_PATH="/app/lib/elizaos-app/node_modules"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export ELIZAOS_APP_DATA_DIR="${XDG_CONFIG_HOME}/elizaos-app"
exec /app/bin/node /app/lib/elizaos-app/packages/agent/dist/bin.js "$@"
