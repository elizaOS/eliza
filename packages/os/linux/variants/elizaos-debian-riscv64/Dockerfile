# elizaOS Debian RISC-V 64 build image
#
# Parallel variant to packages/os/linux/variants/milady-tails/. This one
# targets riscv64 with a plain Debian Trixie live system. It is NOT a
# Tails fork: no amnesia/Tor plumbing here, only the live-build pipeline
# the chip team needs to land a bootable riscv64 ISO on real hardware.
#
# Build:  docker build -t elizaos-debian-riscv64-builder .
# Run:    docker run --rm --privileged \
#           -v <variant-dir>:/build \
#           -v <output-dir>:/out \
#           elizaos-debian-riscv64-builder
#
# Trixie has full riscv64 support and is the current Debian stable target;
# do not switch this to sid/unstable. No SHA pin yet.
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive

# Build dependencies:
#   1. live-build remains installed so this variant can grow a full live image.
#   2. debootstrap + qemu-user-static build the riscv64 Debian rootfs.
#   3. qemu-system-misc provides qemu-system-riscv64 for the boot smoke.
RUN dpkg --add-architecture riscv64 \
    && apt-get update && apt-get install -y --no-install-recommends \
        live-build \
        debootstrap \
        qemu-user-static \
        binfmt-support \
        qemu-system-misc \
        u-boot-menu \
        grub-efi-riscv64-bin:riscv64 \
        cpio \
        dosfstools \
        mtools \
        parted \
        squashfs-tools \
        xorriso \
        grub2-common \
        rsync \
        xz-utils \
        zstd \
        ca-certificates \
        curl \
        wget \
        file \
        gnupg \
        sudo \
        procps \
        iproute2 \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# ── Entry point ──────────────────────────────────────────────────────
# build.sh runs `lb config && lb build` against the auto/ tree mounted
# at /build. /out is where the resulting .iso / .img lands.
COPY build.sh /usr/local/bin/build.sh
RUN chmod +x /usr/local/bin/build.sh

WORKDIR /build
ENTRYPOINT ["/usr/local/bin/build.sh"]
