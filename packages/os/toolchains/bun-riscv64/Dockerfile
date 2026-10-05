# syntax=docker/dockerfile:1.7

FROM --platform=linux/amd64 alpine:3.24.2 AS sysroot
RUN mkdir -p /sysroot/etc/apk/keys && \
    cp -L /usr/share/apk/keys/riscv64/*.pub /sysroot/etc/apk/keys/ && \
    apk --root /sysroot --arch riscv64 --initdb \
    --repositories-file /etc/apk/repositories --no-cache --no-scripts add \
    musl-dev gcc libatomic libstdc++-dev libucontext-dev icu-dev icu-data-full \
    zlib-dev openssl-dev linux-headers libffi-dev libuv-dev libxml2-dev

FROM --platform=linux/amd64 debian:trixie-slim AS base

ENV DEBIAN_FRONTEND=noninteractive
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

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
        libstdc++-14-dev \
        gnupg2 \
        ssh-client \
        qemu-user \
    && rm -rf /var/lib/apt/lists/*

ARG CMAKE_VERSION=4.4.4
ARG CMAKE_SHA256=e5bb807f7728cb60cd8b27ebc97a2edb469b68655f21e844a600c3575b76f5bb
RUN set -eux; \
    cd /tmp; \
    curl -fsSL -o cmake.tar.gz "https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-linux-x86_64.tar.gz"; \
    echo "${CMAKE_SHA256}  cmake.tar.gz" | sha256sum -c -; \
    tar -xzf cmake.tar.gz -C /opt; \
    ln -s "/opt/cmake-${CMAKE_VERSION}-linux-x86_64/bin/cmake" /usr/local/bin/cmake; \
    ln -s "/opt/cmake-${CMAKE_VERSION}-linux-x86_64/bin/ctest" /usr/local/bin/ctest; \
    rm cmake.tar.gz

ARG LLVM_VERSION=21
RUN set -eux; \
    curl -fsSL https://apt.llvm.org/llvm-snapshot.gpg.key | gpg --dearmor -o /usr/share/keyrings/llvm.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/llvm.gpg] https://apt.llvm.org/trixie/ llvm-toolchain-trixie-${LLVM_VERSION} main" \
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

ARG RUST_NIGHTLY=nightly-2026-07-20
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
    rustc +${RUST_NIGHTLY} --version

ARG BUN_BOOTSTRAP_VERSION=1.4.2
ARG BUN_BOOTSTRAP_SHA256=36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913
RUN set -eux; \
    cd /tmp; \
    curl -fsSL -o bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_BOOTSTRAP_VERSION}/bun-linux-x64.zip"; \
    echo "${BUN_BOOTSTRAP_SHA256}  bun.zip" | sha256sum -c -; \
    unzip -q bun.zip; \
    install -m 0755 "bun-linux-x64/bun" /usr/local/bin/bun; \
    ln -s /usr/local/bin/bun /usr/local/bin/bunx; \
    rm -rf bun.zip bun-linux-x64; \
    bun --version

COPY --from=sysroot /sysroot /sysroot
RUN set -eux; \
    test -e /sysroot/lib/ld-musl-riscv64.so.1; \
    test -e /sysroot/usr/include/stdio.h; \
    gcc_dir=(/sysroot/usr/lib/gcc/riscv64-alpine-linux-musl/*); \
    test "${#gcc_dir[@]}" -eq 1; \
    ln -s "${gcc_dir[0]}" /sysroot/gcc; \
    cxx_dir=(/sysroot/usr/include/c++/*); \
    test "${#cxx_dir[@]}" -eq 1; \
    ln -s "${cxx_dir[0]}" /sysroot/cxx

RUN set -eux; \
    install -d /opt/cross/bin; \
    cat > /opt/cross/bin/riscv64-linux-musl-clang <<'WRAPPER_EOF'
#!/bin/sh
compile_only=0
for arg in "$@"; do
    case "$arg" in
        -c|-S|-E|-M|-MM|-emit-pch|--analyze)
            compile_only=1
            ;;
    esac
done
if [ "$compile_only" = "1" ]; then
    exec /usr/local/bin/clang \
        --target=riscv64-unknown-linux-musl \
        --sysroot=/sysroot \
        --gcc-toolchain=/sysroot/usr \
        -Qunused-arguments \
        -B/sysroot/gcc \
        -march=rv64gc \
        -mabi=lp64d \
        "$@"
fi
exec /usr/local/bin/clang \
    --target=riscv64-unknown-linux-musl \
    --sysroot=/sysroot \
    --gcc-toolchain=/sysroot/usr \
    -B/sysroot/gcc \
    -L/sysroot/gcc \
    -L/sysroot/usr/lib \
    -fuse-ld=lld \
    -march=rv64gc \
    -mabi=lp64d \
    "$@"
WRAPPER_EOF
RUN cat > /opt/cross/bin/riscv64-linux-musl-clang++ <<'WRAPPER_EOF'
#!/bin/sh
compile_only=0
for arg in "$@"; do
    case "$arg" in
        -c|-S|-E|-M|-MM|-emit-pch|--analyze)
            compile_only=1
            ;;
    esac
done
if [ "$compile_only" = "1" ]; then
    exec /usr/local/bin/clang++ \
        --target=riscv64-unknown-linux-musl \
        --sysroot=/sysroot \
        --gcc-toolchain=/sysroot/usr \
        -Qunused-arguments \
        -B/sysroot/gcc \
        -stdlib=libstdc++ \
        -isystem /sysroot/cxx \
        -isystem /sysroot/cxx/riscv64-alpine-linux-musl \
        -march=rv64gc \
        -mabi=lp64d \
        "$@"
fi
exec /usr/local/bin/clang++ \
    --target=riscv64-unknown-linux-musl \
    --sysroot=/sysroot \
    --gcc-toolchain=/sysroot/usr \
    -B/sysroot/gcc \
    -L/sysroot/gcc \
    -L/sysroot/usr/lib \
    -fuse-ld=lld \
    -stdlib=libstdc++ \
    -isystem /sysroot/cxx \
    -isystem /sysroot/cxx/riscv64-alpine-linux-musl \
    -march=rv64gc \
    -mabi=lp64d \
    "$@"
WRAPPER_EOF
RUN chmod +x /opt/cross/bin/riscv64-linux-musl-clang /opt/cross/bin/riscv64-linux-musl-clang++ && \
    for tool in ar ranlib nm strip objcopy objdump readelf; do \
        ln -s "/usr/local/bin/llvm-${tool}" "/opt/cross/bin/riscv64-linux-musl-${tool}"; \
    done; \
    ln -s /usr/local/bin/ld.lld /opt/cross/bin/riscv64-linux-musl-ld

RUN printf '#include <stdatomic.h>\nint load(_Atomic int *p) { return atomic_load(p); }\n' | \
    /opt/cross/bin/riscv64-linux-musl-clang -std=c11 -x c -c -o /dev/null - && \
    printf '#include <atomic>\nint load(std::atomic<int> *p) { return p->load(); }\n' | \
    /opt/cross/bin/riscv64-linux-musl-clang++ -std=c++23 -x c++ -c -o /dev/null -

ENV PATH=/opt/cross/bin:$PATH

ENV CARGO_TARGET_RISCV64GC_UNKNOWN_LINUX_MUSL_LINKER=/opt/cross/bin/riscv64-linux-musl-clang \
    CARGO_TARGET_RISCV64GC_UNKNOWN_LINUX_MUSL_RUSTFLAGS="-C link-arg=--target=riscv64-unknown-linux-musl -C link-arg=--sysroot=/sysroot" \
    CC_riscv64gc_unknown_linux_musl=/opt/cross/bin/riscv64-linux-musl-clang \
    CXX_riscv64gc_unknown_linux_musl=/opt/cross/bin/riscv64-linux-musl-clang++ \
    AR_riscv64gc_unknown_linux_musl=/usr/local/bin/llvm-ar

ARG BUILDER_UID=1000
ARG BUILDER_GID=1000
RUN groupadd -f -g ${BUILDER_GID} builder && \
    useradd -m -u ${BUILDER_UID} -g ${BUILDER_GID} -s /bin/bash builder && \
    mkdir -p /work /artifact /home/builder/.cache /home/builder/.cargo && \
    chown -R ${BUILDER_UID}:${BUILDER_GID} /work /artifact /home/builder && \
    mkdir -p /usr/local/rustup/tmp /usr/local/rustup/downloads && \
    chmod a+rwx /usr/local/rustup /usr/local/rustup/tmp /usr/local/rustup/downloads && \
    rustup target add --toolchain ${RUST_NIGHTLY} aarch64-linux-android x86_64-linux-android x86_64-unknown-freebsd

USER builder
WORKDIR /work

ENTRYPOINT ["/bin/bash", "-l", "-c", "exec /opt/build.sh \"$@\"", "--"]
