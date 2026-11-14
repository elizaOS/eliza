#!/usr/bin/env bash

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

RM_PATH_RECURSIVE_HOST="$(cd "$HERE/../../.." && pwd)/scripts/rm-path-recursive.ts"
[ -r "$RM_PATH_RECURSIVE_HOST" ] || {
    echo "FATAL: cleanup helper not found at $RM_PATH_RECURSIVE_HOST" >&2
    exit 1
}

IMAGE_TAG="eliza/bun-riscv64-builder"
NO_CACHE=""
JOBS=""
IMAGE_ONLY=0
SHELL_MODE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --no-cache) NO_CACHE="--no-cache"; shift ;;
        --jobs)
            if [ "$#" -lt 2 ] || [[ ! "$2" =~ ^[1-9][0-9]*$ ]]; then
                echo "--jobs requires a positive integer" >&2
                exit 2
            fi
            JOBS="$2"; shift 2 ;;
        --image-only) IMAGE_ONLY=1; shift ;;
        --shell) SHELL_MODE=1; shift ;;
        -h|--help)
            cat <<'USAGE'
Usage: run-build.sh [--no-cache] [--jobs N] [--image-only] [--shell]
  --no-cache     Rebuild the container image without cached layers.
  --jobs N       Limit build parallelism to a positive integer.
  --image-only   Build the container without compiling Bun.
  --shell        Open the builder container interactively.
USAGE
            exit 0 ;;
        *)
            echo "Unknown arg: $1" >&2
            exit 2 ;;
    esac
done

node "$HERE/validate.ts" --integrity-only

command -v docker >/dev/null 2>&1 || {
    echo "FATAL: docker not in PATH. Install Docker 25+ with buildx." >&2
    exit 1
}

PLATFORM="linux/amd64"

echo "[run-build] building image ${IMAGE_TAG} (--platform ${PLATFORM})"
docker build --platform "${PLATFORM}" ${NO_CACHE} \
    --build-arg "BUILDER_UID=$(id -u)" --build-arg "BUILDER_GID=$(id -g)" \
    -t "${IMAGE_TAG}" .

if [ "$IMAGE_ONLY" = "1" ]; then
    echo "[run-build] --image-only: stopping after image build."
    exit 0
fi

if [ "$SHELL_MODE" = "1" ]; then
    echo "[run-build] dropping into shell inside ${IMAGE_TAG}"
    exec docker run --rm -it \
        --platform "${PLATFORM}" \
        -v "$HERE:/work-host:rw" \
        -v "$RM_PATH_RECURSIVE_HOST:/opt/rm-path-recursive.ts:ro" \
        --entrypoint /bin/bash \
        "${IMAGE_TAG}"
fi

mkdir -p "$HERE/dist"
mkdir -p "$HERE/dist/src-cache"

DOCKER_RUN_ARGS=(
    --rm
    --platform "${PLATFORM}"
    -v "$HERE/build.sh:/opt/build.sh:ro"
    -v "$RM_PATH_RECURSIVE_HOST:/opt/rm-path-recursive.ts:ro"
    -v "$HERE/bun-version.json:/opt/bun-version.json:ro"
    -v "$HERE/bun-patches:/opt/bun-patches:ro"
    -v "$HERE/webkit-patches:/opt/webkit-patches:ro"
    -v "$HERE/dist:/artifact"
    -v "$HERE/dist/src-cache:/work/src"
)

if [ -n "$JOBS" ]; then
    DOCKER_RUN_ARGS+=(-e "JOBS=${JOBS}")
fi
rm -f "$HERE/dist/bun-linux-riscv64-musl.zip" "$HERE/dist/bun-linux-riscv64-musl.zip.sha256"
echo "[run-build] starting cross-compile"
docker run "${DOCKER_RUN_ARGS[@]}" "${IMAGE_TAG}"

ARTIFACT="$HERE/dist/bun-linux-riscv64-musl.zip"
if [ -f "$ARTIFACT" ]; then
    SHA="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
    SIZE="$(du -h "$ARTIFACT" | awk '{print $1}')"
    echo ""
    echo "[run-build] SUCCESS"
    echo "  Artifact : $ARTIFACT"
    echo "  Size     : $SIZE"
    echo "  SHA256   : $SHA"
    echo "  Log      : $HERE/dist/build-log.txt"
    echo ""
    echo "Next: upload to a hosting target reachable from CI/dev hosts, then"
    echo "      export ELIZA_BUN_RISCV64_URL='https://.../bun-linux-riscv64-musl.zip'"
    echo "      before running the Android assemble step."
else
    echo "[run-build] FAILED — no artifact at $ARTIFACT"
    echo "  Check $HERE/dist/build-log.txt for details."
    exit 1
fi
