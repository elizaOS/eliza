#!/bin/sh
# Launches the store Flatpak profile with capability state aligned to its
# bubblewrap sandbox. The explicit variant disables host CLI spawning and
# discovery surfaces that the sandbox cannot provide, allowing the UI to show
# their designed unavailable state.
export ELIZA_BUILD_VARIANT=store
export NODE_PATH="/app/lib/elizaos-app/node_modules"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
export ELIZA_STATE_DIR="${ELIZA_STATE_DIR:-$XDG_STATE_HOME/eliza}"
mkdir -p "$ELIZA_STATE_DIR"
export FFMPEG_BIN=/usr/bin/ffmpeg
export FFMPEG_PATH=/usr/bin/ffmpeg
export ELIZA_FFMPEG_PATH=/usr/bin/ffmpeg
export FFPROBE_PATH=/usr/bin/ffprobe
export FFMPEG_LOCATION=/usr/bin
exec /app/bin/node /app/lib/elizaos-app/node_modules/@elizaos/agent/bin.js "$@"
