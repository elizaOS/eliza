#!/bin/bash

set -eu

if [ "${EUID:-}" != 0 ]; then
    echo >&2 "must be run as root"
    exit 1
fi

SCRIPT_DIR=$(readlink -f "$(dirname "$0")")

if [ -n "${BEHAVE_DEBUG_ON_ERROR:-}" ]; then
    BEHAVE_CMD="behave -D BEHAVE_DEBUG_ON_ERROR --stop --verbose --no-capture --logging-level DEBUG"
elif [ -n "${DEBUG:-}" ]; then
    BEHAVE_CMD="behave --verbose --no-capture --logging-level DEBUG"
else
    BEHAVE_CMD="behave --verbose --no-capture"
fi

# Set the BEHAVE environment variable to signal to our code that it's
# being run by a behave test.
export BEHAVE=1

# Run the tests in a private mount namespace (using unshare), to avoid leaving
# any mounts mounted on the host
# shellcheck disable=SC2086
unshare --mount ${BEHAVE_CMD} "${SCRIPT_DIR}" "$@"
