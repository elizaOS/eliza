#!/usr/bin/env bash
# Boot the freshly-built riscv64 GUI ISO inside the builder container
# (qemu 10.0.8 + Debian qemu-efi-riscv64), the canonical boot environment.
# The host's qemu 8.2.2 loses the serial console after the EFI stub exits
# boot services on riscv64 virt. The builder image lacks bsdtar, which the
# boot harness needs to verify the ISO's GRUB EFI artifacts, so install
# libarchive-tools first.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ISO_NAME="elizaos-linux-riscv64-gui-20260528T212853Z.iso"

docker run --rm --network host --entrypoint bash \
    -v "${HERE}:/work:rw" \
    elizaos-linux-builder -lc "
        set -e
        if ! command -v bsdtar >/dev/null 2>&1; then
            apt-get update -o Acquire::Languages=none >/dev/null 2>&1
            apt-get install -y --no-install-recommends libarchive-tools >/dev/null 2>&1
        fi
        cd /work
        bash scripts/qemu_virt_boot_riscv64.sh \
            --iso out/${ISO_NAME} \
            --memory 4096 --cpus 4 --timeout 3600 \
            --evidence evidence/riscv64_gui_qemu_virt_boot.json \
            --transcript evidence/riscv64_gui_qemu_virt_boot.transcript.log
    "
echo "IN_CONTAINER_BOOT_DONE rc=$?"
