#!/usr/bin/env bash
# Validates the release ISO's BIOS/UEFI boot equipment, then boots its real
# kernel, initramfs, and live filesystem through a deterministic serial console.

set -euo pipefail

ISO="${1:-}"
QEMU_BIN="${ELIZAOS_QEMU_BIN:-qemu-system-x86_64}"
XORRISO_BIN="${ELIZAOS_XORRISO_BIN:-xorriso}"
BOOT_TIMEOUT_SECONDS="${ELIZAOS_ISO_SMOKE_TIMEOUT_SECONDS:-300}"
POLL_SECONDS="${ELIZAOS_ISO_SMOKE_POLL_SECONDS:-2}"

fail() {
    echo "ERROR: $*" >&2
    exit 1
}

case "${BOOT_TIMEOUT_SECONDS}" in
    ""|*[!0-9]*|0)
        fail "ELIZAOS_ISO_SMOKE_TIMEOUT_SECONDS must be a positive integer"
        ;;
esac

[ -n "${ISO}" ] || fail "usage: $0 <iso-path>"
[ -f "${ISO}" ] || fail "ISO not found: ${ISO}"
command -v "${QEMU_BIN}" >/dev/null 2>&1 || fail "QEMU not found: ${QEMU_BIN}"
command -v "${XORRISO_BIN}" >/dev/null 2>&1 || fail "xorriso not found: ${XORRISO_BIN}"

TMP="$(mktemp -d)"
QEMU_PID=""

stop_qemu() {
    if [ -n "${QEMU_PID}" ] && kill -0 "${QEMU_PID}" 2>/dev/null; then
        # error-policy:J6 the smoke VM is disposable teardown state.
        kill "${QEMU_PID}" 2>/dev/null || true
        wait "${QEMU_PID}" 2>/dev/null || true
    fi
    QEMU_PID=""
}

# ShellCheck cannot see the indirect invocation from the EXIT trap.
# shellcheck disable=SC2329
cleanup() {
    stop_qemu
    # error-policy:J6 the directory contains only disposable smoke artifacts.
    rm -rf "${TMP}"
}
trap cleanup EXIT

EL_TORITO_REPORT="${TMP}/el-torito.txt"
if ! "${XORRISO_BIN}" \
    -indev "${ISO}" \
    -report_el_torito plain \
    >"${EL_TORITO_REPORT}" 2>&1; then
    cat "${EL_TORITO_REPORT}" >&2
    fail "unable to inspect ISO boot equipment"
fi

if ! grep -Eq \
    'El Torito boot img[[:space:]]*:[[:space:]]*[0-9]+[[:space:]]+BIOS[[:space:]]+y[[:space:]]' \
    "${EL_TORITO_REPORT}"; then
    cat "${EL_TORITO_REPORT}" >&2
    fail "ISO has no bootable BIOS El Torito image"
fi

extract_required() {
    local source_path="$1"
    local destination="$2"
    local extract_log="${TMP}/extract.log"

    if ! "${XORRISO_BIN}" \
        -osirrox on \
        -indev "${ISO}" \
        -extract "${source_path}" "${destination}" \
        >"${extract_log}" 2>&1; then
        cat "${extract_log}" >&2
        fail "required ISO boot asset is missing: ${source_path}"
    fi
    [ -s "${destination}" ] ||
        fail "required ISO boot asset is empty: ${source_path}"
}

KERNEL="${TMP}/vmlinuz"
INITRD="${TMP}/initrd.img"
extract_required "/isolinux/isolinux.bin" "${TMP}/isolinux.bin"
extract_required "/EFI/BOOT/BOOTX64.EFI" "${TMP}/BOOTX64.EFI"
extract_required "/EFI/debian/grub.cfg" "${TMP}/grub.cfg"
extract_required "/live/vmlinuz" "${KERNEL}"
extract_required "/live/initrd.img" "${INITRD}"

SERIAL_LOG="${TMP}/serial.log"
QEMU_STDOUT="${TMP}/qemu.stdout"
QEMU_STDERR="${TMP}/qemu.stderr"
QEMU_ARGS=(
    -machine q35
    -accel kvm
    -accel "tcg,thread=multi"
    -m 4096
    -smp 2
    -kernel "${KERNEL}"
    -initrd "${INITRD}"
    -append "boot=live config live-media=removable nopersistence noprompt timezone=Etc/UTC module=Tails systemd.unit=multi-user.target systemd.show_status=1 loglevel=6 console=tty0 console=ttyS0,115200n8 elizaos_privacy=0"
    -cdrom "${ISO}"
    -boot order=d
    -nic "user,model=virtio-net-pci"
    -device virtio-rng-pci
    -display none
    -vga none
    -serial "file:${SERIAL_LOG}"
    -monitor none
    -no-reboot
    -snapshot
)

echo "ISO boot equipment: BIOS El Torito and UEFI fallback assets present"
echo "Starting headless userspace smoke (timeout: ${BOOT_TIMEOUT_SECONDS}s)"
"${QEMU_BIN}" "${QEMU_ARGS[@]}" >"${QEMU_STDOUT}" 2>"${QEMU_STDERR}" &
QEMU_PID=$!

START_SECONDS="${SECONDS}"
STRONG_MARKER='Started elizaOS local agent runtime \(system-wide\)'
WEAK_MARKER='Linux version|systemd\[1\]|Finished elizaOS first-boot bootstrap|Reached target .*Multi-User|login:'
WEAK_SEEN=0

while ((SECONDS - START_SECONDS < BOOT_TIMEOUT_SECONDS)); do
    if grep -qE "${STRONG_MARKER}" "${SERIAL_LOG}" 2>/dev/null; then
        echo "ISO smoke test: elizaOS system service startup detected"
        stop_qemu
        exit 0
    fi

    if grep -qE "${WEAK_MARKER}" "${SERIAL_LOG}" 2>/dev/null; then
        WEAK_SEEN=1
    fi

    if ! kill -0 "${QEMU_PID}" 2>/dev/null; then
        set +e
        wait "${QEMU_PID}"
        QEMU_STATUS=$?
        set -e
        QEMU_PID=""
        echo "QEMU exited before the required service marker (status ${QEMU_STATUS})" >&2
        tail -200 "${QEMU_STDERR}" >&2 || true
        tail -200 "${SERIAL_LOG}" >&2 || true
        fail "ISO userspace smoke ended before elizaOS startup"
    fi

    sleep "${POLL_SECONDS}"
done

stop_qemu
tail -200 "${QEMU_STDERR}" >&2 || true
tail -200 "${SERIAL_LOG}" >&2 || true
if [ "${WEAK_SEEN}" = "1" ]; then
    fail "ISO reached Linux userspace but did not prove elizaOS service startup"
fi
fail "ISO did not reach Linux userspace before the smoke timeout"
