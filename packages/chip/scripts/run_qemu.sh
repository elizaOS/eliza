#!/usr/bin/env sh
set -eu

repo_dir=$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)
if [ "${ELIZA_RUN_QEMU_DISABLE_REPO_TOOLS:-0}" != "1" ] && [ -d "$repo_dir/tools/bin" ]; then
    PATH="${PATH}${PATH:+:}$repo_dir/tools/bin"
fi
if [ "${ELIZA_RUN_QEMU_DISABLE_REPO_TOOLS:-0}" != "1" ] && [ -d "$repo_dir/.venv/bin" ]; then
    PATH="${PATH}${PATH:+:}$repo_dir/.venv/bin"
fi
src="$repo_dir/sw/bootrom/e1_qemu_firmware.S"
linker="$repo_dir/sw/bootrom/linker.ld"
checked_elf="$repo_dir/build/qemu/e1_qemu_firmware.elf"
firmware_lock="$repo_dir/build/qemu/.e1_qemu_firmware.lock"
smoke_log="$repo_dir/build/reports/qemu_smoke.log"
smoke_manifest="$repo_dir/build/reports/qemu_smoke.manifest"
os_attempt_log="$repo_dir/build/reports/qemu_os_boot_attempt.log"
os_attempt_manifest="$repo_dir/build/reports/qemu_os_boot_attempt.json"
banner="eliza e1 qemu"
load_addr="0x80000000"
uart_addr="0x10000000"
linux_kernel=
linux_initrd=
linux_dtb=

usage() {
    cat <<EOF
usage: scripts/run_qemu.sh [--check|--check-os|--build-firmware|--build-stub|--elf PATH]

  --check           run semantic checks, build if possible, then bounded QEMU smoke
  --check-os        preflight and, when payloads exist, attempt bounded Linux/OS boot
  --build-firmware  build build/qemu/e1_qemu_firmware.elf with a local RISC-V toolchain
  --build-stub      compatibility alias for --build-firmware
  --elf PATH        launch an explicit ELF instead of the default firmware path
  --linux-kernel PATH  Linux kernel Image for --check-os
  --initrd PATH        initrd/rootfs image for --check-os
  --dtb PATH           optional device tree blob for --check-os
EOF
}

status_line() {
    state=$1
    check=$2
    detail=$3
    printf 'STATUS: %s %s - %s\n' "$state" "$check" "$detail"
}

acquire_firmware_lock() {
    timeout=${FIRMWARE_LOCK_TIMEOUT_SECONDS:-120}
    waited=0
    mkdir -p "$repo_dir/build/qemu"
    while ! mkdir "$firmware_lock" 2>/dev/null; do
        if [ "$waited" -ge "$timeout" ]; then
            status_line "FAIL" "qemu.firmware_lock" "timed out waiting for ${firmware_lock#"$repo_dir"/}; remove stale lock after confirming no simulator build is running"
            return 1
        fi
        sleep 1
        waited=$((waited + 1))
    done
}

release_firmware_lock() {
    rmdir "$firmware_lock" 2>/dev/null || true
}

sha256_file() {
    path=$1
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$path" | awk '{print $1}'
        return 0
    fi
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$path" | awk '{print $1}'
        return 0
    fi
    printf 'unavailable\n'
}

write_smoke_manifest() {
    state=$1
    detail=$2
    mkdir -p "$repo_dir/build/reports"
    {
        printf 'status=%s\n' "$state"
        printf 'check=qemu.run\n'
        printf 'evidence_kind=qemu-executable-transcript\n'
        printf 'archive=%s\n' "${smoke_log#"$repo_dir"/}"
        if [ -f "$smoke_log" ]; then
            printf 'sha256=%s\n' "$(sha256_file "$smoke_log")"
        else
            printf 'sha256=missing\n'
        fi
        printf 'banner=%s\n' "$banner"
        printf 'firmware=%s\n' "${checked_elf#"$repo_dir"/}"
        if [ -f "$checked_elf" ]; then
            printf 'firmware_sha256=%s\n' "$(sha256_file "$checked_elf")"
        else
            printf 'firmware_sha256=missing\n'
        fi
        printf 'qemu=%s\n' "$(command -v qemu-system-riscv64 2>/dev/null || printf 'missing')"
        printf 'qemu_version=%s\n' "$(qemu-system-riscv64 --version 2>/dev/null | head -n 1 || printf 'unavailable')"
        printf 'qemu_command=qemu-system-riscv64 -machine virt -nographic -bios none -no-reboot -kernel %s\n' "${checked_elf#"$repo_dir"/}"
        printf 'detail=%s\n' "$detail"
    } >"$smoke_manifest"
}

find_toolchain() {
    if [ -n "${RISCV_CC:-}" ]; then
        command -v "$RISCV_CC" >/dev/null 2>&1 && {
            printf '%s\n' "$RISCV_CC"
            return 0
        }
        return 1
    fi

    for cc in riscv64-unknown-elf-gcc riscv64-elf-gcc riscv64-linux-gnu-gcc; do
        if command -v "$cc" >/dev/null 2>&1; then
            printf '%s\n' "$cc"
            return 0
        fi
    done

    clang_candidates=${RISCV_CLANG_CANDIDATES:-"/opt/homebrew/opt/llvm/bin/clang clang"}
    for cc in $clang_candidates; do
        if command -v "$cc" >/dev/null 2>&1; then
            if clang_can_link_riscv_elf "$cc"; then
                printf '%s\n' "$cc"
                return 0
            fi
        fi
    done

    return 1
}

clang_can_link_riscv_elf() {
    cc=$1
    test_base="${TMPDIR:-/tmp}/eliza-riscv-toolchain-test.$$"
    test_src="${test_base}.S"
    test_elf="${test_base}.elf"
    cat >"$test_src" <<'EOF'
.section .text
.globl _start
_start:
    j _start
EOF
    if "$cc" --target=riscv64-unknown-elf -fuse-ld=lld \
        -nostdlib -nostartfiles -ffreestanding \
        -march=rv64imac -mabi=lp64 \
        -x assembler "$test_src" -o "$test_elf" >/dev/null 2>&1; then
        rm -f "$test_src" "$test_elf"
        return 0
    fi
    rm -f "$test_src" "$test_elf"
    return 1
}

explain_toolchain_blocker() {
    cat <<EOF
BLOCKED: no RISC-V ELF toolchain found on PATH.
Install one of:
  - Ubuntu/Debian: apt-get install gcc-riscv64-unknown-elf
  - Other systems: riscv64-unknown-elf-gcc or riscv64-elf-gcc
  - macOS/Homebrew LLVM: /opt/homebrew/opt/llvm/bin/clang with lld
Or set RISCV_CC to a compatible compiler.
EOF
}

semantic_check() {
    failed=0

    for path in "$src" "$linker" "$repo_dir/docs/sim/qemu/README.md"; do
        if [ ! -f "$path" ]; then
            status_line "FAIL" "qemu.semantic" "missing required artifact ${path#"$repo_dir"/}"
            failed=1
        fi
    done

    if [ "$failed" -ne 0 ]; then
        return 1
    fi

    grep -q "$banner" "$src" || {
        status_line "FAIL" "qemu.semantic" "sw/bootrom/e1_qemu_firmware.S must print '$banner'"
        failed=1
    }
    grep -q "E1_QEMU_VIRT_UART_BASE" "$src" || grep -Eqi "li[[:space:]]+a1,[[:space:]]*$uart_addr" "$src" || {
        status_line "FAIL" "qemu.semantic" "firmware must write the qemu-virt UART at $uart_addr via the platform contract"
        failed=1
    }
    grep -q "$load_addr" "$linker" || {
        status_line "FAIL" "qemu.semantic" "sw/bootrom/linker.ld must link qemu-virt firmware at $load_addr"
        failed=1
    }
    grep -q "ENTRY(_start)" "$linker" || {
        status_line "FAIL" "qemu.semantic" "sw/bootrom/linker.ld must keep _start as the ELF entry"
        failed=1
    }
    grep -q "software reference only" "$repo_dir/docs/sim/qemu/README.md" || {
        status_line "FAIL" "qemu.semantic" "docs/sim/qemu/README.md must mark qemu-virt as software reference only"
        failed=1
    }
    grep -q "scripts/run_qemu.sh --build-firmware" "$repo_dir/docs/sim/qemu/README.md" || {
        status_line "FAIL" "qemu.semantic" "docs/sim/qemu/README.md must document the firmware ELF build path"
        failed=1
    }

    if [ "$failed" -eq 0 ]; then
        status_line "PASS" "qemu.semantic" "source, linker, and docs match qemu-virt contract"
    fi
    return "$failed"
}

build_firmware() {
    cc=$(find_toolchain) || {
        explain_toolchain_blocker
        status_line "BLOCKED" "qemu.build" "install a RISC-V ELF compiler or set RISCV_CC"
        return 2
    }

    mkdir -p "$repo_dir/build/qemu"
    if [ "$(basename "$cc")" = "clang" ]; then
        set -- "$cc" --target=riscv64-unknown-elf -fuse-ld=lld
    else
        set -- "$cc"
    fi

    if ! "$@" -nostdlib -nostartfiles -ffreestanding \
        -march=rv64imac -mabi=lp64 \
        -Wl,-T,"$linker" -Wl,--build-id=none \
        -o "$checked_elf" "$src"; then
        status_line "FAIL" "qemu.build" "$cc could not build ${src#"$repo_dir"/}"
        return 1
    fi
    status_line "PASS" "qemu.build" "built ${checked_elf#"$repo_dir"/} with $cc"
}

run_bounded_smoke() {
    elf=$1

    if ! command -v qemu-system-riscv64 >/dev/null 2>&1; then
        echo "BLOCKED: qemu-system-riscv64 missing."
        status_line "BLOCKED" "qemu.run" "install qemu-system-riscv64 for executable serial smoke"
        return 2
    fi

    log=$(mktemp "${TMPDIR:-/tmp}/e1-qemu.XXXXXX")
    qemu-system-riscv64 -machine virt -nographic -bios none -no-reboot -kernel "$elf" >"$log" 2>&1 &
    qemu_pid=$!

    sleep "${QEMU_SMOKE_SECONDS:-2}"
    if kill -0 "$qemu_pid" >/dev/null 2>&1; then
        kill "$qemu_pid" >/dev/null 2>&1 || true
    fi
    wait "$qemu_pid" >/dev/null 2>&1 || true

    if grep -q "$banner" "$log"; then
        mkdir -p "$repo_dir/build/reports"
        cp "$log" "$smoke_log"
        write_smoke_manifest "PASS" "bounded QEMU stdout/stderr contained expected serial banner"
        status_line "PASS" "qemu.run" "bounded smoke saw '$banner'; archived ${smoke_log#"$repo_dir"/}"
        rm -f "$log"
        return 0
    fi

    mkdir -p "$repo_dir/build/reports"
    cp "$log" "$smoke_log"
    write_smoke_manifest "FAIL" "bounded QEMU stdout/stderr did not contain expected serial banner"
    status_line "FAIL" "qemu.run" "bounded smoke did not see '$banner'"
    echo "QEMU log: $smoke_log"
    rm -f "$log"
    return 1
}

default_os_payload() {
    for path in \
        "$repo_dir/build/linux/arch/riscv/boot/Image" \
        "$repo_dir/build/linux/Image" \
        "$repo_dir/build/qemu/linux_payload/debian-installer-riscv64-20260517T000000Z/linux" \
        "$repo_dir/build/qemu/linux_payload/debian-installer-riscv64/linux" \
        "$repo_dir/build/buildroot/images/Image" \
        "$repo_dir/buildroot/output/images/Image"; do
        if [ -f "$path" ]; then
            printf '%s\n' "$path"
            return 0
        fi
    done
    return 1
}

default_initrd_payload() {
    for path in \
        "$repo_dir/build/buildroot/images/rootfs.cpio" \
        "$repo_dir/build/buildroot/images/rootfs.cpio.gz" \
        "$repo_dir/build/qemu/linux_payload/debian-installer-riscv64-20260517T000000Z/initrd.gz" \
        "$repo_dir/build/qemu/linux_payload/debian-installer-riscv64/initrd.gz" \
        "$repo_dir/buildroot/output/images/rootfs.cpio" \
        "$repo_dir/buildroot/output/images/rootfs.cpio.gz"; do
        if [ -f "$path" ]; then
            printf '%s\n' "$path"
            return 0
        fi
    done
    return 1
}

default_dtb_payload() {
    for path in \
        "$repo_dir/build/linux/arch/riscv/boot/dts/eliza/eliza-e1.dtb" \
        "$repo_dir/build/buildroot/images/eliza-e1.dtb" \
        "$repo_dir/buildroot/output/images/eliza-e1.dtb"; do
        if [ -f "$path" ]; then
            printf '%s\n' "$path"
            return 0
        fi
    done
    return 1
}

write_os_attempt_manifest() {
    state=$1
    detail=$2
    mkdir -p "$repo_dir/build/reports"
    qemu_path=$(command -v qemu-system-riscv64 2>/dev/null || printf 'missing')
    qemu_version=$(qemu-system-riscv64 --version 2>/dev/null | head -n 1 || printf 'unavailable')
    kernel_sha=$(if [ -n "${linux_kernel:-}" ] && [ -f "$linux_kernel" ]; then sha256_file "$linux_kernel"; else printf 'missing'; fi)
    initrd_sha=$(if [ -n "${linux_initrd:-}" ] && [ -f "$linux_initrd" ]; then sha256_file "$linux_initrd"; else printf 'missing'; fi)
    dtb_sha=$(if [ -n "${linux_dtb:-}" ] && [ -f "$linux_dtb" ]; then sha256_file "$linux_dtb"; else printf 'optional-missing'; fi)
    OS_ATTEMPT_MANIFEST=$os_attempt_manifest \
    OS_ATTEMPT_STATE=$state \
    OS_ATTEMPT_DETAIL=$detail \
    OS_ATTEMPT_QEMU=$qemu_path \
    OS_ATTEMPT_QEMU_VERSION=$qemu_version \
    OS_ATTEMPT_KERNEL=${linux_kernel:-missing} \
    OS_ATTEMPT_KERNEL_SHA=$kernel_sha \
    OS_ATTEMPT_INITRD=${linux_initrd:-missing} \
    OS_ATTEMPT_INITRD_SHA=$initrd_sha \
    OS_ATTEMPT_DTB=${linux_dtb:-optional-missing} \
    OS_ATTEMPT_DTB_SHA=$dtb_sha \
    OS_ATTEMPT_TRANSCRIPT=${os_attempt_log#"$repo_dir"/} \
    python3 - <<'PY'
import json
import os
from pathlib import Path

payload = {
    "schema": "eliza.qemu_virt_os_boot_attempt.v1",
    "claim_boundary": "qemu_virt_reference_only_not_e1_chip_rtl",
    "status": os.environ["OS_ATTEMPT_STATE"],
    "check": "qemu.os_boot",
    "detail": os.environ["OS_ATTEMPT_DETAIL"],
    "qemu": os.environ["OS_ATTEMPT_QEMU"],
    "qemu_version": os.environ["OS_ATTEMPT_QEMU_VERSION"],
    "kernel": os.environ["OS_ATTEMPT_KERNEL"],
    "kernel_sha256": os.environ["OS_ATTEMPT_KERNEL_SHA"],
    "initrd": os.environ["OS_ATTEMPT_INITRD"],
    "initrd_sha256": os.environ["OS_ATTEMPT_INITRD_SHA"],
    "dtb": os.environ["OS_ATTEMPT_DTB"],
    "dtb_sha256": os.environ["OS_ATTEMPT_DTB_SHA"],
    "transcript": os.environ["OS_ATTEMPT_TRANSCRIPT"],
}
if os.environ["OS_ATTEMPT_STATE"].upper() != "PASS":
    missing = []
    if os.environ["OS_ATTEMPT_KERNEL_SHA"] == "missing":
        missing.append(("linux_kernel_image", os.environ["OS_ATTEMPT_KERNEL"]))
    if os.environ["OS_ATTEMPT_INITRD_SHA"] == "missing":
        missing.append(("initrd_or_rootfs_image", os.environ["OS_ATTEMPT_INITRD"]))
    if os.environ["OS_ATTEMPT_QEMU"] == "missing":
        missing.append(("qemu_system_riscv64", "qemu-system-riscv64"))
    if not missing:
        missing.append(("qemu_os_boot_runtime_marker", os.environ["OS_ATTEMPT_TRANSCRIPT"]))
    payload["findings"] = [
        {
            "code": f"qemu_os_boot_{code}",
            "severity": "blocker",
            "message": f"qemu-virt OS boot attempt is blocked by {code.replace('_', ' ')}",
            "evidence": evidence,
            "next_step": (
                "Provide the missing qemu-virt Linux payload/tool or fix the archived boot "
                "transcript so scripts/run_qemu.sh --check-os reaches an init/login marker."
            ),
        }
        for code, evidence in missing
    ]
Path(os.environ["OS_ATTEMPT_MANIFEST"]).write_text(
    json.dumps(payload, indent=2, sort_keys=True) + "\n"
)
PY
}

write_os_attempt_log() {
    state=$1
    detail=$2
    mkdir -p "$repo_dir/build/reports"
    {
        printf 'status=%s\n' "$state"
        printf 'check=qemu.os_boot\n'
        printf 'evidence_kind=qemu-os-boot-attempt\n'
        printf 'detail=%s\n' "$detail"
        printf 'qemu=%s\n' "$(command -v qemu-system-riscv64 2>/dev/null || printf 'missing')"
        printf 'kernel=%s\n' "${linux_kernel:-missing}"
        if [ -n "${linux_kernel:-}" ] && [ -f "$linux_kernel" ]; then
            printf 'kernel_sha256=%s\n' "$(sha256_file "$linux_kernel")"
        else
            printf 'kernel_sha256=missing\n'
        fi
        printf 'initrd=%s\n' "${linux_initrd:-missing}"
        if [ -n "${linux_initrd:-}" ] && [ -f "$linux_initrd" ]; then
            printf 'initrd_sha256=%s\n' "$(sha256_file "$linux_initrd")"
        else
            printf 'initrd_sha256=missing\n'
        fi
        printf 'dtb=%s\n' "${linux_dtb:-optional-missing}"
        if [ -n "${linux_dtb:-}" ] && [ -f "$linux_dtb" ]; then
            printf 'dtb_sha256=%s\n' "$(sha256_file "$linux_dtb")"
        else
            printf 'dtb_sha256=optional-missing\n'
        fi
    } >"$os_attempt_log"
    write_os_attempt_manifest "$state" "$detail"
}

check_os_boot() {
    if [ -z "$linux_kernel" ]; then
        linux_kernel=$(default_os_payload || true)
    fi
    if [ -z "$linux_initrd" ]; then
        linux_initrd=$(default_initrd_payload || true)
    fi
    if [ -z "$linux_dtb" ]; then
        linux_dtb=$(default_dtb_payload || true)
    fi

    missing=
    if [ -z "$linux_kernel" ] || [ ! -f "$linux_kernel" ]; then
        missing="${missing} Linux kernel Image"
    fi
    if [ -z "$linux_initrd" ] || [ ! -f "$linux_initrd" ]; then
        missing="${missing} initrd/rootfs image"
    fi
    if ! command -v qemu-system-riscv64 >/dev/null 2>&1; then
        missing="${missing} qemu-system-riscv64"
    fi

    if [ -n "$missing" ]; then
        detail="OS boot blocked; missing:${missing}. Build/import Linux plus rootfs artifacts before claiming OS boot."
        write_os_attempt_log "BLOCKED" "$detail"
        status_line "BLOCKED" "qemu.os_boot" "$detail; wrote ${os_attempt_log#"$repo_dir"/}"
        return 2
    fi

    log=$(mktemp "${TMPDIR:-/tmp}/eliza-qemu-os.XXXXXX")
    set -- qemu-system-riscv64 -machine virt -m "${QEMU_OS_MEMORY:-2G}" -nographic -no-reboot \
        -kernel "$linux_kernel" \
        -initrd "$linux_initrd" \
        -append "console=ttyS0 earlycon"
    if [ -n "$linux_dtb" ] && [ -f "$linux_dtb" ]; then
        set -- "$@" -dtb "$linux_dtb"
    fi

    "$@" >"$log" 2>&1 &
    qemu_pid=$!
    sleep "${QEMU_OS_BOOT_SECONDS:-10}"
    if kill -0 "$qemu_pid" >/dev/null 2>&1; then
        kill "$qemu_pid" >/dev/null 2>&1 || true
    fi
    wait "$qemu_pid" >/dev/null 2>&1 || true

    mkdir -p "$repo_dir/build/reports"
    cp "$log" "$os_attempt_log"
    rm -f "$log"

    if grep -Eiq "Kernel panic|No working init found|Oops:|Unable to mount root fs" "$os_attempt_log"; then
        write_os_attempt_manifest "FAIL" "bounded QEMU OS boot hit a kernel panic or fatal init/rootfs error; transcript archived"
        status_line "FAIL" "qemu.os_boot" "bounded QEMU OS boot hit a kernel panic or fatal init/rootfs error; archived ${os_attempt_log#"$repo_dir"/}"
        return 1
    fi

    if grep -Eq "Welcome to|login:|Debian GNU/Linux installer|Starting system log daemon|Reached target|sysinit.target" "$os_attempt_log"; then
        write_os_attempt_manifest "PASS" "bounded QEMU OS boot reached an init/login marker; transcript archived"
        status_line "PASS" "qemu.os_boot" "bounded QEMU OS boot reached an init/login marker; archived ${os_attempt_log#"$repo_dir"/}"
        return 0
    fi

    write_os_attempt_manifest "FAIL" "bounded QEMU OS boot did not reach an init/login marker; transcript archived"
    status_line "FAIL" "qemu.os_boot" "bounded QEMU OS boot did not reach an init/login marker; archived ${os_attempt_log#"$repo_dir"/}"
    return 1
}

mode=run
elf=

while [ "$#" -gt 0 ]; do
    case "$1" in
        --check)
            mode=check
            ;;
        --check-os)
            mode=check_os
            ;;
        --build-firmware|--build-stub)
            mode=build
            ;;
        --elf)
            shift
            if [ "$#" -eq 0 ]; then
                usage
                exit 2
            fi
            elf=$1
            ;;
        --linux-kernel)
            shift
            if [ "$#" -eq 0 ]; then
                usage
                exit 2
            fi
            linux_kernel=$1
            ;;
        --initrd)
            shift
            if [ "$#" -eq 0 ]; then
                usage
                exit 2
            fi
            linux_initrd=$1
            ;;
        --dtb)
            shift
            if [ "$#" -eq 0 ]; then
                usage
                exit 2
            fi
            linux_dtb=$1
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            usage
            exit 2
            ;;
    esac
    shift
done

cd "$repo_dir"
if ! semantic_check; then
    exit 1
fi

case "$mode" in
    build)
        acquire_firmware_lock || exit $?
        trap release_firmware_lock EXIT INT TERM
        build_firmware
        ;;
    check)
        acquire_firmware_lock || exit $?
        trap release_firmware_lock EXIT INT TERM
        if build_firmware; then
            if run_bounded_smoke "$checked_elf"; then
                status_line "PASS" "qemu.check" "semantic, build, and executable smoke passed"
            else
                status=$?
                if [ "$status" -eq 2 ]; then
                    status_line "BLOCKED" "qemu.check" "semantic/build passed; executable smoke needs qemu-system-riscv64"
                    if [ "${REQUIRE_QEMU:-0}" != "1" ]; then
                        exit 0
                    fi
                fi
                exit "$status"
            fi
        else
            status=$?
            if [ "$status" -eq 2 ]; then
                status_line "BLOCKED" "qemu.check" "semantic checks passed; executable smoke needs a RISC-V ELF toolchain"
                if [ "${REQUIRE_QEMU:-0}" != "1" ]; then
                    exit 0
                fi
            fi
            exit "$status"
        fi
        ;;
    check_os)
        check_os_boot
        ;;
    run)
        if [ -z "$elf" ]; then
            if [ -f "$checked_elf" ]; then
                elf=$checked_elf
            else
                build_firmware || exit $?
                elf=$checked_elf
            fi
        fi

        if ! command -v qemu-system-riscv64 >/dev/null 2>&1; then
            echo "BLOCKED: qemu-system-riscv64 missing."
            status_line "BLOCKED" "qemu.run" "install qemu-system-riscv64 or run scripts/run_qemu.sh --check for non-strict status"
            exit 2
        fi
        if [ ! -f "$elf" ]; then
            status_line "FAIL" "qemu.run" "$elf missing"
            exit 1
        fi

        echo "Launching qemu-virt software reference target. This is not the e1-chip hardware ABI. Ctrl-A X exits."
        qemu-system-riscv64 -machine virt -nographic -bios none -no-reboot -kernel "$elf"
        ;;
esac
