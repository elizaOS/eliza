#!/usr/bin/env bash
# elizaOS Debian RISC-V 64 — qemu-system-riscv64 -M virt boot harness.
#
# Boots the live ISO produced by `build.sh` on top of OpenSBI + (optionally)
# U-Boot under qemu-system-riscv64 -M virt, captures the serial transcript,
# checks the transcript for the expected boot markers, and writes a JSON
# evidence record at --evidence.
#
# Honesty / fail-closed rules:
#   - This harness is qemu-virt boot transcript evidence only. It does NOT
#     prove silicon boot, physical board boot, or U-Boot extlinux from a
#     real boot medium. The emitted JSON carries an explicit
#     `claim_boundary` field that captures that limit.
#   - The harness fails closed if qemu-system-riscv64 is missing, if the
#     ISO does not exist, if the transcript is empty, or if any required
#     marker is missing / any forbidden marker (Kernel panic, Oops, BUG)
#     is present.
#
# Usage:
#   qemu_virt_boot.sh --iso <path> [--memory <MB>] [--cpus <N>]
#                     [--timeout <sec>] [--evidence <path>]
#                     [--u-boot <path>] [--transcript <path>]
#
# Defaults:
#   --memory     4096   (MB)
#   --cpus       4
#   --timeout    600    (seconds)
#   --evidence   evidence/qemu_virt_boot.json  (relative to variant dir)
#   --u-boot     <chip-package>/build/u-boot/u-boot.elf if it exists,
#                else QEMU built-in fallback (no -kernel passed)
#   --transcript evidence/qemu_virt_boot.transcript.log

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VARIANT_DIR="$(cd "${HERE}/.." && pwd)"
EVIDENCE_DEFAULT="${VARIANT_DIR}/evidence/qemu_virt_boot.json"
TRANSCRIPT_DEFAULT="${VARIANT_DIR}/evidence/qemu_virt_boot.transcript.log"
UBOOT_CHIP_DEFAULT="${VARIANT_DIR}/../../../../chip/build/u-boot/u-boot.elf"
UEFI_CODE_DEFAULT="/usr/share/qemu-efi-riscv64/RISCV_VIRT_CODE.fd"
UEFI_VARS_DEFAULT="/usr/share/qemu-efi-riscv64/RISCV_VIRT_VARS.fd"

ISO=""
MEMORY_MB=4096
CPUS=4
TIMEOUT_SECS=600
EVIDENCE_PATH=""
TRANSCRIPT_PATH=""
UBOOT_PATH=""

die() {
    printf 'qemu_virt_boot: ERROR: %s\n' "$*" >&2
    exit 1
}

usage() {
    sed -n '1,40p' "${BASH_SOURCE[0]}"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --iso)
            [ $# -ge 2 ] || die "--iso requires a value"
            ISO="$2"; shift 2;;
        --memory)
            [ $# -ge 2 ] || die "--memory requires a value"
            MEMORY_MB="$2"; shift 2;;
        --cpus)
            [ $# -ge 2 ] || die "--cpus requires a value"
            CPUS="$2"; shift 2;;
        --timeout)
            [ $# -ge 2 ] || die "--timeout requires a value"
            TIMEOUT_SECS="$2"; shift 2;;
        --evidence)
            [ $# -ge 2 ] || die "--evidence requires a value"
            EVIDENCE_PATH="$2"; shift 2;;
        --transcript)
            [ $# -ge 2 ] || die "--transcript requires a value"
            TRANSCRIPT_PATH="$2"; shift 2;;
        --u-boot)
            [ $# -ge 2 ] || die "--u-boot requires a value"
            UBOOT_PATH="$2"; shift 2;;
        -h|--help)
            usage; exit 0;;
        *)
            die "unknown argument: $1";;
    esac
done

[ -n "${ISO}" ] || die "--iso is required"
[ -f "${ISO}" ] || die "ISO not found: ${ISO}"

case "${MEMORY_MB}" in
    ''|*[!0-9]*) die "--memory must be a positive integer (MB)";;
esac
case "${CPUS}" in
    ''|*[!0-9]*) die "--cpus must be a positive integer";;
esac
case "${TIMEOUT_SECS}" in
    ''|*[!0-9]*) die "--timeout must be a positive integer (seconds)";;
esac
[ "${MEMORY_MB}" -ge 256 ] || die "--memory must be >= 256 MB"
[ "${CPUS}" -ge 1 ] || die "--cpus must be >= 1"
[ "${TIMEOUT_SECS}" -ge 1 ] || die "--timeout must be >= 1"

EVIDENCE_PATH="${EVIDENCE_PATH:-${EVIDENCE_DEFAULT}}"
TRANSCRIPT_PATH="${TRANSCRIPT_PATH:-${TRANSCRIPT_DEFAULT}}"

mkdir -p "$(dirname "${EVIDENCE_PATH}")"
mkdir -p "$(dirname "${TRANSCRIPT_PATH}")"

command -v qemu-system-riscv64 >/dev/null 2>&1 \
    || die "qemu-system-riscv64 not on PATH"
command -v qemu-img >/dev/null 2>&1 \
    || die "qemu-img not on PATH"
command -v python3 >/dev/null 2>&1 \
    || die "python3 not on PATH"
command -v sha256sum >/dev/null 2>&1 \
    || die "sha256sum not on PATH"

if [ -z "${UBOOT_PATH}" ] && [ -f "${UBOOT_CHIP_DEFAULT}" ]; then
    UBOOT_PATH="${UBOOT_CHIP_DEFAULT}"
fi
if [ -n "${UBOOT_PATH}" ] && [ ! -f "${UBOOT_PATH}" ]; then
    die "u-boot ELF not found: ${UBOOT_PATH}"
fi

ISO_SHA256="$(sha256sum "${ISO}" | awk '{ print $1 }')"

UEFI_VARS_RUNTIME=""
QEMU_FIRMWARE_DESC="opensbi-default"
QEMU_CMD=(qemu-system-riscv64
    -machine virt
    -nographic
    -m "${MEMORY_MB}"
    -smp "${CPUS}"
)

if [ -f "${UEFI_CODE_DEFAULT}" ] && [ -f "${UEFI_VARS_DEFAULT}" ]; then
    UEFI_VARS_RUNTIME="$(mktemp)"
    cp "${UEFI_VARS_DEFAULT}" "${UEFI_VARS_RUNTIME}"
    QEMU_FIRMWARE_DESC="${UEFI_CODE_DEFAULT}"
    QEMU_CMD+=(
        -drive "if=pflash,format=raw,unit=0,readonly=on,file=${UEFI_CODE_DEFAULT}"
        -drive "if=pflash,format=raw,unit=1,file=${UEFI_VARS_RUNTIME}"
    )
else
    QEMU_CMD+=( -bios default )
fi

QEMU_CMD+=(
    -drive "file=${ISO},if=virtio,format=raw,media=cdrom,readonly=on"
    -netdev user,id=net0
    -device virtio-net-device,netdev=net0
    -monitor none
    -serial mon:stdio
    -no-reboot)

if [ -n "${UBOOT_PATH}" ]; then
    QEMU_CMD+=( -kernel "${UBOOT_PATH}" )
fi

START_EPOCH="$(date -u +%s)"
START_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

: > "${TRANSCRIPT_PATH}"
{
    printf '## qemu_virt_boot transcript\n'
    printf '## start_utc: %s\n' "${START_UTC}"
    printf '## iso: %s\n' "${ISO}"
    printf '## iso_sha256: %s\n' "${ISO_SHA256}"
    printf '## memory_mb: %s\n' "${MEMORY_MB}"
    printf '## cpus: %s\n' "${CPUS}"
    printf '## timeout_secs: %s\n' "${TIMEOUT_SECS}"
    printf '## firmware: %s\n' "${QEMU_FIRMWARE_DESC}"
    printf '## u_boot: %s\n' "${UBOOT_PATH:-<built-in>}"
    printf '## cmd: %s\n' "${QEMU_CMD[*]}"
    printf '##\n'
} >> "${TRANSCRIPT_PATH}"

boot_markers_present() {
    grep -F -q -- "Linux version" "${TRANSCRIPT_PATH}" \
        && { grep -F -q -- "elizaos-ready" "${TRANSCRIPT_PATH}" \
            || grep -F -q -- "login:" "${TRANSCRIPT_PATH}"; }
}

forbidden_marker_present() {
    grep -F -q -- "Kernel panic" "${TRANSCRIPT_PATH}" \
        || grep -F -q -- "Oops" "${TRANSCRIPT_PATH}" \
        || grep -F -q -- "BUG" "${TRANSCRIPT_PATH}"
}

set +e
"${QEMU_CMD[@]}" </dev/null >> "${TRANSCRIPT_PATH}" 2>&1 &
QEMU_PID=$!
QEMU_RC=124
QEMU_TIMED_OUT=0
while kill -0 "${QEMU_PID}" >/dev/null 2>&1; do
    if boot_markers_present; then
        QEMU_RC=0
        kill "${QEMU_PID}" >/dev/null 2>&1
        wait "${QEMU_PID}" >/dev/null 2>&1
        break
    fi
    if forbidden_marker_present; then
        QEMU_RC=1
        kill "${QEMU_PID}" >/dev/null 2>&1
        wait "${QEMU_PID}" >/dev/null 2>&1
        break
    fi
    NOW_EPOCH="$(date -u +%s)"
    if [ $(( NOW_EPOCH - START_EPOCH )) -ge "${TIMEOUT_SECS}" ]; then
        QEMU_RC=124
        QEMU_TIMED_OUT=1
        kill "${QEMU_PID}" >/dev/null 2>&1
        wait "${QEMU_PID}" >/dev/null 2>&1
        break
    fi
    sleep 2
done
if [ "${QEMU_RC}" -eq 124 ] && [ "${QEMU_TIMED_OUT}" -eq 0 ] && ! kill -0 "${QEMU_PID}" >/dev/null 2>&1; then
    wait "${QEMU_PID}"
    QEMU_RC=$?
fi
set -e
if [ -n "${UEFI_VARS_RUNTIME}" ]; then
    rm -f "${UEFI_VARS_RUNTIME}"
fi

END_EPOCH="$(date -u +%s)"
DURATION_S=$(( END_EPOCH - START_EPOCH ))

REQUIRED_MARKERS=(
    "Linux version"
    "elizaos-ready"
)
LOGIN_MARKER="login:"
FORBIDDEN_MARKERS=(
    "Kernel panic"
    "Oops"
    "BUG"
)

MARKERS_FOUND=()
MARKERS_MISSING=()

for marker in "${REQUIRED_MARKERS[@]}"; do
    if grep -F -q -- "${marker}" "${TRANSCRIPT_PATH}"; then
        MARKERS_FOUND+=( "${marker}" )
    else
        MARKERS_MISSING+=( "${marker}" )
    fi
done

if grep -F -q -- "${LOGIN_MARKER}" "${TRANSCRIPT_PATH}"; then
    MARKERS_FOUND+=( "${LOGIN_MARKER}" )
fi

FORBIDDEN_HIT=()
for forbid in "${FORBIDDEN_MARKERS[@]}"; do
    if grep -F -q -- "${forbid}" "${TRANSCRIPT_PATH}"; then
        FORBIDDEN_HIT+=( "${forbid}" )
    fi
done

# `boot_completed` requires:
#   * Linux version banner
#   * first-boot script wrote `elizaos-ready` OR a `login:` prompt
#   * zero forbidden markers
HAS_LINUX=0
HAS_READY=0
HAS_LOGIN=0
for m in "${MARKERS_FOUND[@]}"; do
    case "${m}" in
        "Linux version") HAS_LINUX=1;;
        "elizaos-ready") HAS_READY=1;;
        "login:") HAS_LOGIN=1;;
    esac
done

BOOT_COMPLETED="false"
if [ ${#FORBIDDEN_HIT[@]} -eq 0 ] \
   && [ "${HAS_LINUX}" -eq 1 ] \
   && { [ "${HAS_READY}" -eq 1 ] || [ "${HAS_LOGIN}" -eq 1 ]; }; then
    BOOT_COMPLETED="true"
fi

TRANSCRIPT_SHA256="$(sha256sum "${TRANSCRIPT_PATH}" | awk '{ print $1 }')"

emit_array() {
    if [ "$#" -eq 0 ]; then
        printf '[]'
        return
    fi
    printf '%s\n' "$@" | python3 -c '
import json, sys
print(json.dumps([line for line in sys.stdin.read().splitlines() if line]))
'
}

MARKERS_FOUND_JSON="$(emit_array "${MARKERS_FOUND[@]+"${MARKERS_FOUND[@]}"}")"
MARKERS_MISSING_JSON="$(emit_array "${MARKERS_MISSING[@]+"${MARKERS_MISSING[@]}"}")"
FORBIDDEN_HIT_JSON="$(emit_array "${FORBIDDEN_HIT[@]+"${FORBIDDEN_HIT[@]}"}")"

export QVB_EVIDENCE_PATH="${EVIDENCE_PATH}"
export QVB_ISO_PATH="${ISO}"
export QVB_ISO_SHA256="${ISO_SHA256}"
export QVB_TRANSCRIPT_PATH="${TRANSCRIPT_PATH}"
export QVB_TRANSCRIPT_SHA256="${TRANSCRIPT_SHA256}"
export QVB_MEMORY_MB="${MEMORY_MB}"
export QVB_CPUS="${CPUS}"
export QVB_TIMEOUT_S="${TIMEOUT_SECS}"
export QVB_DURATION_S="${DURATION_S}"
export QVB_START_UTC="${START_UTC}"
export QVB_QEMU_RC="${QEMU_RC}"
export QVB_UBOOT_PATH="${UBOOT_PATH}"
export QVB_BOOT_COMPLETED="${BOOT_COMPLETED}"
export QVB_MARKERS_FOUND_JSON="${MARKERS_FOUND_JSON}"
export QVB_MARKERS_MISSING_JSON="${MARKERS_MISSING_JSON}"
export QVB_FORBIDDEN_HIT_JSON="${FORBIDDEN_HIT_JSON}"

python3 - <<'PYEOF'
import json
import os

doc = {
    "schema": "eliza.os.linux.qemu_virt_boot.v1",
    "claim_boundary": "qemu_virt_boot_transcript_evidence_only_no_silicon_or_physical_board_claim",
    "iso_path": os.environ["QVB_ISO_PATH"],
    "iso_sha256": os.environ["QVB_ISO_SHA256"],
    "transcript_path": os.environ["QVB_TRANSCRIPT_PATH"],
    "transcript_sha256": os.environ["QVB_TRANSCRIPT_SHA256"],
    "memory_mb": int(os.environ["QVB_MEMORY_MB"]),
    "cpus": int(os.environ["QVB_CPUS"]),
    "timeout_s": int(os.environ["QVB_TIMEOUT_S"]),
    "duration_s": int(os.environ["QVB_DURATION_S"]),
    "start_utc": os.environ["QVB_START_UTC"],
    "qemu_exit_code": int(os.environ["QVB_QEMU_RC"]),
    "u_boot_path": os.environ["QVB_UBOOT_PATH"] or None,
    "boot_completed": os.environ["QVB_BOOT_COMPLETED"] == "true",
    "markers_found": json.loads(os.environ["QVB_MARKERS_FOUND_JSON"]),
    "markers_missing": json.loads(os.environ["QVB_MARKERS_MISSING_JSON"]),
    "forbidden_markers_present": json.loads(os.environ["QVB_FORBIDDEN_HIT_JSON"]),
    "provenance": "qemu_virt",
}
with open(os.environ["QVB_EVIDENCE_PATH"], "w", encoding="utf-8") as fh:
    json.dump(doc, fh, indent=2, sort_keys=True)
    fh.write("\n")
PYEOF

printf 'qemu_virt_boot: transcript=%s\n' "${TRANSCRIPT_PATH}"
printf 'qemu_virt_boot: evidence=%s\n' "${EVIDENCE_PATH}"
printf 'qemu_virt_boot: boot_completed=%s duration_s=%s qemu_rc=%s\n' \
    "${BOOT_COMPLETED}" "${DURATION_S}" "${QEMU_RC}"

if [ "${BOOT_COMPLETED}" = "true" ]; then
    exit 0
fi
exit 1
