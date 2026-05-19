# elizaOS Debian RISC-V 64 live-build image — skeleton
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
# Status: Wave 2B-B1 skeleton. The rootfs/auto-config implementation that
# produces an actual bootable artifact lands in Wave 4. This image already
# has the toolchain needed to run `lb config --architecture riscv64` and
# `lb build` once the configuration is real.
#
# Trixie has full riscv64 support and is the current Debian stable target;
# do not switch this to sid/unstable. No SHA pin yet — pin in Wave 4 when
# we are reproducing artifacts.
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive

# ── Build dependencies ───────────────────────────────────────────────
# Three layers of deps:
#   1. live-build's own runtime deps (mirrors the relevant subset of the
#      milady-tails Dockerfile — debootstrap, parted, squashfs, xorriso,
#      rsync, etc.). riscv64 has no isolinux/syslinux/grub-pc-bin path,
#      so those are dropped.
#   2. riscv64-specific bootloader pieces, pulled via multiarch since
#      grub-efi-riscv64-bin is Architecture: riscv64 and the builder host
#      is typically amd64 (`dpkg --add-architecture riscv64` below).
#      u-boot-menu is Architecture: all so it installs without multiarch.
#      No `grub-efi-riscv64-signed` — Debian does not yet publish a
#      signed riscv64 grub-efi payload, so dropping it is correct, not a
#      lapse to fix in Wave 4. Secure-boot path will land when Debian
#      ships the signed variant. extlinux on amd64 is only useful as a
#      host-side helper for the U-Boot extlinux.conf generator; the real
#      riscv64 bootloader binary comes from the chroot.
#   3. Foreign-arch execution: qemu-user-static + binfmt-support so the
#      builder host (typically x86_64) can run riscv64 binaries during
#      debootstrap's second stage inside the chroot.
RUN dpkg --add-architecture riscv64 \
    && apt-get update && apt-get install -y --no-install-recommends \
        live-build \
        debootstrap \
        qemu-user-static \
        binfmt-support \
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
    && rm -rf /var/lib/apt/lists/*

# ── Entry point ──────────────────────────────────────────────────────
# build.sh runs `lb config && lb build` against the auto/ tree mounted
# at /build. /out is where the resulting .iso / .img lands.
COPY build.sh /usr/local/bin/build.sh
RUN chmod +x /usr/local/bin/build.sh

WORKDIR /build
ENTRYPOINT ["/usr/local/bin/build.sh"]
