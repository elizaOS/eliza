#!/usr/bin/env bash
# Checks dual-firmware smoke orchestration and fail-closed diagnostics with fake
# processes; real ISO boot and service readiness remain integration evidence.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT}/scripts/smoke-test-iso.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

mkdir -p "${TMP}/bin"
ISO="${TMP}/image.iso"
OVMF_CODE="${TMP}/OVMF_CODE.fd"
OVMF_VARS="${TMP}/OVMF_VARS.fd"
SEABIOS="${TMP}/bios-256k.bin"
printf 'fixture ISO\n' >"${ISO}"
printf 'fixture OVMF code\n' >"${OVMF_CODE}"
printf 'fixture OVMF vars\n' >"${OVMF_VARS}"
printf 'fixture SeaBIOS\n' >"${SEABIOS}"

cat >"${TMP}/bin/xorriso" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [[ " $* " == *" -report_el_torito plain "* ]]; then
    if [ "${FAKE_XORRISO_MODE:-ok}" != "no-bios" ]; then
        echo "El Torito boot img :   1  BIOS  y   none  0x0000  0x00      4          42"
    fi
    if [ "${FAKE_XORRISO_MODE:-ok}" != "no-uefi-entry" ]; then
        echo "El Torito boot img :   2  UEFI  y   none  0x0000  0x00   4096          46"
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
if [ "${FAKE_XORRISO_MODE:-ok}" = "no-uefi-asset" ] &&
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

firmware=bios
serial_prefix=""
printf '%s\n' "--- invocation ---" >>"${FAKE_QEMU_ARGS_LOG}"
for argument in "$@"; do
    printf '%s\n' "${argument}" >>"${FAKE_QEMU_ARGS_LOG}"
    case "${argument}" in
        if=pflash,*) firmware=uefi ;;
        pipe:*)
            if [ -z "${serial_prefix}" ]; then
                serial_prefix="${argument#pipe:}"
            fi
            ;;
    esac
done
[ -n "${serial_prefix}" ] || exit 64
printf 'firmware=%s\n' "${firmware}" >>"${FAKE_QEMU_ARGS_LOG}"

case "${FAKE_QEMU_MODE:-ready}" in
    ready|ignore-term)
        exec 7>"${serial_prefix}.out"
        printf 'Linux version fixture\namnesia login: ' >&7
        IFS= read -r -d $'\r' username <"${serial_prefix}.in"
        [ "${username}" = "amnesia" ] || exit 65
        printf 'Password: ' >&7
        IFS= read -r -d $'\r' password <"${serial_prefix}.in"
        [ -z "${password}" ] || exit 66
        printf 'amnesia@elizaos:~$ ' >&7
        IFS= read -r -d $'\r' probe <"${serial_prefix}.in"
        if [[ "${probe}" == *"ELIZAOS_ISO_SMOKE_READY"* ]]; then
            echo "host command contained the complete readiness marker" >&2
            exit 67
        fi
        [[ "${probe}" == *"systemctl --user is-active --quiet elizaos-agent.service"* ]] ||
            exit 68
        [[ "${probe}" == *"http://127.0.0.1:31337/api/health"* ]] || exit 69
        printf 'ELIZAOS_ISO_SMOKE_READY firmware=%s service=active health=ready\n' "${firmware}" >&7
        if [ "${FAKE_QEMU_MODE}" = "ignore-term" ]; then
            trap '' TERM
        else
            trap 'exit 0' TERM
        fi
        while true; do sleep 1; done
        ;;
    userspace-only)
        printf 'Linux version fixture\namnesia login:\n' >"${serial_prefix}.out"
        trap 'exit 0' TERM
        while true; do sleep 1; done
        ;;
    fail)
        echo "failed to initialize accelerator" >&2
        exit 1
        ;;
    *)
        exit 64
        ;;
esac
SH
chmod +x "${TMP}/bin/qemu-system-x86_64"

export PATH="${TMP}/bin:${PATH}"
export ELIZAOS_SEABIOS="${SEABIOS}"
export ELIZAOS_OVMF_CODE="${OVMF_CODE}"
export ELIZAOS_OVMF_VARS="${OVMF_VARS}"
export ELIZAOS_ISO_SMOKE_TIMEOUT_SECONDS=1
export ELIZAOS_ISO_SMOKE_BOOT_MENU_WAIT_SECONDS=0
export ELIZAOS_ISO_SMOKE_LOGIN_SETTLE_SECONDS=0
export ELIZAOS_ISO_SMOKE_POLL_SECONDS=0.05
export ELIZAOS_ISO_SMOKE_STOP_TIMEOUT_SECONDS=1
export ELIZAOS_ISO_SMOKE_LOG_DIR="${TMP}/logs"
export FAKE_QEMU_ARGS_LOG="${TMP}/qemu-args"

run_expect_failure() {
    local expected="$1"
    shift
    local output="${TMP}/failure-output"

    rm -rf "${ELIZAOS_ISO_SMOKE_LOG_DIR}"
    : >"${FAKE_QEMU_ARGS_LOG}"
    if "$@" >"${output}" 2>&1; then
        echo "command unexpectedly succeeded: $*" >&2
        exit 1
    fi
    if ! grep -Fq "${expected}" "${output}"; then
        echo "expected failure text not found: ${expected}" >&2
        cat "${output}" >&2
        exit 1
    fi
}

FAKE_XORRISO_MODE=no-bios
export FAKE_XORRISO_MODE
run_expect_failure \
    "ISO has no bootable BIOS El Torito image" \
    "${SCRIPT}" "${ISO}"

FAKE_XORRISO_MODE=no-uefi-entry
export FAKE_XORRISO_MODE
run_expect_failure \
    "ISO has no bootable UEFI El Torito image" \
    "${SCRIPT}" "${ISO}"

FAKE_XORRISO_MODE=no-uefi-asset
export FAKE_XORRISO_MODE
run_expect_failure \
    "required ISO boot asset is missing: /EFI/BOOT/BOOTX64.EFI" \
    "${SCRIPT}" "${ISO}"

FAKE_XORRISO_MODE=ok
FAKE_QEMU_MODE=fail
export FAKE_XORRISO_MODE FAKE_QEMU_MODE
run_expect_failure \
    "failed to initialize accelerator" \
    "${SCRIPT}" "${ISO}"

FAKE_QEMU_MODE=userspace-only
export FAKE_QEMU_MODE
run_expect_failure \
    "bios firmware reached Linux userspace but did not prove the canonical live-user service and health endpoint" \
    "${SCRIPT}" "${ISO}"

FAKE_QEMU_MODE=ready
export FAKE_QEMU_MODE
export ELIZAOS_ISO_SMOKE_TIMEOUT_SECONDS=3
rm -rf "${ELIZAOS_ISO_SMOKE_LOG_DIR}"
: >"${FAKE_QEMU_ARGS_LOG}"
if ! "${SCRIPT}" "${ISO}" >"${TMP}/success-output" 2>&1; then
    cat "${TMP}/success-output" >&2
    find "${ELIZAOS_ISO_SMOKE_LOG_DIR}" -type f -maxdepth 1 -print -exec tail -50 {} \; >&2
    exit 1
fi
grep -Fq "ISO smoke test (bios): canonical live-user service and health ready" "${TMP}/success-output"
grep -Fq "ISO smoke test (uefi): canonical live-user service and health ready" "${TMP}/success-output"
grep -Fq "firmware=bios" "${FAKE_QEMU_ARGS_LOG}"
grep -Fq "firmware=uefi" "${FAKE_QEMU_ARGS_LOG}"
grep -Fxq -- "-drive" "${FAKE_QEMU_ARGS_LOG}"
grep -Fxq -- "-bios" "${FAKE_QEMU_ARGS_LOG}"
grep -Fq "media=cdrom" "${FAKE_QEMU_ARGS_LOG}"
grep -Fq "if=pflash" "${FAKE_QEMU_ARGS_LOG}"
if grep -Eq '^-kernel$|^-initrd$' "${FAKE_QEMU_ARGS_LOG}"; then
    echo "smoke orchestration must not bypass ISO firmware bootloaders" >&2
    exit 1
fi
test -s "${ELIZAOS_ISO_SMOKE_LOG_DIR}/bios.serial.log"
test -s "${ELIZAOS_ISO_SMOKE_LOG_DIR}/uefi.serial.log"

FAKE_QEMU_MODE=ignore-term
export FAKE_QEMU_MODE
rm -rf "${ELIZAOS_ISO_SMOKE_LOG_DIR}"
: >"${FAKE_QEMU_ARGS_LOG}"
if ! "${SCRIPT}" "${ISO}" >"${TMP}/bounded-output" 2>&1; then
    cat "${TMP}/bounded-output" >&2
    exit 1
fi
grep -Fq "did not stop after TERM; sending KILL" "${TMP}/bounded-output"

echo "ISO smoke orchestration contracts passed"
