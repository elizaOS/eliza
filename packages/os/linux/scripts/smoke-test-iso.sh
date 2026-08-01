#!/usr/bin/env bash
# Boots the release ISO through both of its firmware entry points and proves the
# canonical Tails live-user service reaches a healthy local API.

set -euo pipefail

ISO="${1:-}"
QEMU_BIN="${ELIZAOS_QEMU_BIN:-qemu-system-x86_64}"
XORRISO_BIN="${ELIZAOS_XORRISO_BIN:-xorriso}"
BOOT_TIMEOUT_SECONDS="${ELIZAOS_ISO_SMOKE_TIMEOUT_SECONDS:-900}"
BOOT_MENU_WAIT_SECONDS="${ELIZAOS_ISO_SMOKE_BOOT_MENU_WAIT_SECONDS:-10}"
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
require_positive_integer \
    "ELIZAOS_ISO_SMOKE_STOP_TIMEOUT_SECONDS" \
    "${STOP_TIMEOUT_SECONDS}"

[ -n "${ISO}" ] || fail "usage: $0 <iso-path>"
[ -f "${ISO}" ] || fail "ISO not found: ${ISO}"
command -v "${QEMU_BIN}" >/dev/null 2>&1 || fail "QEMU not found: ${QEMU_BIN}"
command -v "${XORRISO_BIN}" >/dev/null 2>&1 || fail "xorriso not found: ${XORRISO_BIN}"
command -v python3 >/dev/null 2>&1 || fail "python3 is required for the Tails remote-shell protocol"

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
REMOTE_SHELL_READER_PID=""
SERIAL_FD=""
MONITOR_FD=""
REMOTE_SHELL_FD=""
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
        dump_one_log "${LOG_DIR}/${firmware}.remote-shell.log"
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
    if [ -n "${REMOTE_SHELL_FD}" ]; then
        exec 7>&-
        REMOTE_SHELL_FD=""
    fi
}

stop_qemu() {
    close_pipe_fds
    stop_process_bounded "${QEMU_PID}" "${CURRENT_FIRMWARE:-QEMU} VM"
    stop_process_bounded "${SERIAL_READER_PID}" "${CURRENT_FIRMWARE:-QEMU} serial reader"
    stop_process_bounded "${MONITOR_READER_PID}" "${CURRENT_FIRMWARE:-QEMU} monitor reader"
    stop_process_bounded \
        "${REMOTE_SHELL_READER_PID}" \
        "${CURRENT_FIRMWARE:-QEMU} remote-shell reader"
    QEMU_PID=""
    SERIAL_READER_PID=""
    MONITOR_READER_PID=""
    REMOTE_SHELL_READER_PID=""
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
            "_") key=shift-minus ;;
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
    local boot_parameters=" login autotest_never_use_this_option console=ttyS0,115200n8"

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

remote_shell_send() {
    [ -n "${REMOTE_SHELL_FD}" ] || fail "Tails remote shell is not connected"
    printf '%s\n' "$1" >&"${REMOTE_SHELL_FD}"
}

queue_remote_signal_ready() {
    # Tails intentionally gates this VM-only virtio channel behind both an
    # explicit kernel option and a matching QEMU device. Acknowledging this
    # request releases GDM and proves that subsequent probes reach the guest.
    remote_shell_send '[1,"signal_ready"]'
}

queue_remote_readiness_probe() {
    local firmware="$1"
    local request_id="$2"
    local marker_suffix="READY firmware=${firmware} service=active health=ready"
    local health_probe

    # Each request is deliberately short. TCG boots can take many minutes on a
    # hosted runner, so one guest-side retry loop would hide its intermediate
    # state and race the outer timeout. The response reports the real bus,
    # service, curl, and payload states before the host schedules another try.
    health_probe="bus=missing; service=unavailable; service_rc=125; health=not-attempted; health_rc=125; health_body=''; if [ -S /run/user/1000/bus ]; then bus=ready; service=\$(XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user is-active elizaos-agent.service 2>&1); service_rc=\$?; if [ \"\${service_rc}\" -eq 0 ] && [ \"\${service}\" = active ]; then health_body=\$(/usr/bin/curl --noproxy '*' --connect-timeout 2 --max-time 5 -fsS http://127.0.0.1:31337/api/health 2>&1); health_rc=\$?; if [ \"\${health_rc}\" -eq 0 ] && printf '%s' \"\${health_body}\" | /bin/grep -Eq '\"ready\"[[:space:]]*:[[:space:]]*true'; then health=ready; else health=not-ready; fi; fi; fi; if [ \"\${bus}:\${service}:\${health}\" = ready:active:ready ]; then printf '%s%s' 'ELIZAOS_ISO_SMOKE_' '${marker_suffix}'; else printf 'ELIZAOS_ISO_SMOKE_WAIT bus=%s service=%s service_rc=%s health=%s health_rc=%s body=%s' \"\${bus}\" \"\${service}\" \"\${service_rc}\" \"\${health}\" \"\${health_rc}\" \"\${health_body}\"; fi"
    python3 -c \
        'import json, sys; print(json.dumps([int(sys.argv[1]), "sh_call", "amnesia", {}, sys.argv[2]]))' \
        "${request_id}" \
        "${health_probe}" \
        >&"${REMOTE_SHELL_FD}"
}

launch_firmware_vm() {
    local firmware="$1"
    local serial_prefix="${TMP}/${firmware}-serial"
    local monitor_prefix="${TMP}/${firmware}-monitor"
    local remote_shell_prefix="${TMP}/${firmware}-remote-shell"
    local serial_log="${LOG_DIR}/${firmware}.serial.log"
    local monitor_log="${LOG_DIR}/${firmware}.monitor.log"
    local remote_shell_log="${LOG_DIR}/${firmware}.remote-shell.log"
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
        -device virtio-serial-pci
        -chardev "pipe,id=remote-shell,path=${remote_shell_prefix}"
        -device "virtserialport,chardev=remote-shell,name=org.tails.remote_shell.0"
        -no-reboot
        -snapshot
    )

    CURRENT_FIRMWARE="${firmware}"
    : >"${serial_log}"
    : >"${monitor_log}"
    : >"${remote_shell_log}"
    : >"${stdout_log}"
    : >"${stderr_log}"
    mkfifo \
        "${serial_prefix}.in" \
        "${serial_prefix}.out" \
        "${monitor_prefix}.in" \
        "${monitor_prefix}.out" \
        "${remote_shell_prefix}.in" \
        "${remote_shell_prefix}.out"
    exec 8<>"${serial_prefix}.in"
    SERIAL_FD=8
    exec 9<>"${monitor_prefix}.in"
    MONITOR_FD=9
    exec 7<>"${remote_shell_prefix}.in"
    REMOTE_SHELL_FD=7
    cat "${serial_prefix}.out" >>"${serial_log}" &
    SERIAL_READER_PID=$!
    cat "${monitor_prefix}.out" >>"${monitor_log}" &
    MONITOR_READER_PID=$!
    cat "${remote_shell_prefix}.out" >>"${remote_shell_log}" &
    REMOTE_SHELL_READER_PID=$!

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
    queue_remote_signal_ready
}

prove_guest_readiness() {
    local firmware="$1"
    local serial_log="${LOG_DIR}/${firmware}.serial.log"
    local remote_shell_log="${LOG_DIR}/${firmware}.remote-shell.log"
    local marker="ELIZAOS_ISO_SMOKE_READY firmware=${firmware} service=active health=ready"
    local start_seconds="${SECONDS}"
    local signal_acked=0
    local probe_in_flight=0
    local probe_id=1
    local weak_seen=0

    while ((SECONDS - start_seconds < BOOT_TIMEOUT_SECONDS)); do
        if grep -Fq "${marker}" "${remote_shell_log}" 2>/dev/null; then
            echo "ISO smoke test (${firmware}): canonical live-user service and health ready"
            return
        fi

        if grep -Eq 'Linux version|systemd\[1\]|[[:space:]]login:' "${serial_log}" 2>/dev/null; then
            weak_seen=1
        fi

        if [ "${signal_acked}" = "0" ]; then
            if grep -Eq '^\[1, "error"' "${remote_shell_log}" 2>/dev/null; then
                fail "${firmware} Tails remote shell rejected signal_ready"
            fi
            if grep -Eq '^\[1, "success"' "${remote_shell_log}" 2>/dev/null; then
                signal_acked=1
            fi
        fi

        if [ "${signal_acked}" = "1" ]; then
            if [ "${probe_in_flight}" = "1" ] &&
                grep -Eq "^\\[${probe_id}, \\\"error\\\"" "${remote_shell_log}" 2>/dev/null; then
                fail "${firmware} Tails remote shell rejected readiness probe ${probe_id}"
            fi
            if [ "${probe_in_flight}" = "0" ] ||
                grep -Eq "^\\[${probe_id}, \\\"success\\\"" "${remote_shell_log}" 2>/dev/null; then
                probe_id=$((probe_id + 1))
                queue_remote_readiness_probe "${firmware}" "${probe_id}"
                probe_in_flight=1
            fi
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
