#!/usr/bin/env sh
set -eu

resolved_port="${PORT:-${APP_PORT:-${ELIZA_PORT:-${ELIZA_PORT:-2138}}}}"

export APP_PORT="$resolved_port"
export APP_API_PORT="${APP_API_PORT:-$resolved_port}"
export ELIZA_PORT="$resolved_port"
export ELIZA_PORT="${ELIZA_PORT:-$resolved_port}"
export ELIZA_API_PORT="${ELIZA_API_PORT:-$resolved_port}"
export ELIZA_API_PORT="${ELIZA_API_PORT:-$resolved_port}"

exec "$@"
