# LLVM build environment for the e1 RISC-V toolchain.
#
# This image derives from the canonical chip container (packages/chip/Dockerfile)
# and adds the extras needed for a two-stage LLVM trunk build:
#
#   - lld (used as the host linker for the bootstrap and the stage-2 build)
#   - ccache (RAM/disk hot path for incremental rebuilds across pin refreshes)
#   - python3-pip + lit (LLVM upstream test runner)
#   - libxml2-dev, libzstd-dev, zlib1g-dev (LLVM optional deps)
#   - swig (IREE python bindings)
#
# Build this image with:
#
#   docker build \
#       --build-arg BASE_IMAGE=eliza-chip:linux-x86_64 \
#       -f packages/chip/compiler/llvm-build/Dockerfile \
#       -t eliza-chip:llvm-build .
#
# The base image tag MUST be a digest-pinned build of packages/chip/Dockerfile.
# scripts/build_llvm_riscv.sh refuses to run unless /etc/eliza-chip-container
# is present (see require_linux_container in scripts/lib/container_guard.sh).

ARG BASE_IMAGE=eliza-chip:linux-x86_64
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive

# LLVM trunk needs lld + ccache + libxml2/libzstd/zlib dev headers + lit.
# Versions are pinned by the apt manifest captured in the base image; this
# layer only adds packages that are not already present. lit ships only via
# pip on Ubuntu 24.04 (no python3-lit apt package), so it is installed into
# the existing /opt/eliza-venv from the base image.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ccache \
        lld \
        libxml2-dev \
        libzstd-dev \
        zlib1g-dev \
        swig; \
    dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' \
        > /var/log/apt-manifest/installed-packages-llvm.tsv; \
    rm -rf /var/lib/apt/lists/*

RUN /opt/eliza-venv/bin/pip install --no-cache-dir 'lit>=18,<22'

# AutoFDO roundtrip needs qemu-user (workload capture) and linux-tools-generic
# (perf record). linux-tools-generic depends on the host kernel headers; we
# install qemu-user-static here and pull `perf` from generic upstream tools at
# AutoFDO time via PATH (the binary lives in /work bind-mount).
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        qemu-user-static; \
    rm -rf /var/lib/apt/lists/*

# ccache cache lives in the bind-mounted workspace so it survives container
# restarts and tracks the LLVM pin SHA in its filename namespace.
ENV CCACHE_DIR=/work/build/.ccache-llvm \
    CCACHE_MAXSIZE=20G \
    CCACHE_COMPRESS=1

# Make sure the container guard file is present so scripts/build_llvm_riscv.sh
# accepts this environment as canonical. The check is intentionally cheap.
RUN echo "eliza-chip:llvm-build" > /etc/eliza-chip-container

WORKDIR /work

# Default entry: a no-op shell. CI invokes
#   scripts/build_llvm_riscv.sh
# from the bind-mounted repo root.
CMD ["/bin/bash"]
