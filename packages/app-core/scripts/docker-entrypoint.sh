#!/usr/bin/env sh
set -eu

<<<<<<< HEAD
resolved_port="${PORT:-${APP_PORT:-${ELIZA_PORT:-${ELIZA_PORT:-2138}}}}"

export APP_PORT="$resolved_port"
export APP_API_PORT="${APP_API_PORT:-$resolved_port}"
export ELIZA_PORT="$resolved_port"
export ELIZA_PORT="${ELIZA_PORT:-$resolved_port}"
export ELIZA_API_PORT="${ELIZA_API_PORT:-$resolved_port}"
=======
resolved_port="${PORT:-${MILADY_PORT:-2138}}"

export MILADY_PORT="$resolved_port"
export ELIZA_PORT="${ELIZA_PORT:-$resolved_port}"
export MILADY_API_PORT="${MILADY_API_PORT:-$resolved_port}"
>>>>>>> 026a30d5346a0084770e004dfe12b43524c2096e
export ELIZA_API_PORT="${ELIZA_API_PORT:-$resolved_port}"

exec "$@"
