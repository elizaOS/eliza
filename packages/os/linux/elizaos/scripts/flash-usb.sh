#!/usr/bin/env bash
# elizaOS Linux Live — guarded USB flasher (Linux host).
#
# Safety rails (per packages/os/CLAUDE.md "USB Flasher" requirements):
#   - shows only eligible removable drives
#   - displays device path, model, serial, capacity, partitions, mounts
#   - verifies image SHA256 against the sidecar .sha256 file before writing
#   - requires destructive confirmation with the exact target device
#   - refuses internal/root disks and the disk holding /
#   - writes, syncs, then verifies a head-of-device readback
#   - writes a non-secret install log next to the ISO
#
# Usage:
#   sudo packages/os/linux/elizaos/scripts/flash-usb.sh \
#     --iso packages/os/linux/elizaos/out/elizaos-linux-amd64-default-<stamp>.iso
#
# Without --device the script lists eligible removable drives and asks you to
# pick one. macOS hosts: use a different tool (this script is Linux-only).

set -euo pipefail

ISO=""
DEVICE=""
ASSUME_YES=0

usage() {
    cat >&2 <<EOF
Usage: $0 --iso <iso-path> [--device /dev/sdX] [--yes]

  --iso PATH       Path to elizaos-linux-*.iso (must have <iso>.sha256 sibling).
  --device DEV     Target block device (e.g. /dev/sdb). If omitted, interactive.
  --yes            Skip the final type-the-device-path confirmation prompt.
                   (You will still see all device info before the write.)

This tool is destructive. It writes the raw ISO to the entire target device,
erasing any existing partitions. Internal/root disks are refused.
EOF
    exit 2
}

while [ $# -gt 0 ]; do
    case "$1" in
        --iso) ISO="$2"; shift 2 ;;
        --device) DEVICE="$2"; shift 2 ;;
        --yes) ASSUME_YES=1; shift ;;
        -h|--help) usage ;;
        *) echo "unknown arg: $1" >&2; usage ;;
    esac
done

[ -n "${ISO}" ] || usage
[ -f "${ISO}" ] || { echo "FATAL: ISO not found: ${ISO}" >&2; exit 1; }
[ -f "${ISO}.sha256" ] || { echo "FATAL: missing ${ISO}.sha256 sidecar" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "FATAL: must run as root (sudo)" >&2; exit 1; }

echo "==> Verifying ISO checksum…"
( cd "$(dirname "${ISO}")" && sha256sum -c "$(basename "${ISO}").sha256" )

# Identify the disk that holds / so we never overwrite it.
ROOT_SRC="$(findmnt -no SOURCE /)"
ROOT_DISK="/dev/$(lsblk -no PKNAME "${ROOT_SRC}" 2>/dev/null || true)"
[ -b "${ROOT_DISK}" ] || ROOT_DISK="${ROOT_SRC}"
echo "==> Root filesystem is on ${ROOT_DISK} (refuse-list)."

# Collect eligible removable devices: RM=1, TYPE=disk, not the root disk.
mapfile -t ELIGIBLE < <(
    lsblk -dpno NAME,TYPE,RM,SIZE,MODEL,SERIAL | awk '$2=="disk" && $3=="1" {print $0}'
)

list_devices() {
    printf '\n  %-12s %-10s %-30s %-20s\n' "DEVICE" "SIZE" "MODEL" "SERIAL"
    printf '  %s\n' "------------------------------------------------------------------------------------"
    for line in "${ELIGIBLE[@]}"; do
        # NAME TYPE RM SIZE MODEL... SERIAL (model may have spaces; serial is last)
        dev=$(echo "$line" | awk '{print $1}')
        size=$(echo "$line" | awk '{print $4}')
        serial=$(echo "$line" | awk '{print $NF}')
        model=$(echo "$line" | cut -d' ' -f5- | sed "s/ ${serial}$//")
        printf '  %-12s %-10s %-30s %-20s\n' "$dev" "$size" "$model" "$serial"
    done
    echo
}

if [ ${#ELIGIBLE[@]} -eq 0 ]; then
    echo "FATAL: no removable disks found. Plug a USB stick and re-run." >&2
    exit 1
fi

if [ -z "${DEVICE}" ]; then
    echo "==> Eligible removable disks:"
    list_devices
    read -r -p "Enter target device path (e.g. /dev/sdb): " DEVICE
fi

# Validate the chosen device.
[ -b "${DEVICE}" ] || { echo "FATAL: ${DEVICE} is not a block device" >&2; exit 1; }
case "${DEVICE}" in
    "${ROOT_DISK}"|"${ROOT_DISK}"[0-9]*)
        echo "FATAL: refusing to write to root disk ${ROOT_DISK}" >&2; exit 1 ;;
esac
RM_FLAG=$(lsblk -dno RM "${DEVICE}" 2>/dev/null || echo "")
if [ "${RM_FLAG}" != "1" ]; then
    echo "FATAL: ${DEVICE} is not marked removable (RM=${RM_FLAG}); refusing." >&2
    exit 1
fi

# Show full picture: model, serial, capacity, partitions, mounts.
echo
echo "==> Target device details:"
lsblk -o NAME,SIZE,TYPE,MODEL,SERIAL,FSTYPE,LABEL,MOUNTPOINT "${DEVICE}"
echo
echo "==> ISO: ${ISO}"
ISO_SIZE=$(stat -c %s "${ISO}")
DEV_SIZE=$(blockdev --getsize64 "${DEVICE}")
printf '   ISO size:    %s bytes (%.1f MB)\n' "${ISO_SIZE}" "$(echo "${ISO_SIZE} 1048576" | awk '{print $1/$2}')"
printf '   Device size: %s bytes (%.1f MB)\n' "${DEV_SIZE}" "$(echo "${DEV_SIZE} 1048576" | awk '{print $1/$2}')"
if [ "${DEV_SIZE}" -lt "${ISO_SIZE}" ]; then
    echo "FATAL: device is smaller than the ISO" >&2
    exit 1
fi

# Unmount anything currently mounted from this device.
for part in $(lsblk -lnpo NAME "${DEVICE}" | tail -n +2); do
    mp=$(lsblk -no MOUNTPOINT "${part}")
    if [ -n "${mp}" ]; then
        echo "==> Unmounting ${part} from ${mp}"
        umount "${part}"
    fi
done

if [ "${ASSUME_YES}" -ne 1 ]; then
    echo
    echo "==> DESTRUCTIVE WRITE about to begin."
    echo "    This will OVERWRITE all data on ${DEVICE}."
    read -r -p "    Type the device path exactly to confirm (or anything else to abort): " CONFIRM
    if [ "${CONFIRM}" != "${DEVICE}" ]; then
        echo "Aborted (got '${CONFIRM}', expected '${DEVICE}')." >&2
        exit 1
    fi
fi

LOG="${ISO}.flash-$(date -u +%Y%m%dT%H%M%SZ).log"
echo "==> Writing ${ISO} -> ${DEVICE} (log: ${LOG})"
{
    echo "iso=${ISO}"
    echo "iso_sha256=$(awk '{print $1}' "${ISO}.sha256")"
    echo "device=${DEVICE}"
    echo "device_model=$(lsblk -dno MODEL "${DEVICE}" | tr -s ' ')"
    echo "device_serial=$(lsblk -dno SERIAL "${DEVICE}")"
    echo "device_size_bytes=${DEV_SIZE}"
    echo "started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "${LOG}"

dd if="${ISO}" of="${DEVICE}" bs=4M conv=fsync status=progress
sync; sync

echo "==> Verifying head-of-device readback (first ${ISO_SIZE} bytes)…"
ISO_HASH=$(sha256sum "${ISO}" | awk '{print $1}')
DEV_HASH=$(head -c "${ISO_SIZE}" "${DEVICE}" | sha256sum | awk '{print $1}')
{
    echo "finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "iso_sha256_recomputed=${ISO_HASH}"
    echo "device_head_sha256=${DEV_HASH}"
    if [ "${ISO_HASH}" = "${DEV_HASH}" ]; then
        echo "verify=OK"
    else
        echo "verify=MISMATCH"
    fi
} >> "${LOG}"

if [ "${ISO_HASH}" != "${DEV_HASH}" ]; then
    echo "FATAL: readback mismatch. ISO=${ISO_HASH} DEV=${DEV_HASH}" >&2
    exit 1
fi
echo "==> OK. Flashed and verified ${DEVICE}."
echo "==> Install log: ${LOG}"
echo
echo "NEXT (optional): create a second FAT partition labeled ELIZAOS-EVIDENCE"
echo "  on the remaining free space of ${DEVICE} to enable evidence capture."
echo "  See packages/os/linux/elizaos/docs/real-hw-flash-test-runbook.md"
