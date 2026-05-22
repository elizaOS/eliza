#!/usr/bin/env bash
# elizaOS Linux — unified multi-arch ISO build orchestrator.
#
# Runs end-to-end inside the builder container baked by ./Dockerfile.
# Steps:
#   1. lb config   — apply auto/config (arch-parameterized) to the tree.
#   2. lb build    — produce binary.hybrid.iso.
#   3. verify      — fail closed on missing/undersized/unparseable ISO.
#   4. checksum    — sha256 + size, written next to the artifact.
#   5. manifest    — substitute build evidence into
#                    manifest.json.template → out/<name>.manifest.json.
#
# Invocation:
#   docker build -t elizaos-linux-builder --build-arg ELIZAOS_ARCH=amd64 .
#   docker run --rm --privileged \
#       -e ELIZAOS_ARCH=amd64 \
#       -v "$(pwd):/build" -v "$(pwd)/out:/out" \
#       elizaos-linux-builder
#
# Tunables:
#   ELIZAOS_ARCH            amd64 | arm64 | riscv64 (default: amd64)
#   ELIZAOS_PROFILE         default | secure
#   ELIZAOS_OUT_DIR         override host-side output dir
#   ELIZAOS_MIN_ISO_BYTES   override 200 MiB minimum
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERE="${ELIZAOS_VARIANT_DIR:-${SCRIPT_DIR}}"
OUT="${ELIZAOS_OUT_DIR:-${HERE}/out}"

ARCH="${ELIZAOS_ARCH:-amd64}"
PROFILE="${ELIZAOS_PROFILE:-default}"
BUILD_TS="$(date -u +%Y%m%dT%H%M%SZ)"
ARTIFACT_BASENAME="elizaos-linux-${ARCH}-${PROFILE}-${BUILD_TS}"
MIN_ISO_BYTES="${ELIZAOS_MIN_ISO_BYTES:-209715200}"

mkdir -p "${OUT}"

if ! command -v lb >/dev/null 2>&1; then
    echo "ERROR: live-build (lb) not found on PATH. Run inside the builder container." >&2
    exit 1
fi

ensure_foreign_binfmt() {
    case "${ARCH}" in
        amd64)
            return 0
            ;;
        arm64)
            BINFMT_NAME=qemu-aarch64
            ;;
        riscv64)
            BINFMT_NAME=qemu-riscv64
            ;;
        *)
            echo "ERROR: unsupported ELIZAOS_ARCH=${ARCH}" >&2
            exit 64
            ;;
    esac

    if [ "$(dpkg --print-architecture 2>/dev/null || true)" = "${ARCH}" ]; then
        return 0
    fi

    echo "    ensuring ${BINFMT_NAME} binfmt_misc registration..."

    if [ ! -d /proc/sys/fs/binfmt_misc ]; then
        echo "ERROR: /proc/sys/fs/binfmt_misc missing; foreign ${ARCH} bootstrap cannot run." >&2
        exit 65
    fi

    if [ ! -e /proc/sys/fs/binfmt_misc/register ]; then
        mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc 2>/dev/null || true
    fi

    if [ ! -e /proc/sys/fs/binfmt_misc/register ]; then
        echo "ERROR: binfmt_misc is not mounted; run the builder container with --privileged." >&2
        exit 65
    fi

    if [ -e "/proc/sys/fs/binfmt_misc/${BINFMT_NAME}" ]; then
        if grep -q '^enabled' "/proc/sys/fs/binfmt_misc/${BINFMT_NAME}"; then
            return 0
        fi
        echo 1 >"/proc/sys/fs/binfmt_misc/${BINFMT_NAME}" 2>/dev/null || true
        if grep -q '^enabled' "/proc/sys/fs/binfmt_misc/${BINFMT_NAME}"; then
            return 0
        fi
        echo -1 >"/proc/sys/fs/binfmt_misc/${BINFMT_NAME}" 2>/dev/null || true
    fi

    BINFMT_CONF="/usr/lib/binfmt.d/${BINFMT_NAME}.conf"
    if [ ! -r "${BINFMT_CONF}" ]; then
        BINFMT_CONF="/usr/share/qemu/binfmt.d/${BINFMT_NAME}.conf"
    fi

    if [ ! -r "${BINFMT_CONF}" ]; then
        echo "ERROR: no ${BINFMT_NAME} binfmt config found in the builder image." >&2
        exit 65
    fi

    BINFMT_LINE="$(sed -n '1p' "${BINFMT_CONF}")"
    if [ -z "${BINFMT_LINE}" ]; then
        echo "ERROR: ${BINFMT_CONF} is empty." >&2
        exit 65
    fi

    printf '%s\n' "${BINFMT_LINE}" >/proc/sys/fs/binfmt_misc/register

    if [ ! -e "/proc/sys/fs/binfmt_misc/${BINFMT_NAME}" ] ||
        ! grep -q '^enabled' "/proc/sys/fs/binfmt_misc/${BINFMT_NAME}"; then
        echo "ERROR: failed to register ${BINFMT_NAME} with binfmt_misc." >&2
        exit 65
    fi
}

patch_live_build_riscv64_grub_efi() {
    if [ "${ARCH}" != "riscv64" ]; then
        return 0
    fi

    GRUB_EFI_SCRIPT="/usr/lib/live/build/binary_grub-efi"
    if [ ! -w "${GRUB_EFI_SCRIPT}" ]; then
        echo "ERROR: cannot patch ${GRUB_EFI_SCRIPT}; builder image is not writable." >&2
        exit 66
    fi
    if grep -q 'grub-efi-riscv64-bin' "${GRUB_EFI_SCRIPT}"; then
        return 0
    fi

    echo "    patching live-build grub-efi support for riscv64..."
    python3 - "${GRUB_EFI_SCRIPT}" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()

replacements = [
    (
        '\tarmhf)\n'
        '\t\tCheck_package chroot /usr/lib/grub/arm-efi/configfile.mod grub-efi-arm-bin\n'
        '\t\t;;\n',
        '\tarmhf)\n'
        '\t\tCheck_package chroot /usr/lib/grub/arm-efi/configfile.mod grub-efi-arm-bin\n'
        '\t\t;;\n'
        '\triscv64)\n'
        '\t\tCheck_package chroot /usr/lib/grub/riscv64-efi/configfile.mod grub-efi-riscv64-bin\n'
        '\t\t;;\n',
    ),
    (
        '\tarmhf)\n'
        '\t\t_SB_EFI_PLATFORM="arm"\n'
        '\t\t_SB_EFI_NAME="arm"\n'
        '\t\t_SB_EFI_DEB="arm"\n'
        '\t\t;;\n',
        '\tarmhf)\n'
        '\t\t_SB_EFI_PLATFORM="arm"\n'
        '\t\t_SB_EFI_NAME="arm"\n'
        '\t\t_SB_EFI_DEB="arm"\n'
        '\t\t;;\n'
        '\triscv64)\n'
        '\t\t_SB_EFI_PLATFORM="riscv64"\n'
        '\t\t_SB_EFI_NAME="riscv64"\n'
        '\t\t_SB_EFI_DEB="riscv64"\n'
        '\t\t;;\n',
    ),
    (
        'binary/boot/grub/arm64-efi binary/boot/grub/arm-efi',
        'binary/boot/grub/arm64-efi binary/boot/grub/riscv64-efi binary/boot/grub/arm-efi',
    ),
    (
        '\tarmhf)\n'
        '\t\tgen_efi_boot_img "arm-efi" "arm" "debian-live/arm"\n'
        '\t\tPATH="\\${PRE_EFI_IMAGE_PATH}"\n'
        '\t\t;;\n',
        '\tarmhf)\n'
        '\t\tgen_efi_boot_img "arm-efi" "arm" "debian-live/arm"\n'
        '\t\tPATH="\\${PRE_EFI_IMAGE_PATH}"\n'
        '\t\t;;\n'
        '\triscv64)\n'
        '\t\tgen_efi_boot_img "riscv64-efi" "riscv64" "debian-live/riscv64"\n'
        '\t\tPATH="\\${PRE_EFI_IMAGE_PATH}"\n'
        '\t\t;;\n',
    ),
    (
        'rm -rf chroot/grub-efi-temp-arm-efi\n',
        'rm -rf chroot/grub-efi-temp-arm-efi\n'
        'rm -rf chroot/grub-efi-temp-riscv64-efi\n',
    ),
]

for old, new in replacements:
    if old not in text:
        raise SystemExit(f"live-build riscv64 grub-efi patch anchor missing: {old!r}")
    text = text.replace(old, new, 1)

path.write_text(text)
PY

    if ! grep -q 'gen_efi_boot_img "riscv64-efi" "riscv64"' "${GRUB_EFI_SCRIPT}"; then
        echo "ERROR: failed to patch live-build riscv64 grub-efi support." >&2
        exit 66
    fi
}

patch_debootstrap_curl_downloader() {
    FUNCTIONS="/usr/share/debootstrap/functions"
    if [ ! -w "${FUNCTIONS}" ]; then
        echo "ERROR: cannot patch ${FUNCTIONS}; builder image is not writable." >&2
        exit 67
    fi
    if grep -q 'elizaOS curl downloader patch' "${FUNCTIONS}"; then
        return 0
    fi

    echo "    patching debootstrap downloader to use curl retries..."
    python3 - "${FUNCTIONS}" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
old = '''\telif [ "${from#http://}" != "$from" ] || [ "${from#https://}" != "$from" ] || [ "${from#ftp://}" != "$from" ]; then
\t\t# http/https/ftp mirror
\t\tif wgetprogress ${CHECKCERTIF:+"$CHECKCERTIF"} ${CERTIFICATE:+"$CERTIFICATE"} ${PRIVATEKEY:+"$PRIVATEKEY"} -O "$dest" "$from"; then
\t\t\treturn 0
\t\telse
\t\t\trm -f "$dest"
\t\t\treturn 1
\t\tfi
'''
new = '''\telif [ "${from#http://}" != "$from" ] || [ "${from#https://}" != "$from" ] || [ "${from#ftp://}" != "$from" ]; then
\t\t# elizaOS curl downloader patch: wget intermittently returned corrupt
\t\t# partial .deb payloads in this builder environment.
\t\tif command -v curl >/dev/null 2>&1 && curl --silent --show-error --fail --location --retry 12 --retry-all-errors --connect-timeout 20 --max-time 300 --speed-limit 1024 --speed-time 45 --output "$dest" "$from"; then
\t\t\treturn 0
\t\telif wgetprogress ${CHECKCERTIF:+"$CHECKCERTIF"} ${CERTIFICATE:+"$CERTIFICATE"} ${PRIVATEKEY:+"$PRIVATEKEY"} -O "$dest" "$from"; then
\t\t\treturn 0
\t\telse
\t\t\trm -f "$dest"
\t\t\treturn 1
\t\tfi
'''
if old not in text:
    raise SystemExit("debootstrap downloader patch anchor missing")
path.write_text(text.replace(old, new, 1))
PY
}

patch_debootstrap_foreign_dpkg_io() {
    if [ "${ARCH}" = "amd64" ]; then
        return 0
    fi

    SCRIPT="/usr/share/debootstrap/scripts/debian-common"
    FUNCTIONS="/usr/share/debootstrap/functions"
    if [ ! -w "${SCRIPT}" ] || [ ! -w "${FUNCTIONS}" ]; then
        echo "ERROR: cannot patch debootstrap scripts; builder image is not writable." >&2
        exit 68
    fi
    if grep -q 'elizaOS foreign dpkg unsafe-io patch' "${SCRIPT}"; then
        return 0
    fi

    echo "    patching foreign debootstrap dpkg unpack I/O..."
    python3 - "${SCRIPT}" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
text = text.replace(
    "dpkg --status-fd 8 --force-depends --unpack $(debfor $required)",
    "dpkg --status-fd 8 --force-depends --force-unsafe-io --unpack $(debfor $required)",
    1,
)
text = text.replace(
    "dpkg --status-fd 8 --force-overwrite --force-confold --skip-same-version --unpack $(debfor $base)",
    "dpkg --status-fd 8 --force-overwrite --force-confold --force-unsafe-io --skip-same-version --unpack $(debfor $base)",
    1,
)
text = text.replace(
    "in_target dpkg --force-overwrite --force-confold --skip-same-version --install $(debfor $predep)",
    "in_target dpkg --force-overwrite --force-confold --force-unsafe-io --skip-same-version --install $(debfor $predep)",
    1,
)
if "--force-depends --force-unsafe-io --unpack" not in text:
    raise SystemExit("debootstrap required dpkg unsafe-io patch anchor missing")
if "--force-confold --force-unsafe-io --skip-same-version --unpack" not in text:
    raise SystemExit("debootstrap base dpkg unsafe-io patch anchor missing")
if "--force-confold --force-unsafe-io --skip-same-version --install" not in text:
    raise SystemExit("debootstrap predep dpkg unsafe-io patch anchor missing")
text += "\n# elizaOS foreign dpkg unsafe-io patch\n"
path.write_text(text)
PY
    python3 - "${FUNCTIONS}" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
old = "if [ $ARCH_ALL_SUPPORTED -eq 1 ]; then"
new = 'if [ "${ARCH_ALL_SUPPORTED:-0}" -eq 1 ]; then'
if old not in text:
    raise SystemExit("debootstrap ARCH_ALL_SUPPORTED patch anchor missing")
path.write_text(text.replace(old, new))
PY
}

# Clear stale live-build working state from any prior/interrupted run so each
# build starts from a clean tree (cache/ is kept for download speed). Runs as
# root here, so it can remove the root-owned chroot from earlier runs.
rm -rf "${HERE}/.build" "${HERE}/binary" "${HERE}/chroot" \
    "${HERE}/config/binary" "${HERE}/config/bootstrap" "${HERE}/config/chroot" \
    "${HERE}/config/common" "${HERE}/config/source" \
    "${HERE}"/chroot.* "${HERE}"/binary.* "${HERE}"/live-image-* 2>/dev/null || true
rm -f "${HERE}/.lock"

echo "=== elizaOS Linux build ==="
echo "    arch:        ${ARCH}"
echo "    profile:     ${PROFILE}"
echo "    output dir:  ${OUT}"
echo "    build ts:    ${BUILD_TS}"

ensure_foreign_binfmt
patch_debootstrap_curl_downloader
patch_debootstrap_foreign_dpkg_io
patch_live_build_riscv64_grub_efi

# ── Step 1: lb config ────────────────────────────────────────────────
echo
echo "--- step 1/5: lb config ---"
ELIZAOS_ARCH="${ARCH}" "${HERE}/auto/config"
rm -f "${HERE}/.lock"

# Compose the secure hardening overlay on top of the default config.
if [ "${PROFILE}" = "secure" ]; then
    if [ -d "${HERE}/config/profiles/secure" ]; then
        echo "    overlaying secure profile..."
        cp -a "${HERE}/config/profiles/secure/." "${HERE}/config/"
    fi
fi

# Generate raster branding from SVG sources into config/includes.chroot.
# Skipped when ImageMagick is unavailable (branding then falls back to
# whatever PNGs are already staged in the tree).
if command -v convert >/dev/null 2>&1; then
    echo "    generating brand assets..."
    "${HERE}/scripts/generate-elizaos-brand-assets.sh"
else
    echo "    convert (ImageMagick) not found — skipping brand-asset generation." >&2
fi

# ── Step 2: lb build ─────────────────────────────────────────────────
echo
echo "--- step 2/5: lb build (this takes 30+ minutes) ---"
lb build

# ── Step 3: verify ───────────────────────────────────────────────────
echo
echo "--- step 3/5: verify ---"
# live-build names the image live-image-<arch>.hybrid.iso; older trees used
# binary.hybrid.iso. Accept whichever the toolchain produced.
SRC_ISO=""
for candidate in \
    "${HERE}/live-image-${ARCH}.hybrid.iso" \
    "${HERE}/binary.hybrid.iso"; do
    if [ -f "${candidate}" ]; then SRC_ISO="${candidate}"; break; fi
done
if [ -z "${SRC_ISO}" ]; then
    SRC_ISO="$(find "${HERE}" -maxdepth 1 -name '*.hybrid.iso' -print -quit 2>/dev/null || true)"
fi
if [ -z "${SRC_ISO}" ] || [ ! -f "${SRC_ISO}" ]; then
    echo "ERROR: no .hybrid.iso produced by lb build in ${HERE}." >&2
    exit 2
fi

ISO_BYTES="$(stat -c%s "${SRC_ISO}")"
if [ "${ISO_BYTES}" -lt "${MIN_ISO_BYTES}" ]; then
    echo "ERROR: ISO size ${ISO_BYTES} below minimum ${MIN_ISO_BYTES} bytes." >&2
    exit 3
fi

if command -v isoinfo >/dev/null 2>&1; then
    isoinfo -i "${SRC_ISO}" -d >/dev/null
fi

DST_ISO="${OUT}/${ARTIFACT_BASENAME}.iso"
mv "${SRC_ISO}" "${DST_ISO}"
echo "    artifact: ${DST_ISO}"

# ── Step 4: checksum ─────────────────────────────────────────────────
echo
echo "--- step 4/5: checksum ---"
( cd "${OUT}" && sha256sum "$(basename "${DST_ISO}")" > "${ARTIFACT_BASENAME}.iso.sha256" )
echo "    sha256: $(cat "${OUT}/${ARTIFACT_BASENAME}.iso.sha256")"

# ── Step 5: manifest ─────────────────────────────────────────────────
echo
echo "--- step 5/5: manifest ---"
TEMPLATE="${HERE}/manifest.json.template"
if [ ! -f "${TEMPLATE}" ]; then
    echo "ERROR: ${TEMPLATE} missing; refusing to emit an ISO without release metadata." >&2
    exit 3
fi
SHA256="$(awk '{print $1}' "${OUT}/${ARTIFACT_BASENAME}.iso.sha256")"
sed \
    -e "s|@@ARCH@@|${ARCH}|g" \
    -e "s|@@PROFILE@@|${PROFILE}|g" \
    -e "s|@@FILENAME@@|${ARTIFACT_BASENAME}.iso|g" \
    -e "s|@@BUILD_TIMESTAMP@@|${BUILD_TS}|g" \
    -e "s|@@SHA256@@|${SHA256}|g" \
    -e "s|@@SIZE_BYTES@@|${ISO_BYTES}|g" \
    "${TEMPLATE}" > "${OUT}/${ARTIFACT_BASENAME}.manifest.json"
python3 -c "import json,sys; json.load(open('${OUT}/${ARTIFACT_BASENAME}.manifest.json'))"
echo "    manifest: ${OUT}/${ARTIFACT_BASENAME}.manifest.json"

echo
echo "=== done ==="
