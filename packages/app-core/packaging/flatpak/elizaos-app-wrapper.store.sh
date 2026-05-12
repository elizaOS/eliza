#!/bin/sh
# Store-variant Flatpak wrapper.
#
# This is the entrypoint Flatpak invokes when the user runs
# `flatpak run ai.elizaos.App` for the Flathub-distributed build. It
# differs from the direct-variant wrapper (`elizaos-app-wrapper.sh`)
# only by exporting `ELIZA_BUILD_VARIANT=store`, which the agent
# runtime reads to gate off PATH-lookup CLI spawning, EXECUTE_CODE,
# and host-Ollama discovery — capabilities bubblewrap blocks anyway,
# but signaling the variant explicitly lets the runtime render correct
# UI instead of failing opaquely.
export ELIZA_BUILD_VARIANT=store
export NODE_PATH="/app/lib/node_modules"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export ELIZAOS_APP_DATA_DIR="${XDG_CONFIG_HOME}/elizaos-app"
exec /app/bin/node /app/lib/node_modules/elizaos/elizaos-app.mjs "$@"
