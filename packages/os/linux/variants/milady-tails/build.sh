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
# (vendored in this elizaOS Live variant). Override with TAILS_SRC.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAILS_SRC="${TAILS_SRC:-${HERE}/tails}"
OUT="${HERE}/out"
IMAGE="elizaos-tails-builder"
# Persistent apt-cacher-ng cache. A Docker named volume (not a host
# bind-mount) so it is owned correctly inside the container regardless
# of host uid, and it survives `docker run --rm`. This is what makes
# re-builds skip the network. Wipe it with: docker volume rm <name>.
ACNG_VOLUME="elizaos-tails-acng"
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

if [ ! -d "${TAILS_SRC}/config" ]; then
    echo "ERROR: no Tails source at ${TAILS_SRC} (expected config/, auto/, …)" >&2
    echo "Set TAILS_SRC=/path/to/tails or vendor it as ./tails/" >&2
    exit 1
fi

echo "=== building image ${IMAGE} ==="
# The image bakes in only Tails' live-build fork; the Dockerfile's build
# context needs that source available as tails-live-build/. The vendored
# Tails tree may omit submodule checkouts, so clone the pinned revision
# when tails/submodules/live-build is absent.
trap 'rm -rf "${HERE}/tails-live-build"' EXIT
rm -rf "${HERE}/tails-live-build"
if [ -d "${TAILS_SRC}/submodules/live-build" ] \
    && find "${TAILS_SRC}/submodules/live-build" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    cp -r "${TAILS_SRC}/submodules/live-build" "${HERE}/tails-live-build"
else
    echo "no ${TAILS_SRC}/submodules/live-build — fetching ${LIVE_BUILD_REF}"
    git init -q "${HERE}/tails-live-build"
    git -C "${HERE}/tails-live-build" remote add origin "${LIVE_BUILD_URL}"
    git -C "${HERE}/tails-live-build" fetch --depth 1 origin "${LIVE_BUILD_REF}"
    git -C "${HERE}/tails-live-build" checkout -q FETCH_HEAD
fi
docker build -t "${IMAGE}" "${HERE}"
rm -rf "${HERE}/tails-live-build"

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
