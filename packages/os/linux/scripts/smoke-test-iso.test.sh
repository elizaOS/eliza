#!/usr/bin/env bash
# Exercises ISO smoke launch, boot-asset, diagnostics, and fail-closed contracts
# with fake xorriso and QEMU processes.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT}/scripts/smoke-test-iso.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

mkdir -p "${TMP}/bin"
ISO="${TMP}/image.iso"
printf 'fixture ISO\n' >"${ISO}"

cat >"${TMP}/bin/xorriso" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [[ " $* " == *" -report_el_torito plain "* ]]; then
    if [ "${FAKE_XORRISO_MODE:-ok}" = "no-bios" ]; then
        echo "Boot record  : (not bootable)"
    else
        echo "El Torito boot img :   1  BIOS  y   none  0x0000  0x00      4          42"
    fi
    exit 0
fi

source_path=""
destination=""
while [ "$#" -gt 0 ]; do
    if [ "$1" = "-extract" ]; then
        source_path="$2"
        destination="$3"
        break
    fi
    shift
done

if [ -z "${source_path}" ] || [ -z "${destination}" ]; then
    echo "unexpected fake xorriso invocation" >&2
    exit 64
fi
if [ "${FAKE_XORRISO_MODE:-ok}" = "no-uefi" ] &&
    [ "${source_path}" = "/EFI/BOOT/BOOTX64.EFI" ]; then
    echo "Cannot find path ${source_path}" >&2
    exit 1
fi
printf 'fixture for %s\n' "${source_path}" >"${destination}"
SH
chmod +x "${TMP}/bin/xorriso"

cat >"${TMP}/bin/qemu-system-x86_64" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$@" >"${FAKE_QEMU_ARGS_LOG}"
serial_log=""
previous=""
for argument in "$@"; do
    if [ "${previous}" = "-serial" ]; then
        serial_log="${argument#file:}"
        break
    fi
    previous="${argument}"
done
[ -n "${serial_log}" ] || exit 64

case "${FAKE_QEMU_MODE:-strong}" in
    strong)
        echo "[  OK  ] Started elizaOS local agent runtime (system-wide)." >"${serial_log}"
        trap 'exit 0' TERM
        while true; do sleep 1; done
        ;;
    weak)
        printf 'Linux version fixture\nlogin:\n' >"${serial_log}"
        trap 'exit 0' TERM
        while true; do sleep 1; done
        ;;
    fail)
        echo "failed to initialize kvm: Permission denied" >&2
        exit 1
        ;;
    *)
        exit 64
        ;;
esac
SH
chmod +x "${TMP}/bin/qemu-system-x86_64"

export PATH="${TMP}/bin:${PATH}"
export ELIZAOS_ISO_SMOKE_TIMEOUT_SECONDS=2
export ELIZAOS_ISO_SMOKE_POLL_SECONDS=0.05
export FAKE_QEMU_ARGS_LOG="${TMP}/qemu-args"

run_expect_failure() {
    local expected="$1"
    shift
    local output="${TMP}/failure-output"

    if "$@" >"${output}" 2>&1; then
        echo "command unexpectedly succeeded: $*" >&2
        exit 1
    fi
    grep -Fq "${expected}" "${output}"
}

FAKE_XORRISO_MODE=no-bios
export FAKE_XORRISO_MODE
run_expect_failure \
    "ISO has no bootable BIOS El Torito image" \
    "${SCRIPT}" "${ISO}"

FAKE_XORRISO_MODE=no-uefi
export FAKE_XORRISO_MODE
run_expect_failure \
    "required ISO boot asset is missing: /EFI/BOOT/BOOTX64.EFI" \
    "${SCRIPT}" "${ISO}"

FAKE_XORRISO_MODE=ok
FAKE_QEMU_MODE=fail
export FAKE_XORRISO_MODE FAKE_QEMU_MODE
run_expect_failure \
    "failed to initialize kvm: Permission denied" \
    "${SCRIPT}" "${ISO}"

FAKE_QEMU_MODE=weak
export FAKE_QEMU_MODE
run_expect_failure \
    "ISO reached Linux userspace but did not prove elizaOS service startup" \
    "${SCRIPT}" "${ISO}"

FAKE_QEMU_MODE=strong
export FAKE_QEMU_MODE
"${SCRIPT}" "${ISO}" >"${TMP}/success-output" 2>&1
grep -Fq "elizaOS system service startup detected" "${TMP}/success-output"
grep -Fxq -- "-accel" "${FAKE_QEMU_ARGS_LOG}"
grep -Fxq -- "kvm" "${FAKE_QEMU_ARGS_LOG}"
grep -Fxq -- "tcg,thread=multi" "${FAKE_QEMU_ARGS_LOG}"
grep -Fq "console=ttyS0,115200n8" "${FAKE_QEMU_ARGS_LOG}"
grep -Fq "systemd.unit=multi-user.target" "${FAKE_QEMU_ARGS_LOG}"
grep -Fxq -- "-kernel" "${FAKE_QEMU_ARGS_LOG}"
grep -Fxq -- "-initrd" "${FAKE_QEMU_ARGS_LOG}"
grep -Fxq -- "-cdrom" "${FAKE_QEMU_ARGS_LOG}"

echo "ISO smoke contract tests passed"
