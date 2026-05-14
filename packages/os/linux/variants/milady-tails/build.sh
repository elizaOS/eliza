#!/usr/bin/env bash
# milady-tails — one-command ISO build. Works on any host with Docker
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
# The Tails source tree is expected as a sibling `tails/` directory
# (vendored in the milady-tails variant). Override with TAILS_SRC.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAILS_SRC="${TAILS_SRC:-${HERE}/tails}"
OUT="${HERE}/out"
IMAGE="milady-tails-builder"
# Persistent apt-cacher-ng cache. A Docker named volume (not a host
# bind-mount) so it is owned correctly inside the container regardless
# of host uid, and it survives `docker run --rm`. This is what makes
# re-builds skip the network. Wipe it with: docker volume rm <name>.
ACNG_VOLUME="milady-tails-acng"
STAGE="${1:-build}"

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
# context needs that submodule available as tails-live-build/. Stage it
# under a trap so a failed `docker build` doesn't leave it behind.
trap 'rm -rf "${HERE}/tails-live-build"' EXIT
rm -rf "${HERE}/tails-live-build"
cp -r "${TAILS_SRC}/submodules/live-build" "${HERE}/tails-live-build"
docker build -t "${IMAGE}" "${HERE}"
rm -rf "${HERE}/tails-live-build"

# Create the apt-cacher-ng cache volume on first run.
if ! docker volume inspect "${ACNG_VOLUME}" >/dev/null 2>&1; then
    echo "=== creating apt-cacher-ng cache volume ${ACNG_VOLUME} ==="
    docker volume create "${ACNG_VOLUME}" >/dev/null
fi

echo
echo "=== running build (stage: ${STAGE}, fast: ${MT_FAST:-0}) ==="
mkdir -p "${OUT}"
docker run --rm --privileged \
    -e MT_STAGE="${STAGE}" \
    -e MT_FAST="${MT_FAST:-}" \
    -v "${TAILS_SRC}:/build" \
    -v "${OUT}:/out" \
    -v "${ACNG_VOLUME}:/var/cache/apt-cacher-ng" \
    "${IMAGE}"

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
