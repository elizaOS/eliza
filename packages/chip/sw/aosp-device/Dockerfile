# Dockerfile - Reproducible host environment for AOSP riscv64 builds.
#
# Used by CI and by anyone whose host distro does not match AOSP's expected
# Ubuntu 24.04 + JDK 21 baseline. The container mounts a workspace volume and
# runs build-aosp-riscv64.sh against it.
#
# Build:
#   docker buildx build \
#     --check \
#     -f packages/chip/sw/aosp-device/Dockerfile \
#     -t eliza/aosp-riscv64-builder:dev \
#     packages/chip/sw/aosp-device
#
# Run (interactive):
#   docker run --rm -it \
#     -v $PWD:/eliza:ro \
#     -v $HOME/aosp-cf-riscv64:/work/aosp \
#     eliza/aosp-riscv64-builder:dev \
#     /eliza/packages/chip/sw/aosp-device/build-aosp-riscv64.sh \
#       --workspace /work/aosp
#
# The base image is pinned by digest; refresh via:
#   docker manifest inspect --verbose ubuntu:24.04 \
#     | jq -r '.Descriptor.digest // .manifests[0].digest'
# and keep docs/toolchain/reproducibility.md in lockstep with the new digest.

# checkov:skip=CKV_DOCKER_2: AOSP builder is not a long-running service; no HEALTHCHECK needed.
# checkov:skip=CKV_DOCKER_3: AOSP build tooling (repo, m, lunch) requires UID 0 inside the container.

ARG UBUNTU_DIGEST=sha256:c4a8d5503dfb2a3eb8ab5f807da5bc69a85730fb49b5cfca2330194ebcc41c7b
FROM ubuntu:24.04@${UBUNTU_DIGEST}

ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

# Refuse to build the image for anything other than the AOSP host arch.
RUN set -eux; \
    if [ "${TARGETARCH:-amd64}" != "amd64" ]; then \
        echo "AOSP riscv64 cross-build requires an x86_64 host (got: ${TARGETARCH})" >&2; \
        exit 1; \
    fi

# AOSP source-build host packages. Versions are not pinned (apt resolves them
# from Ubuntu 24.04 + universe). A manifest of resolved versions is captured to
# /var/log/apt-manifest/ for reproducibility audits.
RUN set -eux; \
    mkdir -p /var/log/apt-manifest; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl wget gnupg \
        build-essential git rsync unzip zip \
        bc bison flex make ninja-build pkg-config \
        python3 python3-distutils python3-pip python3-venv \
        openjdk-21-jdk-headless \
        ccache \
        e2fsprogs fdisk \
        libssl-dev libxml2-utils xsltproc \
        lib32z1-dev libgl1 libglu1-mesa libxext6 libxrender1 \
        qemu-system-misc qemu-utils \
        device-tree-compiler \
        jq sudo file kmod; \
    dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' \
        > /var/log/apt-manifest/installed-packages.tsv; \
    apt-cache policy > /var/log/apt-manifest/apt-policy.txt 2>&1 || true; \
    cp /etc/apt/sources.list /var/log/apt-manifest/sources.list 2>/dev/null || true; \
    rm -rf /var/lib/apt/lists/*

# QEMU 9.2 minimum (cuttlefish vsock + riscv64 virt machine maturity). Ubuntu
# 24.04 ships QEMU 8.x; pull a newer build from the noble-backports pocket and
# fall back to the source-built tarball if backports does not yet have it.
RUN set -eux; \
    apt-get update; \
    if apt-get -y -t noble-backports install qemu-system-misc qemu-system-riscv qemu-utils; then \
        :; \
    else \
        echo "noble-backports lacks QEMU 9.2; falling back to upstream build at /opt/qemu"; \
        mkdir -p /opt/qemu; \
        cd /tmp; \
        curl -fsSL https://download.qemu.org/qemu-9.2.0.tar.xz -o qemu.tar.xz; \
        tar -xf qemu.tar.xz; \
        cd qemu-9.2.0; \
        apt-get install -y --no-install-recommends libglib2.0-dev libpixman-1-dev libslirp-dev meson; \
        ./configure --prefix=/opt/qemu --target-list=riscv64-softmmu,riscv64-linux-user --disable-werror; \
        make -j"$(nproc)"; \
        make install; \
        ln -sfn /opt/qemu/bin/qemu-system-riscv64 /usr/local/bin/qemu-system-riscv64; \
        cd /; rm -rf /tmp/qemu*; \
    fi; \
    rm -rf /var/lib/apt/lists/*; \
    qemu-system-riscv64 --version | head -n1 \
        | tee /var/log/apt-manifest/qemu-version.txt

# Pin JDK 21 as the system Java (AOSP main + android-latest-release expect JDK 21).
RUN update-alternatives --set java  /usr/lib/jvm/java-21-openjdk-amd64/bin/java; \
    update-alternatives --set javac /usr/lib/jvm/java-21-openjdk-amd64/bin/javac
ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64

# Google's repo launcher. The bootstrap inside build-aosp-riscv64.sh will reuse
# this if present and skip its own per-workspace fetch.
RUN curl -fsSL https://storage.googleapis.com/git-repo-downloads/repo \
        -o /usr/local/bin/repo; \
    chmod +x /usr/local/bin/repo

# Recommended ccache settings; the actual cache lives in the mounted workspace.
ENV USE_CCACHE=1 \
    CCACHE_DIR=/work/.ccache \
    CCACHE_EXEC=/usr/bin/ccache
RUN ccache --max-size=80G || true

WORKDIR /work

# Default invocation prints the build script's usage; override with the real
# command in `docker run`.
ENTRYPOINT ["/bin/bash", "-lc"]
CMD ["echo 'eliza/aosp-riscv64-builder: pass build-aosp-riscv64.sh and args via docker run command' && exit 0"]
