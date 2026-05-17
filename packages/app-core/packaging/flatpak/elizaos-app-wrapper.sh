#!/bin/sh
export NODE_PATH="/app/lib/node_modules"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export ELIZAOS_APP_DATA_DIR="${XDG_CONFIG_HOME}/elizaos-app"
exec /app/bin/node /app/lib/node_modules/elizaos/elizaos-app.mjs "$@"
