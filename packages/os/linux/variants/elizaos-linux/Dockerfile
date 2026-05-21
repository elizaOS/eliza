# elizaOS Linux — unified multi-arch live-build builder image.
#
# One image, three target architectures (amd64, arm64, riscv64). The
# host arch must match ELIZAOS_ARCH or qemu-user-static must be
# registered via binfmt_misc on the build host (foreign-arch builds
# need CONFIG_BINFMT_MISC and `update-binfmts --enable`).
#
# Build:
#   docker build -t elizaos-linux-builder .
# Run (amd64 example):
#   docker run --rm --privileged \
#       -e ELIZAOS_ARCH=amd64 \
#       -v "$(pwd):/build" -v "$(pwd)/out:/out" \
#       elizaos-linux-builder
FROM debian:trixie

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        debootstrap \
        live-build \
        squashfs-tools \
        xorriso \
        isolinux \
        syslinux-common \
        grub-pc-bin \
        grub-efi-amd64-bin \
        grub-efi-arm64-bin \
        grub-efi-riscv64-bin \
        mtools \
        dosfstools \
        qemu-user-static \
        binfmt-support \
        python3 \
        python3-yaml \
        apt-cacher-ng \
        rsync \
        git \
        curl \
        ca-certificates \
        sudo \
    && rm -rf /var/lib/apt/lists/*

# Enable foreign-arch execution inside the container.
RUN update-binfmts --enable qemu-aarch64 || true \
 && update-binfmts --enable qemu-riscv64 || true

WORKDIR /build
ENTRYPOINT ["/build/build.sh"]
