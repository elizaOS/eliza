#!/usr/bin/env bash
# Canonical persistent mkosi image entrypoint.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCH="${ELIZAOS_ARCH:-amd64}"
PROFILE="${ELIZAOS_PROFILE:-gui}"
STAGE="${1:-build}"

if [ "$#" -gt 1 ]; then
    printf 'ERROR: expected at most one stage: build, config, or lint.\n' >&2
    exit 64
fi
if [ -n "${ELIZAOS_APP_ARTIFACT:-}" ]; then
    printf 'ERROR: ELIZAOS_APP_ARTIFACT is obsolete; use scripts/linux/mkosi-linux-build.py for signed desktop artifact inputs.\n' >&2
    exit 64
fi

case "${STAGE}" in
    build)
        ;;
    config|lint)
        exec make -C "${HERE}/elizaos" lint
        ;;
    *)
        printf 'ERROR: unsupported canonical Debian build stage: %s\n' "${STAGE}" >&2
        printf 'Use build, config, or lint. Incremental chroot reuse is not a release input.\n' >&2
        exit 64
        ;;
esac

exec make -C "${HERE}/elizaos" build \
    ARCH="${ARCH}" \
    PROFILE="${PROFILE}"
