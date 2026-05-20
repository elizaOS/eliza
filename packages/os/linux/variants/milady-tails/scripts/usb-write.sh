#!/usr/bin/env bash
# Safety-guarded USB writer for elizaOS Live USB images.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

stat_size() {
    stat -c%s "$1" 2>/dev/null || stat -f %z "$1"
}

red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }

DEVICE="${1:-}"
IMAGE="${2:-}"
IMAGE_SIGNATURE="${ELIZAOS_ISO_SIGNATURE:-${ELIZAOS_IMAGE_SIGNATURE:-}}"
REQUIRE_SIGNATURE="${ELIZAOS_REQUIRE_ISO_SIGNATURE:-0}"
CREATE_IMAGE_FROM_ISO="${ELIZAOS_CREATE_USB_IMAGE_FROM_ISO:-0}"
ALLOW_ISO_USB_WRITE="${ELIZAOS_ALLOW_ISO_USB_WRITE:-0}"

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

if [ -z "${IMAGE}" ]; then
    IMAGE="$(ls -t out/*.img 2>/dev/null | head -1 || true)"
    if [ -z "${IMAGE}" ]; then
        IMAGE="$(ls -t out/*.iso 2>/dev/null | head -1 || true)"
    fi
fi

if [ -z "${IMAGE}" ] || [ ! -f "${IMAGE}" ]; then
    red "No USB image found. Pass a .img path or run 'just build' and create the .img artifact."
    exit 2
fi

if [ ! -b "${DEVICE}" ]; then
    red "Not a block device: ${DEVICE}"
    exit 2
fi

file_out="$(file -b "${IMAGE}")"
case "${IMAGE}" in
    *.iso)
        if [ "${ALLOW_ISO_USB_WRITE}" != "1" ]; then
            image_from_iso="${IMAGE%.iso}.img"
            if [ -f "${image_from_iso}" ]; then
                yellow "Using USB image next to ISO: ${image_from_iso}"
                IMAGE="${image_from_iso}"
                file_out="$(file -b "${IMAGE}")"
            elif [ "${CREATE_IMAGE_FROM_ISO}" = "1" ]; then
                yellow "Creating persistence-compatible USB image from ${IMAGE}"
                sudo tails/auto/scripts/create-usb-image-from-iso "${IMAGE}" -d "$(dirname "${IMAGE}")"
                IMAGE="${image_from_iso}"
                file_out="$(file -b "${IMAGE}")"
            else
                red "Refusing to write ISO directly to USB."
                red "Tails 7.x/elizaOS Live persistence expects the USB-image layout, not a raw ISO write."
                red "Create ${image_from_iso} first, or set ELIZAOS_CREATE_USB_IMAGE_FROM_ISO=1."
                exit 2
            fi
        fi
        ;;
esac

if ! printf '%s' "${file_out}" | grep -qiE "ISO 9660|boot sector|partition|disk image|GUID Partition Table"; then
    red "File does not look like an ISO or raw USB image:"
    red "  ${file_out}"
    exit 2
fi

if printf '%s' "${file_out}" | grep -qi "ISO 9660"; then
    yellow "WARNING: writing an ISO directly is for explicit override/testing only."
    yellow "Persistent Storage may reject devices that were not created from the USB image."
fi
image_is_iso=0
if printf '%s' "${file_out}" | grep -qi "ISO 9660"; then
    image_is_iso=1
fi

if [ "${image_is_iso}" != "1" ] && ! command -v sgdisk >/dev/null 2>&1; then
    red "sgdisk is required to prepare a cloned USB image for Persistent Storage."
    red "Install gdisk, then rerun this writer."
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

if [ -f "${IMAGE}.sha256" ]; then
    yellow "Verifying ${IMAGE}.sha256"
    (cd "$(dirname "${IMAGE}")" && sha256sum -c "$(basename "${IMAGE}").sha256" >/dev/null)
    green "sha256 ok"
fi

if [ -z "${IMAGE_SIGNATURE}" ] && [ -f "${IMAGE}.sig" ]; then
    IMAGE_SIGNATURE="${IMAGE}.sig"
fi

find_release_keyring() {
    for keyring in \
        "${ELIZAOS_RELEASE_KEYRING:-}" \
        "${ROOT}/keys/elizaos-release.gpg" \
        "${ROOT}/tails/config/chroot_local-includes/usr/share/keyrings/elizaos-release.gpg" \
        /usr/share/keyrings/elizaos-release.gpg \
        /etc/elizaos/release-keyring.gpg
    do
        [ -n "${keyring}" ] || continue
        [ -r "${keyring}" ] || continue
        printf '%s\n' "${keyring}"
        return 0
    done
    return 1
}

if [ -n "${IMAGE_SIGNATURE}" ] || [ "${REQUIRE_SIGNATURE}" = "1" ]; then
    [ -n "${IMAGE_SIGNATURE}" ] || IMAGE_SIGNATURE="${IMAGE}.sig"
    if [ ! -f "${IMAGE_SIGNATURE}" ]; then
        red "Missing image signature: ${IMAGE_SIGNATURE}"
        exit 2
    fi
    command -v gpgv >/dev/null 2>&1 || {
        red "gpgv is required to verify image signatures."
        exit 2
    }
    if ! release_keyring="$(find_release_keyring)"; then
        red "No elizaOS release keyring found. Set ELIZAOS_RELEASE_KEYRING."
        exit 2
    fi
    yellow "Verifying image signature with ${release_keyring}"
    gpgv --keyring "${release_keyring}" "${IMAGE_SIGNATURE}" "${IMAGE}" >/dev/null
    green "signature ok"
fi

image_bytes="$(stat_size "${IMAGE}")"
image_mib=$((image_bytes / 1024 / 1024))
dev_sectors="$(cat "${sys_dev}/size")"
dev_gib=$((dev_sectors * 512 / 1024 / 1024 / 1024))
dev_model="$(cat "${sys_dev}/device/model" 2>/dev/null | tr -s ' ' || echo unknown)"
dev_vendor="$(cat "${sys_dev}/device/vendor" 2>/dev/null | tr -s ' ' || echo unknown)"

echo
bold "About to write elizaOS Live to a USB device"
echo
echo "  Image:  ${IMAGE} (${image_mib} MiB)"
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
    pv -s "${image_bytes}" -- "${IMAGE}" | sudo dd of="${DEVICE}" bs=4M oflag=direct conv=fsync
else
    sudo dd if="${IMAGE}" of="${DEVICE}" bs=4M oflag=direct conv=fsync status=progress
fi

yellow "Syncing kernel writeback."
sync
sudo blockdev --flushbufs "${DEVICE}" 2>/dev/null || true
sync

if [ "${image_is_iso}" != "1" ]; then
    yellow "Moving backup GPT header to the end of the USB device."
    sudo sgdisk --move-second-header "${DEVICE}" >/dev/null
    sudo partprobe "${DEVICE}" 2>/dev/null || sudo blockdev --rereadpt "${DEVICE}" 2>/dev/null || true
    sudo udevadm settle 2>/dev/null || true
    sudo blockdev --flushbufs "${DEVICE}" 2>/dev/null || true
    sync
fi

green "Done. You can remove the USB device after the activity light stops."
