#!/usr/bin/env bash
# Canonical elizaOS Debian image entrypoint.
#
# The release image is owned by ./elizaos. No inherited alternate build tree
# exists, so every entry point reaches the same Debian live-build source.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCH="${ELIZAOS_ARCH:-amd64}"
PROFILE="${ELIZAOS_PROFILE:-gui}"
PACKAGED_APP="${ELIZAOS_APP_ARTIFACT:-}"
STAGE="${1:-build}"

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

if [ "${PROFILE}" = "gui" ]; then
    if [ -z "${PACKAGED_APP}" ] || [ ! -x "${PACKAGED_APP}/bin/launcher" ]; then
        printf 'ERROR: GUI image requires ELIZAOS_APP_ARTIFACT with bin/launcher\n' >&2
        exit 66
    fi
fi

exec make -C "${HERE}/elizaos" build \
    ARCH="${ARCH}" \
    PROFILE="${PROFILE}" \
    PACKAGED_APP="${PACKAGED_APP}"
