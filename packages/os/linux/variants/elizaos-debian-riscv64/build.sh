#!/usr/bin/env bash
# elizaOS Debian RISC-V 64 — live-build orchestrator.
#
# Runs end-to-end inside the builder container baked by ./Dockerfile.
# Steps:
#   1. lb config   — apply auto/config to the variant tree.
#   2. lb build    — produce binary.hybrid.iso (multi-GB download,
#                    30+ minute build; intended for the builder host or
#                    a CI runner, not for an interactive sub-agent).
#   3. verify      — fail closed if the ISO is missing, < 200 MiB, or
#                    refuses to parse via an available ISO tool.
#   4. checksum    — sha256 + size, written next to the artifact.
#   5. manifest    — substitute build evidence into
#                    manifest.json.template → out/<name>.manifest.json
#                    and JSON-parse the result.
#
# Intended invocation (do NOT run interactively — the live-build step
# pulls multi-GB from Debian mirrors and takes 30+ minutes):
#
#   docker build -t elizaos-debian-riscv64-builder .
#   docker run --rm --privileged \
#       -v "$(pwd):/build" -v "$(pwd)/out:/out" \
#       elizaos-debian-riscv64-builder
#
# Tunables:
#   ELIZAOS_OUT_DIR         override the host-side output dir.
#   ELIZAOS_MIN_ISO_BYTES   override the 200 MiB minimum (bytes).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${PWD}/manifest.json.template" ] && [ -d "${PWD}/auto" ]; then
    HERE="${PWD}"
else
    HERE="${ELIZAOS_VARIANT_DIR:-${SCRIPT_DIR}}"
fi
OUT="${ELIZAOS_OUT_DIR:-${HERE}/out}"
ARCH="riscv64"
KERNEL_FLAVOUR="riscv64"
BOOTLOADER="grub-efi"
BUILD_TS="$(date -u +%Y%m%dT%H%M%SZ)"
ARTIFACT_BASENAME="elizaos-debian-riscv64-${BUILD_TS}"
MIN_ISO_BYTES="${ELIZAOS_MIN_ISO_BYTES:-209715200}"  # 200 MiB

mkdir -p "${OUT}"

echo "=== elizaOS Debian RISC-V 64 build ==="
echo "    arch:        ${ARCH}"
echo "    kernel:      ${KERNEL_FLAVOUR}"
echo "    bootloader:  ${BOOTLOADER}"
echo "    output dir:  ${OUT}"
echo "    build ts:    ${BUILD_TS}"

# ── Step 1: lb config ────────────────────────────────────────────────
echo
echo "--- step 1/5: lb config ---"
if ! command -v lb >/dev/null 2>&1; then
    echo "ERROR: live-build (lb) not found on PATH. Run inside the builder container." >&2
    exit 1
fi

lb config \
    --distribution trixie \
    --architecture "${ARCH}" \
    --linux-flavours "${KERNEL_FLAVOUR}" \
    --archive-areas "main" \
    --bootloaders "${BOOTLOADER}" \
    --uefi-secure-boot disable

patch_live_build_riscv64_grub_efi() {
    helper="/usr/lib/live/build/binary_grub-efi"
    if [ "${ARCH}" != "riscv64" ] || [ ! -w "${helper}" ]; then
        return
    fi
    if grep -Fq 'riscv64-efi' "${helper}"; then
        return
    fi
    python3 - "${helper}" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
text = text.replace(
    "\tarmhf)\n\t\tCheck_package chroot /usr/lib/grub/arm-efi/configfile.mod grub-efi-arm-bin\n\t\t;;\n",
    "\tarmhf)\n\t\tCheck_package chroot /usr/lib/grub/arm-efi/configfile.mod grub-efi-arm-bin\n\t\t;;\n"
    "\triscv64)\n\t\tCheck_package chroot /usr/lib/grub/riscv64-efi/configfile.mod grub-efi-riscv64-bin\n\t\t;;\n",
)
text = text.replace(
    "\tarmhf)\n\t\t_SB_EFI_PLATFORM=\"arm\"\n\t\t_SB_EFI_NAME=\"arm\"\n\t\t_SB_EFI_DEB=\"arm\"\n\t\t;;\n",
    "\tarmhf)\n\t\t_SB_EFI_PLATFORM=\"arm\"\n\t\t_SB_EFI_NAME=\"arm\"\n\t\t_SB_EFI_DEB=\"arm\"\n\t\t;;\n"
    "\triscv64)\n\t\t_SB_EFI_PLATFORM=\"riscv64\"\n\t\t_SB_EFI_NAME=\"riscv64\"\n\t\t_SB_EFI_DEB=\"riscv64\"\n\t\t;;\n",
)
text = text.replace(
    "\tarmhf)\n\t\tgen_efi_boot_img \"arm-efi\" \"arm\" \"debian-live/arm\"\n\t\tPATH=\"\\${PRE_EFI_IMAGE_PATH}\"\n\t\t;;\n",
    "\tarmhf)\n\t\tgen_efi_boot_img \"arm-efi\" \"arm\" \"debian-live/arm\"\n\t\tPATH=\"\\${PRE_EFI_IMAGE_PATH}\"\n\t\t;;\n"
    "\triscv64)\n\t\tgen_efi_boot_img \"riscv64-efi\" \"riscv64\" \"debian-live/riscv64\"\n\t\tPATH=\"\\${PRE_EFI_IMAGE_PATH}\"\n\t\t;;\n",
)
text = text.replace(
    "rm -rf binary/boot/efi.img binary/boot/grub/i386-efi/ binary/boot/grub/x86_64-efi binary/boot/grub/arm64-efi binary/boot/grub/arm-efi",
    "rm -rf binary/boot/efi.img binary/boot/grub/i386-efi/ binary/boot/grub/x86_64-efi binary/boot/grub/arm64-efi binary/boot/grub/arm-efi binary/boot/grub/riscv64-efi",
)
text = text.replace(
    "rm -rf chroot/grub-efi-temp-arm-efi\nrm -rf chroot/grub-efi-temp-cfg",
    "rm -rf chroot/grub-efi-temp-arm-efi\nrm -rf chroot/grub-efi-temp-riscv64-efi\nrm -rf chroot/grub-efi-temp-cfg",
)
text = text.replace(
    "\t\tRemove_packages\n\t\tAPT_OPTIONS=\"${PRE_APT_OPTIONS}\"",
    "\t\tRemove_packages || true\n\t\tAPT_OPTIONS=\"${PRE_APT_OPTIONS}\"",
)
path.write_text(text)
PY
}

patch_live_build_riscv64_grub_efi

# ── Step 2: lb build ─────────────────────────────────────────────────
echo
echo "--- step 2/5: lb build ---"
lb build

# ── Step 3: verify artifact ──────────────────────────────────────────
echo
echo "--- step 3/5: verify artifact ---"
ARTIFACT_SRC=""
for candidate in "${HERE}/binary.hybrid.iso" "${HERE}/live-image-${ARCH}.hybrid.iso" "${HERE}/binary.img"; do
    if [ -f "${candidate}" ]; then
        ARTIFACT_SRC="${candidate}"
        break
    fi
done

if [ -z "${ARTIFACT_SRC}" ]; then
    echo "ERROR: no live-build output artifact found (expected binary.hybrid.iso / live-image-${ARCH}.hybrid.iso / binary.img)" >&2
    exit 1
fi

ARTIFACT_SIZE="$(stat -c %s "${ARTIFACT_SRC}")"
if [ "${ARTIFACT_SIZE}" -lt "${MIN_ISO_BYTES}" ]; then
    echo "ERROR: artifact ${ARTIFACT_SRC} is ${ARTIFACT_SIZE} bytes (< ${MIN_ISO_BYTES} byte floor)." >&2
    echo "  This is too small to plausibly contain Debian + linux-image-riscv64; build is broken." >&2
    exit 1
fi

case "${ARTIFACT_SRC}" in
    *.iso)
        # Prefer libcdio's iso-info; fall back to genisoimage's
        # isoinfo or xorriso. If none is present, fail closed.
        if command -v iso-info >/dev/null 2>&1; then
            iso-info "${ARTIFACT_SRC}" >/dev/null
        elif command -v isoinfo >/dev/null 2>&1; then
            isoinfo -d -i "${ARTIFACT_SRC}" >/dev/null
        elif command -v xorriso >/dev/null 2>&1; then
            xorriso -indev "${ARTIFACT_SRC}" -toc >/dev/null
        else
            echo "ERROR: no ISO inspection tool available; cannot verify ISO is parseable." >&2
            exit 1
        fi
        ;;
    *.img)
        # Raw images: confirm the file is a recognisable filesystem or
        # partition-table image. `file` ships in the builder.
        if ! file "${ARTIFACT_SRC}" | grep -Eqi 'boot sector|partition|filesystem|DOS/MBR'; then
            echo "ERROR: ${ARTIFACT_SRC} does not look like a bootable image." >&2
            exit 1
        fi
        ;;
esac

ARTIFACT_EXT="${ARTIFACT_SRC##*.}"
ARTIFACT_DST="${OUT}/${ARTIFACT_BASENAME}.${ARTIFACT_EXT}"
cp "${ARTIFACT_SRC}" "${ARTIFACT_DST}"

# ── Step 4: checksum ─────────────────────────────────────────────────
echo
echo "--- step 4/5: checksum ---"
ARTIFACT_SHA256="$(sha256sum "${ARTIFACT_DST}" | awk '{ print $1 }')"
ARTIFACT_SIZE="$(stat -c %s "${ARTIFACT_DST}")"
echo "    artifact: ${ARTIFACT_DST}"
echo "    sha256:   ${ARTIFACT_SHA256}"
echo "    size:     ${ARTIFACT_SIZE} bytes"

if ! printf '%s' "${ARTIFACT_SHA256}" | grep -Eq '^[a-f0-9]{64}$'; then
    echo "ERROR: computed sha256 ${ARTIFACT_SHA256} does not match the schema pattern." >&2
    exit 1
fi

# ── Step 5: emit manifest fragment ───────────────────────────────────
echo
echo "--- step 5/5: emit manifest fragment ---"
MANIFEST_TEMPLATE="${HERE}/manifest.json.template"
MANIFEST_OUT="${OUT}/${ARTIFACT_BASENAME}.manifest.json"

if [ ! -f "${MANIFEST_TEMPLATE}" ]; then
    echo "ERROR: missing manifest template at ${MANIFEST_TEMPLATE}" >&2
    exit 1
fi

sed \
    -e "s|@@FILENAME@@|${ARTIFACT_BASENAME}.${ARTIFACT_EXT}|g" \
    -e "s|@@SHA256@@|${ARTIFACT_SHA256}|g" \
    -e "s|@@SIZE_BYTES@@|${ARTIFACT_SIZE}|g" \
    -e "s|@@BUILD_TIMESTAMP@@|${BUILD_TS}|g" \
    -e "s|@@ARCH@@|${ARCH}|g" \
    -e "s|@@KERNEL_FLAVOUR@@|${KERNEL_FLAVOUR}|g" \
    "${MANIFEST_TEMPLATE}" > "${MANIFEST_OUT}"

if command -v python3 >/dev/null 2>&1; then
    if ! python3 -c "import json,sys; json.load(open('${MANIFEST_OUT}'))"; then
        echo "ERROR: emitted manifest ${MANIFEST_OUT} is not valid JSON." >&2
        exit 1
    fi
fi

echo "    manifest: ${MANIFEST_OUT}"
echo
echo "=== build complete ==="
