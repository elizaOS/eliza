# syntax=docker/dockerfile:1.7
#
# Bun riscv64-linux-musl cross-compile image.
#
# Strategy
# --------
# Host:   linux/amd64 (debian:bookworm-slim). Fast native execution of the
#         build driver, Rust nightly, Zig codegen, and LLVM cross-compiler.
# Target: riscv64-linux-musl (Alpine v3.21 sysroot extracted into /sysroot).
#         All clang invocations carry --target=riscv64-unknown-linux-musl
#         --sysroot=/sysroot.
# Emulation: QEMU user-static is registered via binfmt_misc on the *Docker
#         daemon host* (operator runs `docker run --privileged --rm
#         tonistiigi/binfmt --install riscv64` once). Inside this container
#         /usr/bin/qemu-riscv64-static lets us execute the rare riscv64
#         build artifacts that Bun's build invokes (offlineasm, lut-gen).
#
# Why cross-compile, not native-under-QEMU
# ----------------------------------------
# A native build inside a `--platform=linux/riscv64` image runs every
# clang/cargo/zig invocation through QEMU user emulation, costing roughly
# 8-12x wall time. Cross-compiling stays on the x86_64 host CPU for codegen
# and uses QEMU only for the handful of generated build helpers that have
# to execute on the target arch (and even then, mostly offlineasm which is
# host-arch code anyway).
#
# Pins all come from bun-version.json. Bump them together.

ARG DEBIAN_TAG=bookworm-20250203-slim
FROM debian:${DEBIAN_TAG} AS base

ENV DEBIAN_FRONTEND=noninteractive
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# ----------------------------------------------------------------------------
# Stage 0: base toolchain (host-side build prerequisites)
# ----------------------------------------------------------------------------
# Everything in this layer is x86_64 and runs natively.

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        git \
        xz-utils \
        unzip \
        zip \
        bzip2 \
        zstd \
        tar \
        file \
        patch \
        make \
        ninja-build \
        pkg-config \
        ruby \
        perl \
        gperf \
        bison \
        flex \
        python3 \
        python3-pip \
        python3-venv \
        golang-go \
        gcc \
        g++ \
        libstdc++-12-dev \
        gnupg2 \
        ssh-client \
        # QEMU user-static so we can run the occasional riscv64 binary
        # emitted by the build (offlineasm sanity-check, lut-gen, etc.)
        qemu-user-static \
    && rm -rf /var/lib/apt/lists/*

# ----------------------------------------------------------------------------
# CMake: Debian Bookworm ships 3.25; Bun wants >= 3.27. Pull a recent
# kitware tarball pinned by sha256.
# ----------------------------------------------------------------------------
ARG CMAKE_VERSION=3.30.5
ARG CMAKE_SHA256=f747d9b23e1a252a8beafb4ed2bc2ddf78cff7f04a8e4de19f4ff88e9b51dc9d
RUN set -eux; \
    cd /tmp; \
    curl -fsSL -o cmake.tar.gz "https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-linux-x86_64.tar.gz"; \
    echo "${CMAKE_SHA256}  cmake.tar.gz" | sha256sum -c -; \
    tar -xzf cmake.tar.gz -C /opt; \
    ln -s "/opt/cmake-${CMAKE_VERSION}-linux-x86_64/bin/cmake" /usr/local/bin/cmake; \
    ln -s "/opt/cmake-${CMAKE_VERSION}-linux-x86_64/bin/ctest" /usr/local/bin/ctest; \
    rm cmake.tar.gz

# ----------------------------------------------------------------------------
# LLVM 21.1.8 (matches Bun's pinned LLVM_VERSION). LLVM apt-repo provides
# clang-21 / clang++-21 / lld-21 / llvm-ar-21 / llvm-ranlib-21 / etc. We
# alias the unversioned names so Bun's CMake `find_program` calls hit them.
# ----------------------------------------------------------------------------
ARG LLVM_VERSION=21
RUN set -eux; \
    curl -fsSL https://apt.llvm.org/llvm-snapshot.gpg.key | gpg --dearmor -o /usr/share/keyrings/llvm.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/llvm.gpg] http://apt.llvm.org/bookworm/ llvm-toolchain-bookworm-${LLVM_VERSION} main" \
        > /etc/apt/sources.list.d/llvm.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        clang-${LLVM_VERSION} \
        clang++-${LLVM_VERSION} \
        lld-${LLVM_VERSION} \
        llvm-${LLVM_VERSION} \
        llvm-${LLVM_VERSION}-dev \
        libclang-${LLVM_VERSION}-dev \
        libllvm${LLVM_VERSION} \
        libc++-${LLVM_VERSION}-dev \
        libc++abi-${LLVM_VERSION}-dev; \
    rm -rf /var/lib/apt/lists/*; \
    for tool in clang clang++ ld.lld lld llvm-ar llvm-ranlib llvm-nm llvm-strip llvm-objcopy llvm-objdump llvm-readelf llvm-readobj llvm-dwarfdump llvm-config llc opt FileCheck; do \
        if [ -e "/usr/bin/${tool}-${LLVM_VERSION}" ]; then \
            update-alternatives --install "/usr/local/bin/${tool}" "${tool}" "/usr/bin/${tool}-${LLVM_VERSION}" 100; \
        fi; \
    done; \
    clang --version | head -2

# ----------------------------------------------------------------------------
# Rust nightly pinned to Bun's rust-toolchain.toml channel. Install both
# the x86_64 host std (for build.rs etc.) AND the riscv64gc-unknown-linux-musl
# Tier-2 std for the actual cross-compile.
# ----------------------------------------------------------------------------
ARG RUST_NIGHTLY=nightly-2025-12-10
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN set -eux; \
    curl -fsSL https://sh.rustup.rs -o rustup-init.sh; \
    sh rustup-init.sh -y --no-modify-path --default-toolchain ${RUST_NIGHTLY} \
        --profile minimal \
        --component rust-src --component rustfmt --component clippy; \
    rm rustup-init.sh; \
    rustup target add --toolchain ${RUST_NIGHTLY} riscv64gc-unknown-linux-musl; \
    rustc +${RUST_NIGHTLY} --version; \
    rustc +${RUST_NIGHTLY} --print target-list | grep riscv64 || true

# ----------------------------------------------------------------------------
# Zig 0.14.1. Codegen runs on the build host; we never execute Zig under
# QEMU. Verified by sha256 from bun-version.json.
# ----------------------------------------------------------------------------
ARG ZIG_VERSION=0.14.1
ARG ZIG_SHA256=24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c
RUN set -eux; \
    cd /tmp; \
    curl -fsSL -o zig.tar.xz "https://ziglang.org/download/${ZIG_VERSION}/zig-x86_64-linux-${ZIG_VERSION}.tar.xz"; \
    # If the upstream sha256 file disagrees with our pin, fail loudly — we
    # never silently accept a different binary.
    echo "${ZIG_SHA256}  zig.tar.xz" | sha256sum -c - || (echo "Zig tarball sha256 mismatch; bump ZIG_SHA256 in bun-version.json + Dockerfile in lockstep" && exit 1); \
    tar -xJf zig.tar.xz -C /opt; \
    ln -s "/opt/zig-x86_64-linux-${ZIG_VERSION}/zig" /usr/local/bin/zig; \
    rm zig.tar.xz; \
    zig version

# ----------------------------------------------------------------------------
# Bun bootstrap binary (the build driver). Bun's build system is written
# in TypeScript and run by bun itself. Use a recent stable amd64 release.
# ----------------------------------------------------------------------------
ARG BUN_BOOTSTRAP_VERSION=1.3.13
RUN set -eux; \
    cd /tmp; \
    curl -fsSL -o bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_BOOTSTRAP_VERSION}/bun-linux-x64.zip"; \
    unzip -q bun.zip; \
    install -m 0755 "bun-linux-x64/bun" /usr/local/bin/bun; \
    ln -s /usr/local/bin/bun /usr/local/bin/bunx; \
    rm -rf bun.zip bun-linux-x64; \
    bun --version

# ----------------------------------------------------------------------------
# Stage 1: riscv64 sysroot from Alpine v3.21 main + community.
# ----------------------------------------------------------------------------
# We extract apks rather than running them through apk; the resulting tree
# at /sysroot is what clang's --sysroot points at. Mirrors the Alpine
# branch pinned by stage-android-agent.mjs:ALPINE_BRANCH so the ld-musl
# version, libstdc++ ABI, and libgcc_s ABI all line up with what the APK
# ships at runtime.
#
# Required packages (build-time):
#   musl-dev libgcc libstdc++ libstdc++-dev libucontext libucontext-dev
#   icu icu-dev icu-libs zlib zlib-dev libssl3 libcrypto3 openssl-dev
#   linux-headers
#
# We pin to the v3.21 main + community repos, no version pinning of
# individual apks — Alpine's branch index is reproducible enough that the
# build.sh artifact pipeline records the exact apk versions in the
# build-log so a follow-up rebuild knows what changed if Alpine bumps.

ARG ALPINE_BRANCH=v3.21
ARG ALPINE_ARCH=riscv64

RUN mkdir -p /sysroot
RUN set -eux; \
    cd /tmp; \
    mkdir -p apks; \
    cd apks; \
    base="https://dl-cdn.alpinelinux.org/alpine/${ALPINE_BRANCH}"; \
    for repo in main community; do \
        curl -fsSL -o "APKINDEX-${repo}.tar.gz" "${base}/${repo}/${ALPINE_ARCH}/APKINDEX.tar.gz"; \
        tar -xzf "APKINDEX-${repo}.tar.gz" -O APKINDEX > "APKINDEX-${repo}"; \
    done; \
    # Helper: resolve latest apk filename for a package name from the
    # combined APKINDEX. APKINDEX format: blank-line-separated records,
    # each record has `P:<pkg>` and `V:<ver>` lines (among others).
    # We use a record-mode awk reader.
    resolve() { \
        awk -v pkg="$1" '\
            BEGIN { RS=""; FS="\n" } \
            { p=""; v=""; \
              for (i=1; i<=NF; i++) { \
                if ($i ~ /^P:/) p = substr($i, 3); \
                if ($i ~ /^V:/) v = substr($i, 3); \
              } \
              if (p == pkg && v != "") print p "-" v ".apk"; \
            }' "$2" | head -1; \
    }; \
    for pkg in musl musl-dev musl-utils libgcc libstdc++ libstdc++-dev libucontext libucontext-dev icu icu-data-full icu-dev icu-libs zlib zlib-dev libssl3 libcrypto3 openssl-dev linux-headers libffi libffi-dev libuv libuv-dev libxml2 libxml2-dev; do \
        fetched=""; \
        for repo in main community; do \
            fname=$(resolve "$pkg" "APKINDEX-${repo}"); \
            if [ -n "$fname" ]; then \
                echo "Fetching ${repo}/${fname}"; \
                if curl -fsSL -o "$fname" "${base}/${repo}/${ALPINE_ARCH}/${fname}"; then \
                    fetched="$fname"; \
                    break; \
                fi; \
            fi; \
        done; \
        if [ -z "$fetched" ]; then \
            echo "FATAL: package '$pkg' not found in any repo"; \
            exit 1; \
        fi; \
    done; \
    ls -la

# Extract all apks into /sysroot. Alpine apks are gzipped tarballs whose
# first concatenated stream is the signature (which we skip).
RUN set -eux; \
    cd /tmp/apks; \
    for apk in *.apk; do \
        echo "Extracting $apk"; \
        # `tar --warning=no-unknown-keyword` skips the .SIGN.* control
        # member; we don't validate signatures here because apk-tools isn't
        # installed — the apks came from HTTPS and the build.sh log
        # records the indexes for a follow-up audit.
        tar -xzf "$apk" -C /sysroot --warning=no-unknown-keyword \
            --exclude='.*' 2>&1 | grep -v "Ignoring unknown" || true; \
    done; \
    # Sanity: the riscv64 musl loader must exist.
    test -e /sysroot/lib/ld-musl-riscv64.so.1 || (echo "ld-musl-riscv64.so.1 missing — sysroot extraction failed" && exit 1); \
    test -e /sysroot/usr/include/stdio.h || (echo "musl-dev not extracted — sysroot missing libc headers" && exit 1); \
    file /sysroot/lib/ld-musl-riscv64.so.1

# ----------------------------------------------------------------------------
# Stage 2: wrapper scripts for clang/clang++ that always carry the
# riscv64 target triple + sysroot. Bun's CMake invokes ${CMAKE_C_COMPILER}
# directly with the global flags from flags.ts; making these wrappers the
# default for the build user means we don't have to teach Bun about a
# new target triple at every callsite.
# ----------------------------------------------------------------------------

RUN set -eux; \
    install -d /opt/cross/bin; \
    cat > /opt/cross/bin/riscv64-linux-musl-clang <<'WRAPPER_EOF'
#!/bin/sh
exec /usr/local/bin/clang \
    --target=riscv64-unknown-linux-musl \
    --sysroot=/sysroot \
    --gcc-toolchain=/sysroot/usr \
    -march=rv64gc \
    -mabi=lp64d \
    "$@"
WRAPPER_EOF
RUN cat > /opt/cross/bin/riscv64-linux-musl-clang++ <<'WRAPPER_EOF'
#!/bin/sh
exec /usr/local/bin/clang++ \
    --target=riscv64-unknown-linux-musl \
    --sysroot=/sysroot \
    --gcc-toolchain=/sysroot/usr \
    -stdlib=libstdc++ \
    -march=rv64gc \
    -mabi=lp64d \
    "$@"
WRAPPER_EOF
RUN chmod +x /opt/cross/bin/riscv64-linux-musl-clang /opt/cross/bin/riscv64-linux-musl-clang++ && \
    # Ar/ranlib/strip/objcopy: LLVM versions work for riscv64 unmodified.
    for tool in ar ranlib nm strip objcopy objdump readelf; do \
        ln -s "/usr/local/bin/llvm-${tool}" "/opt/cross/bin/riscv64-linux-musl-${tool}"; \
    done; \
    ln -s /usr/local/bin/ld.lld /opt/cross/bin/riscv64-linux-musl-ld

ENV PATH=/opt/cross/bin:$PATH

# Cargo cross-target settings: linker, env vars Bun's libbun_rust build
# script reads, and pre-extracted riscv64 std (Tier-2 prebuilt).
ENV CARGO_TARGET_RISCV64GC_UNKNOWN_LINUX_MUSL_LINKER=/opt/cross/bin/riscv64-linux-musl-clang \
    CARGO_TARGET_RISCV64GC_UNKNOWN_LINUX_MUSL_RUSTFLAGS="-C link-arg=--target=riscv64-unknown-linux-musl -C link-arg=--sysroot=/sysroot" \
    CC_riscv64gc_unknown_linux_musl=/opt/cross/bin/riscv64-linux-musl-clang \
    CXX_riscv64gc_unknown_linux_musl=/opt/cross/bin/riscv64-linux-musl-clang++ \
    AR_riscv64gc_unknown_linux_musl=/usr/local/bin/llvm-ar

# ----------------------------------------------------------------------------
# Stage 3: cache dirs + non-root build user.
# ----------------------------------------------------------------------------
# Bun's build writes to ~/.cache/bun, ~/.cargo, etc. We don't want to run
# the build as root inside the container, so create a `builder` user and
# pre-create its cache dirs.

ARG BUILDER_UID=1000
ARG BUILDER_GID=1000
RUN groupadd -g ${BUILDER_GID} builder && \
    useradd -m -u ${BUILDER_UID} -g ${BUILDER_GID} -s /bin/bash builder && \
    mkdir -p /work /artifact /home/builder/.cache /home/builder/.cargo && \
    chown -R builder:builder /work /artifact /home/builder

USER builder
WORKDIR /work

# Default entrypoint runs build.sh, which is mounted in from the host at
# /opt/build.sh (or copied via `docker build` when baking the script in).
# Operators typically invoke:
#
#   docker run --rm -v "$PWD/dist:/artifact" \
#       -v "$PWD/build.sh:/opt/build.sh:ro" \
#       -v "$PWD/bun-patches:/opt/bun-patches:ro" \
#       -v "$PWD/webkit-patches:/opt/webkit-patches:ro" \
#       -v "$PWD/bun-version.json:/opt/bun-version.json:ro" \
#       eliza/bun-riscv64-builder
#
# See README.md for the host-side runner that wraps this.

ENTRYPOINT ["/bin/bash", "-l", "-c", "exec /opt/build.sh \"$@\"", "--"]
