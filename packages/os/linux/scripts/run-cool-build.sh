#!/usr/bin/env bash
# Shared low-CPU wrapper for elizaOS Live build recipes.

set -euo pipefail

usage() {
    echo "usage: $0 build|binary" >&2
    exit 64
}

stage="${1:-}"
case "${stage}" in
    build | binary) ;;
    *) usage ;;
esac

cpus="${ELIZAOS_BUILD_CPUS:-2}"
export ELIZAOS_BUILD_CPUS="${cpus}"
export ELIZAOS_MKSQUASHFS_PROCESSORS="${ELIZAOS_MKSQUASHFS_PROCESSORS:-${cpus}}"
export MT_FAST=1

exec ./build.sh "${stage}"
