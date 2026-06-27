#!/usr/bin/env bash
# elizaOS Live — one-command ISO build. Works on any host with Docker
# (Linux / macOS Docker Desktop / Windows WSL2+Docker Desktop / CI).
#
#   ./build.sh            full clean ISO build → out/
#   ./build.sh config     go/no-go: just run `lb config` in the container
#   ./build.sh binary     incremental rebuild — squashfs + ISO only,
#                         reusing the chroot/ from a previous full build
#
#   MT_FAST=1 ./build.sh  build with low-compression squashfs (faster
#                         iteration, larger ISO)
#
#   ELIZAOS_BUILD_CPUS=2 ./build.sh
#                         cap the Docker build container to 2 CPUs
#
#   ELIZAOS_MKSQUASHFS_PROCESSORS=2 ./build.sh
#                         cap mksquashfs worker threads inside the container
#
#   ELIZAOS_BUILD_MEMORY=8g ./build.sh
#                         optionally cap Docker memory usage
#
#   ELIZAOS_SKIP_WEBSITE=1 ./build.sh
#                         demo iteration: skip rebuilding Tails' bundled
#                         offline website and install a tiny local page
#
# The Tails source tree is expected as a sibling `tails/` directory
# (vendored in this elizaOS Live distro). Override with TAILS_SRC.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../../.." && pwd)"
RM_PATH_RECURSIVE_SCRIPT="${REPO_ROOT}/packages/scripts/rm-path-recursive.mjs"
# shellcheck source=packages/os/linux/scripts/submodule-checkout.sh
source "${HERE}/scripts/submodule-checkout.sh"
TAILS_SRC="${TAILS_SRC:-${HERE}/tails}"
OUT="${HERE}/out"
# Target architecture for the ISO. Default amd64 keeps every existing
# call site working unchanged. arm64 + riscv64 add the per-arch bootloader
# packages in the Dockerfile (grub-efi-arm64-bin / grub-efi-riscv64-bin
# instead of grub-pc-bin + syslinux + isolinux, which are x86-only) and
# switch live-build's --architecture and --linux-flavours. Both inputs
# are tightly coupled — drive them from one source so a mismatch can't
# silently produce an amd64 chroot inside an arm64 image.
ARCH="${ELIZAOS_ARCH:-amd64}"
case "${ARCH}" in
    amd64|arm64|riscv64) ;;
    *)
        echo "ERROR: ELIZAOS_ARCH=${ARCH} is not supported." >&2
        echo "       Supported values: amd64 (default), arm64, riscv64." >&2
        exit 1
        ;;
esac
# One builder image per arch — mixing them would race for the same image
# tag. Per-arch tags also let CI keep an amd64 + arm64 builder warm in
# the same registry.
IMAGE="elizaos-builder-${ARCH}"
# Persistent apt-cacher-ng cache. A Docker named volume (not a host
# bind-mount) so it is owned correctly inside the container regardless
# of host uid, and it survives `docker run --rm`. This is what makes
# re-builds skip the network. Wipe it with: docker volume rm <name>.
ACNG_VOLUME="elizaos-acng"
STAGE="${1:-build}"
LIVE_BUILD_URL="${TAILS_LIVE_BUILD_URL:-https://gitlab.tails.boum.org/tails/live-build.git}"
LIVE_BUILD_REF="${TAILS_LIVE_BUILD_REF:-a20d501b63f2ca3a9ed372b5c24699c9a5434e90}"

case "${STAGE}" in
    build|config|binary) ;;
    *)
        echo "ERROR: unknown stage '${STAGE}' (expected: build | config | binary)" >&2
        exit 1
        ;;
esac

[ -r "${RM_PATH_RECURSIVE_SCRIPT}" ] || {
    echo "ERROR: recursive cleanup helper not found at ${RM_PATH_RECURSIVE_SCRIPT}" >&2
    exit 1
}

rm_path_recursive() {
    node "${RM_PATH_RECURSIVE_SCRIPT}" "$@"
}

if [ ! -d "${TAILS_SRC}/config" ]; then
    echo "ERROR: no Tails source at ${TAILS_SRC} (expected config/, auto/, …)" >&2
    echo "Set TAILS_SRC=/path/to/tails or vendor it as ./tails/" >&2
    exit 1
fi

if [ "${STAGE}" = "binary" ] && [ "${ELIZAOS_SYNC_CHROOT:-1}" = "1" ]; then
    echo "=== syncing elizaOS overlay into existing chroot ==="
    "${HERE}/scripts/sync-runtime-to-chroot.sh"
fi

echo "=== building image ${IMAGE} ==="
# The image bakes in only Tails' live-build fork; the Dockerfile's build
# context needs that source available as tails-live-build/. The vendored
# Tails tree may omit submodule checkouts, so clone the pinned revision
# when tails/submodules/live-build is absent.
trap 'rm_path_recursive "${HERE}/tails-live-build"' EXIT
materialize_submodule_checkout \
    "${TAILS_SRC}/submodules/live-build" \
    "${HERE}/tails-live-build" \
    "${LIVE_BUILD_URL}" \
    "${LIVE_BUILD_REF}"
# Pin the build platform so the Dockerfile pulls the matching debian
# base image and resolves arch-specific apt packages. For amd64 this
# also prevents Apple Silicon hosts (default arm64) from pulling the
# arm64 debian image when the user asked for an amd64 ISO. For
# non-amd64 archs the host must have qemu-user-static + binfmt_misc
# registered (Docker Desktop ships this; on bare Linux,
# `apt-get install qemu-user-static binfmt-support` then `docker run
# --rm --privileged tonistiigi/binfmt --install all`).
docker_build_args=(
    --platform "linux/${ARCH}"
    --build-arg "TARGETARCH=${ARCH}"
    -t "${IMAGE}"
)
if [ "${ELIZAOS_DOCKER_BUILDX_GHA_CACHE:-0}" = "1" ]; then
    if ! docker buildx version >/dev/null 2>&1; then
        echo "ERROR: ELIZAOS_DOCKER_BUILDX_GHA_CACHE=1 requires docker buildx." >&2
        exit 1
    fi
    CACHE_SCOPE="${ELIZAOS_DOCKER_BUILDX_CACHE_SCOPE:-elizaos-linux-iso-${ARCH}}"
    docker buildx build \
        "${docker_build_args[@]}" \
        --load \
        --cache-from "type=gha,scope=${CACHE_SCOPE}" \
        --cache-to "type=gha,scope=${CACHE_SCOPE},mode=max" \
        "${HERE}"
else
    docker build "${docker_build_args[@]}" "${HERE}"
fi
rm_path_recursive "${HERE}/tails-live-build"

# Create the apt-cacher-ng cache volume on first run.
if ! docker volume inspect "${ACNG_VOLUME}" >/dev/null 2>&1; then
    echo "=== creating apt-cacher-ng cache volume ${ACNG_VOLUME} ==="
    docker volume create "${ACNG_VOLUME}" >/dev/null
fi

echo
echo "=== running build (stage: ${STAGE}, fast: ${MT_FAST:-0}, cpus: ${ELIZAOS_BUILD_CPUS:-all}, memory: ${ELIZAOS_BUILD_MEMORY:-unlimited}) ==="
mkdir -p "${OUT}"
docker_run_args=(
    --rm
    --privileged
    --platform "linux/${ARCH}"
    # Pass the target arch into the container so tails/auto/config can
    # drive --architecture / --linux-flavours / arch-specific bootloader
    # options off it. Defaulted to amd64 inside the script too, so a
    # bare run still works.
    -e "ELIZAOS_ARCH=${ARCH}"
    -e "MT_STAGE=${STAGE}"
    -e "MT_FAST=${MT_FAST:-}"
    -e "ELIZAOS_SKIP_WEBSITE=${ELIZAOS_SKIP_WEBSITE:-}"
    -e "ELIZAOS_REUSE_BUILT_WEBSITE=${ELIZAOS_REUSE_BUILT_WEBSITE:-}"
    -e "ELIZAOS_BUILD_CPUS=${ELIZAOS_BUILD_CPUS:-}"
    -e "ELIZAOS_MKSQUASHFS_PROCESSORS=${ELIZAOS_MKSQUASHFS_PROCESSORS:-}"
    -e "TAILS_WEBSITE_CACHE=${TAILS_WEBSITE_CACHE:-}"
    -v "${TAILS_SRC}:/build"
    -v "${OUT}:/out"
    -v "${ACNG_VOLUME}:/var/cache/apt-cacher-ng"
)

if [ -n "${ELIZAOS_BUILD_CPUS:-}" ]; then
    docker_run_args+=(--cpus "${ELIZAOS_BUILD_CPUS}")
fi

if [ -n "${ELIZAOS_BUILD_MEMORY:-}" ]; then
    docker_run_args+=(--memory "${ELIZAOS_BUILD_MEMORY}")
fi

docker run "${docker_run_args[@]}" "${IMAGE}"

echo
case "${STAGE}" in
    config)
        echo "go/no-go: lb config ran in the container. If green, run ./build.sh for the full ISO."
        ;;
    *)
        echo "ISO(s) in ${OUT}:"
        ls -lh "${OUT}"/*.iso 2>/dev/null || echo "  (none — check build output above)"
        ;;
esac
