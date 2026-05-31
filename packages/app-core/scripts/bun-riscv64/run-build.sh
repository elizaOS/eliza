#!/usr/bin/env bash
#
# Host-side wrapper for `docker build && docker run` of the
# bun-riscv64 cross-compile pipeline.
#
# Usage:
#   ./run-build.sh                       # build image + run cross-compile
#   ./run-build.sh --no-cache            # rebuild image from scratch
#   ./run-build.sh --baseline-jit        # experimental: requires realized WebKit patches
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

IMAGE_TAG="eliza/bun-riscv64-builder"
NO_CACHE=""
FORCE_CLOOP="1"
JOBS=""
IMAGE_ONLY=0
SHELL_MODE=0
RUST_CORE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --no-cache) NO_CACHE="--no-cache"; shift ;;
        --c-loop|--cloop) FORCE_CLOOP="1"; shift ;;
        --baseline-jit) FORCE_CLOOP="0"; shift ;;
        --jobs) JOBS="$2"; shift 2 ;;
        --image-only) IMAGE_ONLY=1; shift ;;
        --shell) SHELL_MODE=1; shift ;;
        # Build the post-rewrite Rust-core bun (rust_core_port.target_commit +
        # rust-core/ patch series) instead of the last-Zig tag. Default stays
        # the validated Zig fallback.
        --rust-core) RUST_CORE=1; shift ;;
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

# The Dockerfile vendors x86_64 toolchain binaries (Zig x86_64, bun x64
# bootstrap), so the builder image MUST be linux/amd64. On amd64 CI hosts this
# is native; on an arm64 host (Apple Silicon) it runs under emulation. Without
# this, an arm64 host builds an arm64 image where the x86_64 bun bootstrap
# fails with "rosetta error: failed to open elf .../ld-linux-x86-64.so.2".
PLATFORM="linux/amd64"

# ─── Build the image ───────────────────────────────────────────────────────
echo "[run-build] building image ${IMAGE_TAG} (--platform ${PLATFORM})"
docker build --platform "${PLATFORM}" ${NO_CACHE} -t "${IMAGE_TAG}" .

if [ "$IMAGE_ONLY" = "1" ]; then
    echo "[run-build] --image-only: stopping after image build."
    exit 0
fi

# ─── Shell mode ────────────────────────────────────────────────────────────
if [ "$SHELL_MODE" = "1" ]; then
    echo "[run-build] dropping into shell inside ${IMAGE_TAG}"
    exec docker run --rm -it \
        --platform "${PLATFORM}" \
        -v "$HERE:/work-host:rw" \
        --entrypoint /bin/bash \
        "${IMAGE_TAG}"
fi

# ─── Run the cross-compile ─────────────────────────────────────────────────
mkdir -p "$HERE/dist"

# Patch series: Zig fallback uses bun-patches/; --rust-core uses rust-core/
# (0001 build-system + C_LOOP port, 0002 second-wave source gaps).
#
# Src cache: the Zig fallback and the Rust-core port pin DIFFERENT WebKit + bun
# commits (5488984d / bun-v1.3.14 vs 963f8758 / 9d000561). build.sh re-fetches
# bun unconditionally but only fetches WebKit when its dir is absent, then does
# `git reset --hard $WEBKIT_COMMIT` — so sharing one /work/src across the two
# pins would fail the reset to an uncached WebKit SHA. Give each build its own
# cache dir to keep both incremental and the validated Zig cache intact.
PATCH_MOUNT="$HERE/bun-patches"
SRC_CACHE="$HERE/dist/src-cache"
if [ "$RUST_CORE" = "1" ]; then
    PATCH_MOUNT="$HERE/rust-core"
    SRC_CACHE="$HERE/dist/src-cache-rustcore"
    echo "[run-build] --rust-core: building Rust-core bun (rust_core_port) from rust-core/ patches"
fi
mkdir -p "$SRC_CACHE"

DOCKER_RUN_ARGS=(
    --rm
    --platform "${PLATFORM}"
    -v "$HERE/build.sh:/opt/build.sh:ro"
    -v "$HERE/bun-version.json:/opt/bun-version.json:ro"
    -v "$PATCH_MOUNT:/opt/bun-patches:ro"
    -v "$HERE/webkit-patches:/opt/webkit-patches:ro"
    -v "$HERE/dist:/artifact"
    -v "$SRC_CACHE:/work/src"
)

if [ -n "$JOBS" ]; then
    DOCKER_RUN_ARGS+=(-e "JOBS=${JOBS}")
fi
if [ "$FORCE_CLOOP" = "1" ]; then
    DOCKER_RUN_ARGS+=(-e "BUN_RISCV64_FORCE_CLOOP=1")
fi
if [ "$RUST_CORE" = "1" ]; then
    DOCKER_RUN_ARGS+=(-e "BUN_RISCV64_RUST_CORE=1")
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
    echo "      export ELIZA_BUN_RISCV64_URL='https://.../bun-linux-riscv64-musl.zip'"
    echo "      before running the Android assemble step."
else
    echo "[run-build] FAILED — no artifact at $ARTIFACT"
    echo "  Check $HERE/dist/build-log.txt for details."
    exit 1
fi
