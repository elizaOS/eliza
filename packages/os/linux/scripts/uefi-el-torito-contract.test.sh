#!/usr/bin/env bash
# Exercises the EFI image hook and the pinned live-build patch with synthetic
# tool boundaries; hosted ISO boot remains the integration proof.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="${ROOT}/tails/config/binary_local-hooks/60-efi-el-torito"
LIVE_BUILD_PATCH="${ROOT}/patches/live-build-uefi-el-torito.patch"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

make_fixture() {
    local fixture="$1"

    mkdir -p \
        "${fixture}/binary/EFI/BOOT" \
        "${fixture}/config" \
        "${fixture}/tmp"
    printf 'LB_ARCHITECTURE="amd64"\n' >"${fixture}/config/bootstrap"
    printf 'export SOURCE_DATE_EPOCH="1712345678"\n' >"${fixture}/config/variables"
    printf 'signed shim fixture\n' >"${fixture}/binary/EFI/BOOT/BOOTX64.EFI"
    printf 'signed grub fixture\n' >"${fixture}/binary/EFI/BOOT/GRUBX64.EFI"
}

mkdir -p "${TMP}/bin"
cat >"${TMP}/bin/touch" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'touch' >>"${EFI_TOOL_LOG}"
printf ' <%s>' "$@" >>"${EFI_TOOL_LOG}"
printf '\n' >>"${EFI_TOOL_LOG}"
SH
cat >"${TMP}/bin/stat" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = "-c" ] && [ "${2:-}" = "%s" ] && [ -n "${3:-}" ] || exit 64
if /usr/bin/stat -f '%z' "${3}" >/dev/null 2>&1; then
    /usr/bin/stat -f '%z' "${3}"
else
    /usr/bin/stat -c '%s' "${3}"
fi
SH
cat >"${TMP}/bin/mkfs.msdos" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ "${SOURCE_DATE_EPOCH:-}" = "1712345678" ] || exit 65
printf 'mkfs.msdos' >>"${EFI_TOOL_LOG}"
printf ' <%s>' "$@" >>"${EFI_TOOL_LOG}"
printf '\n' >>"${EFI_TOOL_LOG}"
image=""
previous=""
for argument in "$@"; do
    if [ "${previous}" = "-C" ]; then
        image="${argument}"
        break
    fi
    previous="${argument}"
done
[ -n "${image}" ] || exit 64
printf 'FAT fixture\n' >"${image}"
SH
cat >"${TMP}/bin/mmd" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'mmd' >>"${EFI_TOOL_LOG}"
printf ' <%s>' "$@" >>"${EFI_TOOL_LOG}"
printf '\n' >>"${EFI_TOOL_LOG}"
SH
cat >"${TMP}/bin/mcopy" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'mcopy' >>"${EFI_TOOL_LOG}"
printf ' <%s>' "$@" >>"${EFI_TOOL_LOG}"
printf '\n' >>"${EFI_TOOL_LOG}"
for argument in "$@"; do
    case "${argument}" in
        */grub.cfg|grub.cfg)
            if [ -f "${argument}" ]; then
                cp "${argument}" "${EFI_REDIRECT_CAPTURE}"
            fi
            ;;
    esac
done
SH
cat >"${TMP}/bin/mdir" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'mdir' >>"${EFI_TOOL_LOG}"
printf ' <%s>' "$@" >>"${EFI_TOOL_LOG}"
printf '\n' >>"${EFI_TOOL_LOG}"
SH
chmod +x \
    "${TMP}/bin/touch" \
    "${TMP}/bin/stat" \
    "${TMP}/bin/mkfs.msdos" \
    "${TMP}/bin/mmd" \
    "${TMP}/bin/mcopy" \
    "${TMP}/bin/mdir"

fixture="${TMP}/fixture"
make_fixture "${fixture}"
export EFI_TOOL_LOG="${TMP}/efi-tools.log"
export EFI_REDIRECT_CAPTURE="${TMP}/grub.cfg"
(
    cd "${fixture}"
    PATH="${TMP}/bin:${PATH}" "${HOOK}"
)

test -s "${fixture}/binary/boot/grub/efi.img"
expected_volume_id="$(printf '%08x' $((1712345678 % 4294967296)))"
grep -Fq -- "-i> <${expected_volume_id}>" "${EFI_TOOL_LOG}"
grep -Fq -- "touch <-d> <@1712345678>" "${EFI_TOOL_LOG}"
grep -Fq 'BOOTX64.EFI>' "${EFI_TOOL_LOG}"
grep -Fq 'GRUBX64.EFI>' "${EFI_TOOL_LOG}"
grep -Fxq 'search --file --set=root /live/vmlinuz' "${EFI_REDIRECT_CAPTURE}"
grep -Fxq 'configfile ($root)/EFI/debian/grub.cfg' "${EFI_REDIRECT_CAPTURE}"
grep -Fq '<::EFI/BOOT/BOOTX64.EFI>' "${EFI_TOOL_LOG}"
grep -Fq '<::EFI/BOOT/GRUBX64.EFI>' "${EFI_TOOL_LOG}"
grep -Fq '<::EFI/debian/grub.cfg>' "${EFI_TOOL_LOG}"

missing_fixture="${TMP}/missing-loader"
make_fixture "${missing_fixture}"
rm "${missing_fixture}/binary/EFI/BOOT/GRUBX64.EFI"
if (
    cd "${missing_fixture}"
    PATH="${TMP}/bin:${PATH}" "${HOOK}"
) >"${TMP}/missing-loader.log" 2>&1; then
    echo "EFI image hook accepted a missing signed GRUB loader" >&2
    exit 1
fi
grep -Fq 'required UEFI loader is missing' "${TMP}/missing-loader.log"

oversize_fixture="${TMP}/oversize"
make_fixture "${oversize_fixture}"
truncate -s 34M "${oversize_fixture}/binary/EFI/BOOT/GRUBX64.EFI"
if (
    cd "${oversize_fixture}"
    PATH="${TMP}/bin:${PATH}" "${HOOK}"
) >"${TMP}/oversize.log" 2>&1; then
    echo "EFI image hook accepted an El Torito image above the firmware limit" >&2
    exit 1
fi
grep -Fq 'would exceed the 32 MiB firmware limit' "${TMP}/oversize.log"

mkdir -p "${TMP}/live-build/scripts/build"
for ((line_number = 1; line_number < 147; line_number++)); do
    printf '\n'
done >"${TMP}/live-build/scripts/build/lb_binary_iso"
cat >>"${TMP}/live-build/scripts/build/lb_binary_iso" <<'SH'
case "${LB_BOOTLOADER}" in
	syslinux)
		XORRISO_OPTIONS="${XORRISO_OPTIONS} -b isolinux/isolinux.bin -c isolinux/boot.cat"
		XORRISO_EXCLUDE="isolinux/isolinux.bin"
		;;

	*)
		Echo_warning "Bootloader on your architecture not yet supported by live-build."
		;;
esac

#if [ "${LB_DEBIAN_INSTALLER}" != "live" ]
#then
#	XORRISO_OPTIONS="${XORRISO_OPTIONS} -m ${XORRISO_EXCLUDE}"
#fi
SH
patch --batch --forward -d "${TMP}/live-build" -p1 <"${LIVE_BUILD_PATCH}"
grep -Fq 'if [ -e binary/boot/grub/efi.img ]' \
    "${TMP}/live-build/scripts/build/lb_binary_iso"
grep -Fq -- '-eltorito-alt-boot' "${TMP}/live-build/scripts/build/lb_binary_iso"
grep -Fq -- '-e boot/grub/efi.img -no-emul-boot' \
    "${TMP}/live-build/scripts/build/lb_binary_iso"
grep -Fq 'COPY patches/live-build-uefi-el-torito.patch' "${ROOT}/Dockerfile"
grep -Fq 'patch --batch --forward -d /opt/tails-live-build -p1' "${ROOT}/Dockerfile"
grep -Fq "packages/os/linux/tails/config/binary_local-hooks/**" \
    "${ROOT}/../../../.github/workflows/build-linux-iso.yml"
grep -Fq "packages/os/linux/patches/**" \
    "${ROOT}/../../../.github/workflows/build-linux-iso.yml"

echo "UEFI El Torito build contracts passed"
