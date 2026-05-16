#!/usr/bin/env bash
# Safety-guarded USB writer for elizaOS Live ISOs.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }

DEVICE="${1:-}"
ISO="${2:-}"

if [ -z "${DEVICE}" ]; then
    red "Usage: $0 /dev/sdX [iso-path]"
    red ""
    red "Likely removable candidates:"
    for d in /sys/block/sd*; do
        [ -e "${d}/removable" ] || continue
        [ "$(cat "${d}/removable" 2>/dev/null || echo 0)" = "1" ] || continue
        name="$(basename "${d}")"
        sectors="$(cat "${d}/size" 2>/dev/null || echo 0)"
        gib=$((sectors * 512 / 1024 / 1024 / 1024))
        model="$(cat "${d}/device/model" 2>/dev/null | tr -s ' ' || echo unknown)"
        red "  /dev/${name} (${gib} GiB, ${model})"
    done
    exit 2
fi

if [ -z "${ISO}" ]; then
    ISO="$(ls -t out/*.iso 2>/dev/null | head -1 || true)"
fi

if [ -z "${ISO}" ] || [ ! -f "${ISO}" ]; then
    red "No ISO found. Pass a path or run 'just build'."
    exit 2
fi

if [ ! -b "${DEVICE}" ]; then
    red "Not a block device: ${DEVICE}"
    exit 2
fi

file_out="$(file -b "${ISO}")"
if ! printf '%s' "${file_out}" | grep -qi "ISO 9660"; then
    red "File does not look like an ISO:"
    red "  ${file_out}"
    exit 2
fi

dev_name="$(basename "${DEVICE}")"
sys_dev="/sys/block/${dev_name}"
if [ ! -d "${sys_dev}" ]; then
    red "${DEVICE} has no /sys/block entry. Refusing to write."
    exit 3
fi

root_source="$(findmnt -n -o SOURCE / 2>/dev/null || true)"
root_dev=""
if [ -n "${root_source}" ]; then
    root_dev="$(readlink -f "${root_source}" 2>/dev/null || true)"
fi
while [ -n "${root_dev}" ] && [ -b "${root_dev}" ]; do
    if [ "${DEVICE}" = "${root_dev}" ]; then
        red "REFUSING to write to ${DEVICE}; it is the root filesystem device or one of its parents."
        exit 3
    fi
    parent="$(lsblk -no PKNAME "${root_dev}" 2>/dev/null | head -1 || true)"
    [ -n "${parent}" ] || break
    root_dev="/dev/${parent}"
done

case "${dev_name}" in
    nvme*n*|mmcblk*)
        red "REFUSING to write to ${DEVICE}; NVMe/eMMC devices are commonly internal disks."
        red "Use a removable USB mass-storage device."
        exit 3
        ;;
esac

removable="$(cat "${sys_dev}/removable" 2>/dev/null || echo 0)"
if [ "${removable}" != "1" ]; then
    red "${DEVICE} reports removable=${removable}. Refusing to write."
    red "This guard prevents accidental internal-disk writes."
    exit 3
fi

if lsblk -nrpo MOUNTPOINT "${DEVICE}" 2>/dev/null | grep -qE '/.'; then
    red "Partitions on ${DEVICE} are mounted:"
    lsblk -po NAME,SIZE,MODEL,MOUNTPOINT "${DEVICE}" >&2 || true
    red "Unmount them first."
    exit 3
fi

if [ -f "${ISO}.sha256" ]; then
    yellow "Verifying ${ISO}.sha256"
    (cd "$(dirname "${ISO}")" && sha256sum -c "$(basename "${ISO}").sha256" >/dev/null)
    green "sha256 ok"
fi

iso_bytes="$(stat -c%s "${ISO}")"
iso_mib=$((iso_bytes / 1024 / 1024))
dev_sectors="$(cat "${sys_dev}/size")"
dev_gib=$((dev_sectors * 512 / 1024 / 1024 / 1024))
dev_model="$(cat "${sys_dev}/device/model" 2>/dev/null | tr -s ' ' || echo unknown)"
dev_vendor="$(cat "${sys_dev}/device/vendor" 2>/dev/null | tr -s ' ' || echo unknown)"

echo
bold "About to write elizaOS Live to a USB device"
echo
echo "  ISO:    ${ISO} (${iso_mib} MiB)"
echo "  Target: ${DEVICE}"
echo "  Size:   ${dev_gib} GiB"
echo "  Vendor: ${dev_vendor}"
echo "  Model:  ${dev_model}"
echo
yellow "ALL DATA ON ${DEVICE} WILL BE DESTROYED."
echo
read -r -p "Type '${DEVICE}' to confirm: " confirm
if [ "${confirm}" != "${DEVICE}" ]; then
    red "Aborted."
    exit 1
fi

echo
yellow "Writing. Do not remove the USB device until sync completes."
if command -v pv >/dev/null 2>&1; then
    pv -s "${iso_bytes}" -- "${ISO}" | sudo dd of="${DEVICE}" bs=4M oflag=direct conv=fsync
else
    sudo dd if="${ISO}" of="${DEVICE}" bs=4M oflag=direct conv=fsync status=progress
fi

yellow "Syncing kernel writeback."
sync
sudo blockdev --flushbufs "${DEVICE}" 2>/dev/null || true
sync
green "Done. You can remove the USB device after the activity light stops."
