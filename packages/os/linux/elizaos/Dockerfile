# elizaOS Linux — unified multi-arch live-build builder image.
#
# One image, three target architectures (amd64, arm64, riscv64). The
# host arch must match ELIZAOS_ARCH or qemu-user must be registered via
# binfmt_misc by the privileged build container.
#
# Build:
#   docker build -t elizaos-linux-builder .
# Run (amd64 example):
#   docker run --rm --privileged \
#       -e ELIZAOS_ARCH=amd64 \
#       -v "$(pwd):/build" -v "$(pwd)/out:/out" \
#       elizaos-linux-builder
ARG DEBIAN_BASE_IMAGE
FROM ${DEBIAN_BASE_IMAGE}

ARG DEBIAN_SNAPSHOT_SERIAL

ENV DEBIAN_FRONTEND=noninteractive

# The digest-pinned base's CA set predates the snapshot TLS certificate.
# Bootstrap over HTTP; apt still authenticates Debian's signed Release and
# package hashes. build.sh later re-fetches and hashes the locked Release files
# over HTTPS with the updated ca-certificates package installed here.
RUN test -n "${DEBIAN_SNAPSHOT_SERIAL}" \
    && printf '%s\n' \
        'Types: deb' \
        "URIs: http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT_SERIAL}" \
        'Suites: trixie trixie-updates' \
        'Components: main contrib non-free-firmware' \
        'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
        'Check-Valid-Until: no' \
        '' \
        'Types: deb' \
        "URIs: http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT_SERIAL}" \
        'Suites: trixie-security' \
        'Components: main contrib non-free-firmware' \
        'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
        'Check-Valid-Until: no' \
        > /etc/apt/sources.list.d/elizaos-snapshot.sources \
    && rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        debootstrap \
        live-build \
        squashfs-tools \
        xorriso \
        isolinux \
        syslinux-common \
        grub-pc-bin \
        grub-efi-amd64-bin \
        imagemagick \
        librsvg2-bin \
        mtools \
        dosfstools \
        mkosi \
        qemu-user-static \
        qemu-user-binfmt \
        qemu-system-arm \
        qemu-system-misc \
        qemu-system-x86 \
        qemu-efi-aarch64 \
        qemu-efi-riscv64 \
        ipxe-qemu \
        ovmf \
        binfmt-support \
        python3 \
        python3-yaml \
        rsync \
        git \
        curl \
        sudo \
        debian-archive-keyring \
        zstd \
    && if apt-cache show grub-efi-arm64-bin >/dev/null 2>&1; then \
        apt-get install -y --no-install-recommends grub-efi-arm64-bin; \
    else \
        echo "grub-efi-arm64-bin unavailable for this builder architecture; skipping"; \
    fi \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
ENTRYPOINT ["bash", "/build/build.sh"]
