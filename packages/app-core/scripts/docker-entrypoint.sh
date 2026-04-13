#!/usr/bin/env sh
set -eu

resolved_port="${PORT:-${MILADY_PORT:-2138}}"

export MILADY_PORT="$resolved_port"
export ELIZA_PORT="${ELIZA_PORT:-$resolved_port}"
export MILADY_API_PORT="${MILADY_API_PORT:-$resolved_port}"
export ELIZA_API_PORT="${ELIZA_API_PORT:-$resolved_port}"

exec "$@"
