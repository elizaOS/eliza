#!/usr/bin/env bash
# Buildroot rv64gc qemu-system-riscv64 -M virt smoke harness.
#
# Boots a Buildroot-produced rv64gc Image + initramfs cpio under
# `qemu-system-riscv64 -M virt`, captures the serial transcript, validates
# the transcript for the required boot markers and the absence of forbidden
# markers, and writes a JSON evidence record at --evidence.
#
# Honesty / fail-closed rules:
#   - This harness is qemu-virt boot transcript evidence only. It does NOT
#     prove silicon boot, physical board boot, or a real Buildroot image on
#     anything other than qemu-system-riscv64 -M virt. The emitted JSON
#     carries an explicit `claim_boundary` field that captures that limit.
#   - The harness exits with STATUS: BLOCKED if qemu-system-riscv64 is not
#     on PATH or if either kernel/rootfs input is missing on disk. It does
#     not synthesise inputs.
#   - The harness exits non-zero on any forbidden marker (Kernel panic,
#     Oops, BUG:) or on a missing required marker (Linux version, Welcome
#     to Buildroot, login:).
#
# Usage:
#   capture-buildroot-qemu-virt-smoke.sh \
#       [--kernel <Image>] [--rootfs <rootfs.cpio>] \
#       [--memory <MB>] [--cpus <N>] [--timeout <sec>] [--evidence <path>]
#
# Defaults (relative to packages/chip):
#   --kernel    external/buildroot-rv64/output/images/Image
#   --rootfs    external/buildroot-rv64/output/images/rootfs.cpio
#   --memory    1024 (MB)
#   --cpus      2
#   --timeout   300  (seconds)
#   --evidence  docs/evidence/linux/buildroot_qemu_virt_smoke.json
#
# Transcript path defaults next to the evidence file with a
# `.transcript.log` suffix.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHIP_ROOT="$(cd "${HERE}/../../.." && pwd)"

KERNEL_DEFAULT="${CHIP_ROOT}/external/buildroot-rv64/output/images/Image"
ROOTFS_DEFAULT="${CHIP_ROOT}/external/buildroot-rv64/output/images/rootfs.cpio"
EVIDENCE_DEFAULT="${CHIP_ROOT}/docs/evidence/linux/buildroot_qemu_virt_smoke.json"

KERNEL_PATH=""
ROOTFS_PATH=""
MEMORY_MB=1024
CPUS=2
TIMEOUT_SECS=300
EVIDENCE_PATH=""
TRANSCRIPT_PATH=""

die() {
    printf 'capture-buildroot-qemu-virt-smoke: ERROR: %s\n' "$*" >&2
    exit 1
}

usage() {
    sed -n '1,40p' "${BASH_SOURCE[0]}"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --kernel)
            [ $# -ge 2 ] || die "--kernel requires a value"
            KERNEL_PATH="$2"; shift 2;;
        --rootfs)
            [ $# -ge 2 ] || die "--rootfs requires a value"
            ROOTFS_PATH="$2"; shift 2;;
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
        -h|--help)
            usage; exit 0;;
        *)
            die "unknown argument: $1";;
    esac
done

KERNEL_PATH="${KERNEL_PATH:-${KERNEL_DEFAULT}}"
ROOTFS_PATH="${ROOTFS_PATH:-${ROOTFS_DEFAULT}}"
EVIDENCE_PATH="${EVIDENCE_PATH:-${EVIDENCE_DEFAULT}}"
TRANSCRIPT_PATH="${TRANSCRIPT_PATH:-${EVIDENCE_PATH%.json}.transcript.log}"

case "${MEMORY_MB}" in
    ''|*[!0-9]*) die "--memory must be a positive integer (MB)";;
esac
case "${CPUS}" in
    ''|*[!0-9]*) die "--cpus must be a positive integer";;
esac
case "${TIMEOUT_SECS}" in
    ''|*[!0-9]*) die "--timeout must be a positive integer (seconds)";;
esac
[ "${MEMORY_MB}" -ge 64 ] || die "--memory must be >= 64 MB"
[ "${CPUS}" -ge 1 ] || die "--cpus must be >= 1"
[ "${TIMEOUT_SECS}" -ge 1 ] || die "--timeout must be >= 1"

command -v python3 >/dev/null 2>&1 \
    || die "python3 not on PATH"
command -v sha256sum >/dev/null 2>&1 \
    || die "sha256sum not on PATH"

mkdir -p "$(dirname "${EVIDENCE_PATH}")"
mkdir -p "$(dirname "${TRANSCRIPT_PATH}")"

emit_blocked() {
    local reason="$1"
    printf 'capture-buildroot-qemu-virt-smoke: STATUS: BLOCKED %s\n' "${reason}" >&2
    KERNEL_SHA256="$([ -f "${KERNEL_PATH}" ] && sha256sum "${KERNEL_PATH}" | awk '{ print $1 }' || printf '')"
    ROOTFS_SHA256="$([ -f "${ROOTFS_PATH}" ] && sha256sum "${ROOTFS_PATH}" | awk '{ print $1 }' || printf '')"
    QVB_BLOCKED_REASON="${reason}" \
    QVB_KERNEL_PATH="${KERNEL_PATH}" \
    QVB_KERNEL_SHA256="${KERNEL_SHA256}" \
    QVB_ROOTFS_PATH="${ROOTFS_PATH}" \
    QVB_ROOTFS_SHA256="${ROOTFS_SHA256}" \
    QVB_EVIDENCE_PATH="${EVIDENCE_PATH}" \
    QVB_TRANSCRIPT_PATH="${TRANSCRIPT_PATH}" \
    QVB_MEMORY_MB="${MEMORY_MB}" \
    QVB_CPUS="${CPUS}" \
    QVB_TIMEOUT_S="${TIMEOUT_SECS}" \
    python3 - <<'PYEOF'
import json
import os

doc = {
    "schema": "eliza.chip.buildroot_qemu_virt_smoke.v1",
    "claim_boundary": (
        "buildroot_qemu_virt_smoke_evidence_only_no_silicon_or_physical_board_claim"
    ),
    "status": "blocked",
    "blocked_reason": os.environ["QVB_BLOCKED_REASON"],
    "kernel_path": os.environ["QVB_KERNEL_PATH"],
    "kernel_sha256": os.environ["QVB_KERNEL_SHA256"],
    "rootfs_path": os.environ["QVB_ROOTFS_PATH"],
    "rootfs_sha256": os.environ["QVB_ROOTFS_SHA256"],
    "transcript_path": os.environ["QVB_TRANSCRIPT_PATH"],
    "transcript_sha256": "",
    "memory_mb": int(os.environ["QVB_MEMORY_MB"]),
    "cpus": int(os.environ["QVB_CPUS"]),
    "timeout_s": int(os.environ["QVB_TIMEOUT_S"]),
    "duration_s": 0,
    "markers_found": [],
    "markers_missing": [
        "Linux version",
        "Welcome to Buildroot",
        "login:",
    ],
    "forbidden_markers_found": [],
    "boot_completed": False,
    "provenance": "qemu_virt",
}
with open(os.environ["QVB_EVIDENCE_PATH"], "w", encoding="utf-8") as fh:
    json.dump(doc, fh, indent=2, sort_keys=True)
    fh.write("\n")
PYEOF
    exit 1
}

if ! command -v qemu-system-riscv64 >/dev/null 2>&1; then
    emit_blocked "qemu-system-riscv64 not on PATH"
fi

if [ ! -f "${KERNEL_PATH}" ]; then
    emit_blocked "kernel image not found: ${KERNEL_PATH}"
fi

if [ ! -f "${ROOTFS_PATH}" ]; then
    emit_blocked "rootfs cpio not found: ${ROOTFS_PATH}"
fi

KERNEL_SHA256="$(sha256sum "${KERNEL_PATH}" | awk '{ print $1 }')"
ROOTFS_SHA256="$(sha256sum "${ROOTFS_PATH}" | awk '{ print $1 }')"

QEMU_CMD=(qemu-system-riscv64
    -M virt
    -nographic
    -kernel "${KERNEL_PATH}"
    -initrd "${ROOTFS_PATH}"
    -append "console=ttyS0,115200n8 earlycon=sbi"
    -m "${MEMORY_MB}M"
    -smp "${CPUS}"
    -no-reboot
)

START_EPOCH="$(date -u +%s)"
START_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

: > "${TRANSCRIPT_PATH}"
{
    printf '## buildroot_qemu_virt_smoke transcript\n'
    printf '## start_utc: %s\n' "${START_UTC}"
    printf '## kernel: %s\n' "${KERNEL_PATH}"
    printf '## kernel_sha256: %s\n' "${KERNEL_SHA256}"
    printf '## rootfs: %s\n' "${ROOTFS_PATH}"
    printf '## rootfs_sha256: %s\n' "${ROOTFS_SHA256}"
    printf '## memory_mb: %s\n' "${MEMORY_MB}"
    printf '## cpus: %s\n' "${CPUS}"
    printf '## timeout_secs: %s\n' "${TIMEOUT_SECS}"
    printf '## cmd: %s\n' "${QEMU_CMD[*]}"
    printf '##\n'
} >> "${TRANSCRIPT_PATH}"

REQUIRED_MARKERS=(
    "Linux version"
    "Welcome to Buildroot"
    "login:"
)
FORBIDDEN_MARKERS=(
    "Kernel panic"
    "Oops"
    "BUG:"
)

all_required_present() {
    local marker
    for marker in "${REQUIRED_MARKERS[@]}"; do
        if ! grep -F -q -- "${marker}" "${TRANSCRIPT_PATH}"; then
            return 1
        fi
    done
    return 0
}

forbidden_marker_present() {
    local marker
    for marker in "${FORBIDDEN_MARKERS[@]}"; do
        if grep -F -q -- "${marker}" "${TRANSCRIPT_PATH}"; then
            return 0
        fi
    done
    return 1
}

set +e
"${QEMU_CMD[@]}" </dev/null >> "${TRANSCRIPT_PATH}" 2>&1 &
QEMU_PID=$!
QEMU_RC=124
QEMU_TIMED_OUT=0
while kill -0 "${QEMU_PID}" >/dev/null 2>&1; do
    if all_required_present; then
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
if [ "${QEMU_RC}" -eq 124 ] && [ "${QEMU_TIMED_OUT}" -eq 0 ] \
        && ! kill -0 "${QEMU_PID}" >/dev/null 2>&1; then
    wait "${QEMU_PID}"
    QEMU_RC=$?
fi
set -e

END_EPOCH="$(date -u +%s)"
DURATION_S=$(( END_EPOCH - START_EPOCH ))

MARKERS_FOUND=()
MARKERS_MISSING=()
for marker in "${REQUIRED_MARKERS[@]}"; do
    if grep -F -q -- "${marker}" "${TRANSCRIPT_PATH}"; then
        MARKERS_FOUND+=( "${marker}" )
    else
        MARKERS_MISSING+=( "${marker}" )
    fi
done

FORBIDDEN_HIT=()
for forbid in "${FORBIDDEN_MARKERS[@]}"; do
    if grep -F -q -- "${forbid}" "${TRANSCRIPT_PATH}"; then
        FORBIDDEN_HIT+=( "${forbid}" )
    fi
done

BOOT_COMPLETED="false"
if [ ${#FORBIDDEN_HIT[@]} -eq 0 ] && [ ${#MARKERS_MISSING[@]} -eq 0 ]; then
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
export QVB_KERNEL_PATH="${KERNEL_PATH}"
export QVB_KERNEL_SHA256="${KERNEL_SHA256}"
export QVB_ROOTFS_PATH="${ROOTFS_PATH}"
export QVB_ROOTFS_SHA256="${ROOTFS_SHA256}"
export QVB_TRANSCRIPT_PATH="${TRANSCRIPT_PATH}"
export QVB_TRANSCRIPT_SHA256="${TRANSCRIPT_SHA256}"
export QVB_MEMORY_MB="${MEMORY_MB}"
export QVB_CPUS="${CPUS}"
export QVB_TIMEOUT_S="${TIMEOUT_SECS}"
export QVB_DURATION_S="${DURATION_S}"
export QVB_START_UTC="${START_UTC}"
export QVB_QEMU_RC="${QEMU_RC}"
export QVB_BOOT_COMPLETED="${BOOT_COMPLETED}"
export QVB_MARKERS_FOUND_JSON="${MARKERS_FOUND_JSON}"
export QVB_MARKERS_MISSING_JSON="${MARKERS_MISSING_JSON}"
export QVB_FORBIDDEN_HIT_JSON="${FORBIDDEN_HIT_JSON}"

python3 - <<'PYEOF'
import json
import os

doc = {
    "schema": "eliza.chip.buildroot_qemu_virt_smoke.v1",
    "claim_boundary": (
        "buildroot_qemu_virt_smoke_evidence_only_no_silicon_or_physical_board_claim"
    ),
    "status": "pass" if os.environ["QVB_BOOT_COMPLETED"] == "true" else "fail",
    "kernel_path": os.environ["QVB_KERNEL_PATH"],
    "kernel_sha256": os.environ["QVB_KERNEL_SHA256"],
    "rootfs_path": os.environ["QVB_ROOTFS_PATH"],
    "rootfs_sha256": os.environ["QVB_ROOTFS_SHA256"],
    "transcript_path": os.environ["QVB_TRANSCRIPT_PATH"],
    "transcript_sha256": os.environ["QVB_TRANSCRIPT_SHA256"],
    "memory_mb": int(os.environ["QVB_MEMORY_MB"]),
    "cpus": int(os.environ["QVB_CPUS"]),
    "timeout_s": int(os.environ["QVB_TIMEOUT_S"]),
    "duration_s": int(os.environ["QVB_DURATION_S"]),
    "start_utc": os.environ["QVB_START_UTC"],
    "qemu_exit_code": int(os.environ["QVB_QEMU_RC"]),
    "boot_completed": os.environ["QVB_BOOT_COMPLETED"] == "true",
    "markers_found": json.loads(os.environ["QVB_MARKERS_FOUND_JSON"]),
    "markers_missing": json.loads(os.environ["QVB_MARKERS_MISSING_JSON"]),
    "forbidden_markers_found": json.loads(os.environ["QVB_FORBIDDEN_HIT_JSON"]),
    "provenance": "qemu_virt",
}
with open(os.environ["QVB_EVIDENCE_PATH"], "w", encoding="utf-8") as fh:
    json.dump(doc, fh, indent=2, sort_keys=True)
    fh.write("\n")
PYEOF

printf 'capture-buildroot-qemu-virt-smoke: transcript=%s\n' "${TRANSCRIPT_PATH}"
printf 'capture-buildroot-qemu-virt-smoke: evidence=%s\n' "${EVIDENCE_PATH}"
printf 'capture-buildroot-qemu-virt-smoke: boot_completed=%s duration_s=%s qemu_rc=%s\n' \
    "${BOOT_COMPLETED}" "${DURATION_S}" "${QEMU_RC}"

if [ "${BOOT_COMPLETED}" = "true" ]; then
    exit 0
fi
exit 1
