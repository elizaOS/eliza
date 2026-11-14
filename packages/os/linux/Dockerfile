ARG DEBIAN_BASE_IMAGE
FROM ${DEBIAN_BASE_IMAGE}

ARG DEBIAN_SNAPSHOT_SERIAL

ENV DEBIAN_FRONTEND=noninteractive

# The digest-pinned base's CA set predates the snapshot TLS certificate.
# Bootstrap over HTTP; apt still authenticates Debian's signed Release and
# package hashes.
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
ENTRYPOINT ["mkosi"]
