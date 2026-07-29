#!/usr/bin/env bash
# Boots the release ISO through both of its firmware entry points and proves the
# canonical Tails live-user service reaches a healthy local API.

set -euo pipefail

ISO="${1:-}"
QEMU_BIN="${ELIZAOS_QEMU_BIN:-qemu-system-x86_64}"
XORRISO_BIN="${ELIZAOS_XORRISO_BIN:-xorriso}"
BOOT_TIMEOUT_SECONDS="${ELIZAOS_ISO_SMOKE_TIMEOUT_SECONDS:-600}"
BOOT_MENU_WAIT_SECONDS="${ELIZAOS_ISO_SMOKE_BOOT_MENU_WAIT_SECONDS:-10}"
LOGIN_SETTLE_SECONDS="${ELIZAOS_ISO_SMOKE_LOGIN_SETTLE_SECONDS:-10}"
POLL_SECONDS="${ELIZAOS_ISO_SMOKE_POLL_SECONDS:-2}"
STOP_TIMEOUT_SECONDS="${ELIZAOS_ISO_SMOKE_STOP_TIMEOUT_SECONDS:-10}"
LOG_DIR="${ELIZAOS_ISO_SMOKE_LOG_DIR:-${PWD}/iso-smoke-logs}"

fail() {
    echo "ERROR: $*" >&2
    exit 1
}

require_positive_integer() {
    local name="$1"
    local value="$2"

    case "${value}" in
        ""|*[!0-9]*|0)
            fail "${name} must be a positive integer"
            ;;
    esac
}

require_nonnegative_integer() {
    local name="$1"
    local value="$2"

    case "${value}" in
        ""|*[!0-9]*)
            fail "${name} must be a nonnegative integer"
            ;;
    esac
}

require_positive_integer \
    "ELIZAOS_ISO_SMOKE_TIMEOUT_SECONDS" \
    "${BOOT_TIMEOUT_SECONDS}"
require_nonnegative_integer \
    "ELIZAOS_ISO_SMOKE_BOOT_MENU_WAIT_SECONDS" \
    "${BOOT_MENU_WAIT_SECONDS}"
require_nonnegative_integer \
    "ELIZAOS_ISO_SMOKE_LOGIN_SETTLE_SECONDS" \
    "${LOGIN_SETTLE_SECONDS}"
require_positive_integer \
    "ELIZAOS_ISO_SMOKE_STOP_TIMEOUT_SECONDS" \
    "${STOP_TIMEOUT_SECONDS}"

[ -n "${ISO}" ] || fail "usage: $0 <iso-path>"
[ -f "${ISO}" ] || fail "ISO not found: ${ISO}"
command -v "${QEMU_BIN}" >/dev/null 2>&1 || fail "QEMU not found: ${QEMU_BIN}"
command -v "${XORRISO_BIN}" >/dev/null 2>&1 || fail "xorriso not found: ${XORRISO_BIN}"

find_firmware_file() {
    local description="$1"
    local explicit_path="$2"
    shift 2
    local candidate

    if [ -n "${explicit_path}" ]; then
        [ -r "${explicit_path}" ] && [ -s "${explicit_path}" ] ||
            fail "${description} firmware is not readable and nonempty: ${explicit_path}"
        printf '%s\n' "${explicit_path}"
        return
    fi

    for candidate in "$@"; do
        if [ -r "${candidate}" ] && [ -s "${candidate}" ]; then
            printf '%s\n' "${candidate}"
            return
        fi
    done
    return 1
}

SEABIOS="$(
    find_firmware_file SeaBIOS "${ELIZAOS_SEABIOS:-}" \
        /usr/share/seabios/bios-256k.bin \
        /usr/share/qemu/bios-256k.bin \
        /usr/share/qemu/bios.bin \
        /opt/homebrew/share/qemu/bios-256k.bin \
        /opt/homebrew/share/qemu/bios.bin
)" || fail "SeaBIOS firmware not found; install the seabios package"
OVMF_CODE="$(
    find_firmware_file "OVMF code" "${ELIZAOS_OVMF_CODE:-}" \
        /usr/share/OVMF/OVMF_CODE_4M.fd \
        /usr/share/OVMF/OVMF_CODE.fd \
        /usr/share/edk2/ovmf/OVMF_CODE.fd \
        /usr/share/qemu/OVMF_CODE.fd
)" || fail "OVMF code firmware not found; install the ovmf package"
OVMF_VARS="$(
    find_firmware_file "OVMF variables" "${ELIZAOS_OVMF_VARS:-}" \
        /usr/share/OVMF/OVMF_VARS_4M.fd \
        /usr/share/OVMF/OVMF_VARS.fd \
        /usr/share/edk2/ovmf/OVMF_VARS.fd \
        /usr/share/qemu/OVMF_VARS.fd
)" || fail "OVMF variable firmware not found; install the ovmf package"

TMP="$(mktemp -d)"
mkdir -p "${LOG_DIR}"
EL_TORITO_REPORT="${LOG_DIR}/el-torito.txt"
QEMU_PID=""
SERIAL_READER_PID=""
MONITOR_READER_PID=""
SERIAL_FD=""
MONITOR_FD=""
CURRENT_FIRMWARE=""

dump_one_log() {
    local path="$1"

    if [ -s "${path}" ]; then
        echo "===== ${path} (last 200 lines) =====" >&2
        # error-policy:J7 diagnostics must not replace the original smoke failure.
        tail -200 "${path}" >&2 || true
    fi
}

dump_diagnostics() {
    local firmware

    dump_one_log "${EL_TORITO_REPORT}"
    for firmware in bios uefi; do
        dump_one_log "${LOG_DIR}/${firmware}.qemu.stderr"
        dump_one_log "${LOG_DIR}/${firmware}.monitor.log"
        dump_one_log "${LOG_DIR}/${firmware}.serial.log"
    done
}

stop_process_bounded() {
    local pid="$1"
    local label="$2"
    local deadline

    [ -n "${pid}" ] || return 0
    if ! kill -0 "${pid}" 2>/dev/null; then
        # error-policy:J6 the child has already exited; only reap its status.
        wait "${pid}" 2>/dev/null || true
        return
    fi

    # error-policy:J6 each process belongs only to the disposable smoke VM.
    kill -TERM "${pid}" 2>/dev/null || true
    deadline=$((SECONDS + STOP_TIMEOUT_SECONDS))
    while kill -0 "${pid}" 2>/dev/null && ((SECONDS < deadline)); do
        sleep 0.1
    done

    if kill -0 "${pid}" 2>/dev/null; then
        echo "${label} did not stop after TERM; sending KILL" >&2
        kill -KILL "${pid}" 2>/dev/null || true
        deadline=$((SECONDS + STOP_TIMEOUT_SECONDS))
        while kill -0 "${pid}" 2>/dev/null && ((SECONDS < deadline)); do
            sleep 0.1
        done
    fi

    if kill -0 "${pid}" 2>/dev/null; then
        echo "WARNING: ${label} still exists after bounded TERM/KILL teardown" >&2
        return
    fi
    wait "${pid}" 2>/dev/null || true
}

close_pipe_fds() {
    if [ -n "${SERIAL_FD}" ]; then
        exec 8>&-
        SERIAL_FD=""
    fi
    if [ -n "${MONITOR_FD}" ]; then
        exec 9>&-
        MONITOR_FD=""
    fi
}

stop_qemu() {
    close_pipe_fds
    stop_process_bounded "${QEMU_PID}" "${CURRENT_FIRMWARE:-QEMU} VM"
    stop_process_bounded "${SERIAL_READER_PID}" "${CURRENT_FIRMWARE:-QEMU} serial reader"
    stop_process_bounded "${MONITOR_READER_PID}" "${CURRENT_FIRMWARE:-QEMU} monitor reader"
    QEMU_PID=""
    SERIAL_READER_PID=""
    MONITOR_READER_PID=""
}

finish() {
    local status="$1"

    trap - EXIT INT TERM HUP
    if [ "${status}" -ne 0 ]; then
        dump_diagnostics
    fi
    stop_qemu
    # error-policy:J6 the directory contains only disposable pipes and OVMF state.
    rm -rf "${TMP}"
    exit "${status}"
}

handle_signal() {
    local signal_name="$1"
    local status="$2"

    echo "Received ${signal_name}; preserving ISO smoke diagnostics" >&2
    dump_diagnostics
    exit "${status}"
}

trap 'finish $?' EXIT
trap 'handle_signal INT 130' INT
trap 'handle_signal TERM 143' TERM
trap 'handle_signal HUP 129' HUP

if ! "${XORRISO_BIN}" \
    -indev "${ISO}" \
    -report_el_torito plain \
    >"${EL_TORITO_REPORT}" 2>&1; then
    fail "unable to inspect ISO boot equipment"
fi

require_el_torito_platform() {
    local platform="$1"

    if ! grep -Eq \
        "El Torito boot img[[:space:]]*:[[:space:]]*[0-9]+[[:space:]]+${platform}[[:space:]]+y[[:space:]]" \
        "${EL_TORITO_REPORT}"; then
        fail "ISO has no bootable ${platform} El Torito image"
    fi
}

require_el_torito_platform BIOS
require_el_torito_platform UEFI

extract_required() {
    local source_path="$1"
    local destination="$2"
    local extract_log="${LOG_DIR}/xorriso-extract.log"

    if ! "${XORRISO_BIN}" \
        -osirrox on \
        -indev "${ISO}" \
        -extract "${source_path}" "${destination}" \
        >>"${extract_log}" 2>&1; then
        fail "required ISO boot asset is missing: ${source_path}"
    fi
    [ -s "${destination}" ] ||
        fail "required ISO boot asset is empty: ${source_path}"
}

extract_required "/isolinux/isolinux.bin" "${TMP}/isolinux.bin"
extract_required "/EFI/BOOT/BOOTX64.EFI" "${TMP}/BOOTX64.EFI"
extract_required "/EFI/debian/grub.cfg" "${TMP}/grub.cfg"

monitor_send() {
    local command="$1"

    [ -n "${MONITOR_FD}" ] || fail "QEMU monitor is not connected"
    printf '%s\n' "${command}" >&"${MONITOR_FD}"
}

monitor_send_key() {
    monitor_send "sendkey $1 5"
}

monitor_type_text() {
    local value="$1"
    local index character key lower

    for ((index = 0; index < ${#value}; index++)); do
        character="${value:index:1}"
        case "${character}" in
            " ") key=spc ;;
            "=") key=equal ;;
            ",") key=comma ;;
            "-") key=minus ;;
            [A-Z])
                lower="$(printf '%s' "${character}" | tr '[:upper:]' '[:lower:]')"
                key="shift-${lower}"
                ;;
            [a-z0-9]) key="${character}" ;;
            *) fail "unsupported boot-parameter character: ${character}" ;;
        esac
        monitor_send_key "${key}"
    done
}

qemu_is_running() {
    if kill -0 "${QEMU_PID}" 2>/dev/null; then
        return 0
    fi

    local qemu_status
    set +e
    wait "${QEMU_PID}"
    qemu_status=$?
    set -e
    QEMU_PID=""
    fail "${CURRENT_FIRMWARE} QEMU exited before guest readiness (status ${qemu_status})"
}

hold_boot_menu() {
    local iterations=$((BOOT_MENU_WAIT_SECONDS * 2))
    local index

    # Arrow events are ignored by firmware before the bootloader appears. Once
    # the ISO menu owns the keyboard, they stop its timeout without selecting a
    # host-side kernel or bypassing the bootloader under test.
    for ((index = 0; index < iterations; index++)); do
        qemu_is_running
        monitor_send_key down
        sleep 0.5
    done
    monitor_send_key home
}

boot_selected_entry_with_serial() {
    local firmware="$1"
    local boot_parameters=" login console=ttyS0,115200n8"

    hold_boot_menu
    if [ "${firmware}" = "bios" ]; then
        monitor_send_key tab
        sleep 0.5
        monitor_type_text "${boot_parameters}"
        monitor_send_key ret
        return
    fi

    monitor_send_key e
    sleep 0.5
    # The checked-in GRUB entry is setparams, an echo, then the linux command.
    monitor_send_key down
    monitor_send_key down
    monitor_send_key end
    monitor_type_text "${boot_parameters}"
    monitor_send_key ctrl-x
}

serial_write() {
    [ -n "${SERIAL_FD}" ] || fail "guest serial console is not connected"
    printf '%s\r' "$1" >&"${SERIAL_FD}"
}

launch_firmware_vm() {
    local firmware="$1"
    local serial_prefix="${TMP}/${firmware}-serial"
    local monitor_prefix="${TMP}/${firmware}-monitor"
    local serial_log="${LOG_DIR}/${firmware}.serial.log"
    local monitor_log="${LOG_DIR}/${firmware}.monitor.log"
    local stdout_log="${LOG_DIR}/${firmware}.qemu.stdout"
    local stderr_log="${LOG_DIR}/${firmware}.qemu.stderr"
    local args_log="${LOG_DIR}/${firmware}.qemu.args"
    local ovmf_vars_copy="${TMP}/OVMF_VARS-${firmware}.fd"
    local -a qemu_args=(
        -name "elizaos-iso-smoke-${firmware}"
        -machine q35
        -accel kvm
        -accel "tcg,thread=multi"
        -m 4096
        -smp 2
        -drive "file=${ISO},media=cdrom,readonly=on,format=raw"
        -boot "order=d"
        -nic "user,model=virtio-net-pci"
        -device virtio-rng-pci
        -display none
        -vga std
        -serial "pipe:${serial_prefix}"
        -monitor "pipe:${monitor_prefix}"
        -no-reboot
        -snapshot
    )

    CURRENT_FIRMWARE="${firmware}"
    : >"${serial_log}"
    : >"${monitor_log}"
    : >"${stdout_log}"
    : >"${stderr_log}"
    mkfifo \
        "${serial_prefix}.in" \
        "${serial_prefix}.out" \
        "${monitor_prefix}.in" \
        "${monitor_prefix}.out"
    exec 8<>"${serial_prefix}.in"
    SERIAL_FD=8
    exec 9<>"${monitor_prefix}.in"
    MONITOR_FD=9
    cat "${serial_prefix}.out" >>"${serial_log}" &
    SERIAL_READER_PID=$!
    cat "${monitor_prefix}.out" >>"${monitor_log}" &
    MONITOR_READER_PID=$!

    if [ "${firmware}" = "uefi" ]; then
        cp "${OVMF_VARS}" "${ovmf_vars_copy}"
        qemu_args+=(
            -drive "if=pflash,format=raw,readonly=on,file=${OVMF_CODE}"
            -drive "if=pflash,format=raw,file=${ovmf_vars_copy}"
        )
    else
        qemu_args+=(-bios "${SEABIOS}")
    fi

    printf '%q ' "${QEMU_BIN}" "${qemu_args[@]}" >"${args_log}"
    printf '\n' >>"${args_log}"
    "${QEMU_BIN}" "${qemu_args[@]}" >"${stdout_log}" 2>"${stderr_log}" &
    QEMU_PID=$!
    boot_selected_entry_with_serial "${firmware}"
}

prove_guest_readiness() {
    local firmware="$1"
    local serial_log="${LOG_DIR}/${firmware}.serial.log"
    local marker="ELIZAOS_ISO_SMOKE_READY firmware=${firmware} service=active health=ready"
    local start_seconds="${SECONDS}"
    local login_prompt_seconds=-1
    local login_sent=0
    local password_sent=0
    local probe_sent=0
    local weak_seen=0
    local health_probe

    # The complete marker must not occur in serial input because the TTY echoes
    # commands before executing them. Joining two guest-side strings makes the
    # marker evidence possible only after both readiness checks pass.
    health_probe="for i in \$(seq 1 300); do if systemctl --user is-active --quiet elizaos-agent.service && /usr/bin/curl --noproxy '*' -fsS http://127.0.0.1:31337/api/health -o /tmp/elizaos-smoke-health.json && /bin/grep -Eq '\"ready\"[[:space:]]*:[[:space:]]*true' /tmp/elizaos-smoke-health.json; then printf '\\n%s%s\\n' 'ELIZAOS_ISO_SMOKE_' 'READY firmware=${firmware} service=active health=ready'; break; fi; sleep 2; done"

    while ((SECONDS - start_seconds < BOOT_TIMEOUT_SECONDS)); do
        if grep -Fq "${marker}" "${serial_log}" 2>/dev/null; then
            echo "ISO smoke test (${firmware}): canonical live-user service and health ready"
            return
        fi

        if grep -Eq 'Linux version|systemd\[1\]|[[:space:]]login:' "${serial_log}" 2>/dev/null; then
            weak_seen=1
        fi

        if [ "${login_prompt_seconds}" = "-1" ] &&
            grep -Eq '[[:space:]]login:' "${serial_log}" 2>/dev/null; then
            login_prompt_seconds="${SECONDS}"
        fi

        # Kernel `login` drives the real Tails greeter path. Its PostLogin hook
        # starts the live-user session and removes the password when no admin
        # password was configured; let that path settle before using the getty.
        if [ "${login_sent}" = "0" ] &&
            [ "${login_prompt_seconds}" != "-1" ] &&
            ((SECONDS - login_prompt_seconds >= LOGIN_SETTLE_SECONDS)); then
            serial_write amnesia
            login_sent=1
        fi

        if [ "${login_sent}" = "1" ] &&
            [ "${password_sent}" = "0" ] &&
            grep -Eq 'Password:' "${serial_log}" 2>/dev/null; then
            password_sent=1
            serial_write ""
        fi

        if [ "${login_sent}" = "1" ] &&
            [ "${probe_sent}" = "0" ] &&
            grep -Eq 'amnesia@|[$][[:space:]]*$' "${serial_log}" 2>/dev/null; then
            serial_write "${health_probe}"
            probe_sent=1
        fi

        qemu_is_running
        sleep "${POLL_SECONDS}"
    done

    if [ "${weak_seen}" = "1" ]; then
        fail "${firmware} firmware reached Linux userspace but did not prove the canonical live-user service and health endpoint"
    fi
    fail "${firmware} firmware did not reach Linux userspace before the smoke timeout"
}

echo "ISO boot equipment: bootable BIOS and UEFI El Torito entries present"
for firmware in bios uefi; do
    echo "Starting ${firmware} firmware boot and canonical userspace smoke (timeout: ${BOOT_TIMEOUT_SECONDS}s)"
    launch_firmware_vm "${firmware}"
    prove_guest_readiness "${firmware}"
    stop_qemu
done

echo "ISO smoke test passed through SeaBIOS and OVMF; logs retained at ${LOG_DIR}"
