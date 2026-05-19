#!/usr/bin/env bash
#
# Host-side wrapper for `docker build && docker run` of the
# bun-riscv64 cross-compile pipeline.
#
# Usage:
#   ./run-build.sh                       # build image + run cross-compile
#   ./run-build.sh --no-cache            # rebuild image from scratch
#   ./run-build.sh --c-loop              # fallback: build with ENABLE_C_LOOP=ON
#   ./run-build.sh --jobs 4              # cap parallel build jobs (default: nproc)
#   ./run-build.sh --image-only          # just build the Docker image, don't run
#   ./run-build.sh --shell               # drop into a shell inside the image
#                                        # (for poking at the toolchain / sysroot)
#
# Reads pins from ./bun-version.json. The script is idempotent: re-running
# without --no-cache reuses Docker layer cache for the heavy toolchain
# install, so iterating on patches only re-runs the build steps.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

IMAGE_TAG="milady/bun-riscv64-builder"
NO_CACHE=""
FORCE_CLOOP=""
JOBS=""
IMAGE_ONLY=0
SHELL_MODE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --no-cache) NO_CACHE="--no-cache"; shift ;;
        --c-loop|--cloop) FORCE_CLOOP="1"; shift ;;
        --jobs) JOBS="$2"; shift 2 ;;
        --image-only) IMAGE_ONLY=1; shift ;;
        --shell) SHELL_MODE=1; shift ;;
        -h|--help)
            # Usage block lives in the file header (lines 3-17 of the
            # leading comment, just below the shebang).
            grep '^#' "$0" | sed -n '3,17p' | sed 's|^# \?||'
            exit 0 ;;
        *)
            echo "Unknown arg: $1" >&2
            exit 2 ;;
    esac
done

# ─── Sanity checks ─────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || {
    echo "FATAL: docker not in PATH. Install Docker 25+ with buildx." >&2
    exit 1
}

# Verify QEMU riscv64 binfmt is registered. Without this, `docker run
# --platform linux/riscv64` works but our cross-build's QEMU-based smoke
# test (qemu-riscv64-static bun --version) cannot execute.
if [ ! -e /proc/sys/fs/binfmt_misc/qemu-riscv64 ] && \
   [ ! -e /proc/sys/fs/binfmt_misc/qemu-riscv64-static ]; then
    cat >&2 <<'NO_BINFMT'
WARNING: No qemu-riscv64 binfmt_misc entry detected on the build host.
The build will still cross-compile (host CPU runs clang, not the target
binary), but the in-container smoke test (qemu-riscv64-static bun
--version) will fail.

Install the QEMU emulators system-wide first:

    docker run --rm --privileged tonistiigi/binfmt --install riscv64

Continuing — the build itself does not depend on this, only the post-build
verification step does.
NO_BINFMT
fi

# ─── Build the image ───────────────────────────────────────────────────────
echo "[run-build] building image ${IMAGE_TAG}"
docker build ${NO_CACHE} -t "${IMAGE_TAG}" .

if [ "$IMAGE_ONLY" = "1" ]; then
    echo "[run-build] --image-only: stopping after image build."
    exit 0
fi

# ─── Shell mode ────────────────────────────────────────────────────────────
if [ "$SHELL_MODE" = "1" ]; then
    echo "[run-build] dropping into shell inside ${IMAGE_TAG}"
    exec docker run --rm -it \
        -v "$HERE:/work-host:rw" \
        --entrypoint /bin/bash \
        "${IMAGE_TAG}"
fi

# ─── Run the cross-compile ─────────────────────────────────────────────────
mkdir -p "$HERE/dist"

DOCKER_RUN_ARGS=(
    --rm
    -v "$HERE/build.sh:/opt/build.sh:ro"
    -v "$HERE/bun-version.json:/opt/bun-version.json:ro"
    -v "$HERE/bun-patches:/opt/bun-patches:ro"
    -v "$HERE/webkit-patches:/opt/webkit-patches:ro"
    -v "$HERE/dist:/artifact"
)

if [ -n "$JOBS" ]; then
    DOCKER_RUN_ARGS+=(-e "JOBS=${JOBS}")
fi
if [ "$FORCE_CLOOP" = "1" ]; then
    DOCKER_RUN_ARGS+=(-e "BUN_RISCV64_FORCE_CLOOP=1")
fi

echo "[run-build] starting cross-compile (this typically takes 30-90 minutes)"
docker run "${DOCKER_RUN_ARGS[@]}" "${IMAGE_TAG}"

# ─── Report ────────────────────────────────────────────────────────────────
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
    echo "      export MILADY_BUN_RISCV64_URL='https://.../bun-linux-riscv64-musl.zip'"
    echo "      before running the Android assemble step."
else
    echo "[run-build] FAILED — no artifact at $ARTIFACT"
    echo "  Check $HERE/dist/build-log.txt for details."
    exit 1
fi
