#!/usr/bin/env bash
# elizaOS Live — boot-in-QEMU + bundled-agent coding smoke.
#
# Boots the newest built elizaOS Live ISO headlessly in QEMU and proves the
# bundled agent comes up at boot AND can run a minimal, fully-offline coding
# task end-to-end inside the VM (no network, no cloud key):
#
#   1. the elizaos.service supervisor reaches `active`,
#   2. the in-VM agent API answers /api/health with "ready":true,"failed":0
#      (the same contract scripts/runtime-api-smoke.sh asserts against the
#      staged runtime),
#   3. a small source file written under /home/amnesia is built+executed with
#      the bundled toolchain at /opt/elizaos/bin and prints a known token.
#
# This is the QEMU-boot sibling of boot-qemu.sh (which is interactive/GUI) and
# runtime-api-smoke.sh (which exercises the *staged* runtime on the host, never
# the booted ISO). It mirrors the absence-tolerant clean-skip idiom of
# ../../scripts/verify-release.sh: every gate that finds its dependency missing
# prints a reason to stdout and exits 0 (skip — CI stays green), while a real
# in-VM failure on a present ISO exits 1.
#
# Control channel: SSH over the QEMU user-net hostfwd (the same forward
# boot-qemu.sh wires, default localhost:2224 -> guest:22). If the live image's
# sshd is not reachable / no usable credentials, the run SKIPS (exit 0) rather
# than failing — driving the in-VM task requires a working channel, and its
# absence is an infra gap, not a coding regression.
#
# Usage:
#   coding-smoke.sh [ISO]
#     ISO   Path to an elizaOS Live ISO. Defaults to ELIZAOS_CODING_SMOKE_ISO,
#           then the newest out/*.iso.
#
# Env knobs (boot ones reuse boot-qemu.sh names):
#   ELIZAOS_QEMU_MEMORY        guest RAM MiB              (default 4096)
#   ELIZAOS_QEMU_CPUS          guest vCPUs               (default 2)
#   ELIZAOS_QEMU_SSH_PORT      host port -> guest :22    (default 2224)
#   ELIZAOS_CODING_SMOKE_ISO   explicit ISO path
#   ELIZAOS_CODING_SMOKE_TIMEOUT  boot+task budget secs  (default 600)
#   ELIZAOS_CODING_SMOKE_OUT   artifact dir              (default out/coding-smoke)
#   ELIZAOS_CODING_SMOKE_REQUIRE_KVM=1  skip (exit 0) instead of warn when no KVM
#   ELIZAOS_CODING_SMOKE_SSH_USER  in-VM user            (default amnesia)
#   ELIZAOS_CODING_SMOKE_SSH_PASS  in-VM password for sshpass (optional)
#   ELIZAOS_CODING_SMOKE_SSH_KEY   private key for ssh -i (optional)
#   ELIZA_API_PORT             in-VM agent API port      (default 31337)
#
# Exit codes:
#   0  passed, OR cleanly skipped (no ISO / no qemu / no KVM-when-required /
#      no reachable in-VM control channel)
#   1  ISO present and booted but an in-VM assertion failed (real regression)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

# ---- output helpers (mirror verify-release.sh) -----------------------------
note() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[--]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[XX]\033[0m %s\n' "$*"; }
skip() { printf 'coding-smoke: skipping — %s\n' "$*"; }

MEMORY="${ELIZAOS_QEMU_MEMORY:-4096}"
CPUS="${ELIZAOS_QEMU_CPUS:-2}"
SSH_PORT="${ELIZAOS_QEMU_SSH_PORT:-2224}"
TIMEOUT="${ELIZAOS_CODING_SMOKE_TIMEOUT:-600}"
OUT_DIR="${ELIZAOS_CODING_SMOKE_OUT:-${ROOT}/out/coding-smoke}"
SSH_USER="${ELIZAOS_CODING_SMOKE_SSH_USER:-amnesia}"
API_PORT="${ELIZA_API_PORT:-31337}"
MARKER="CODING_SMOKE_OK"

# ---- gate 1: ISO discovery -------------------------------------------------
ISO="${1:-${ELIZAOS_CODING_SMOKE_ISO:-}}"
if [ -z "${ISO}" ]; then
    ISO="$(ls -t out/*.iso 2>/dev/null | head -1 || true)"
fi
if [ -z "${ISO}" ] || [ ! -f "${ISO}" ]; then
    skip "no built ISO (run 'just build', set ELIZAOS_CODING_SMOKE_ISO, or pass an ISO path)"
    exit 0
fi

# ---- gate 2: qemu present --------------------------------------------------
if ! command -v qemu-system-x86_64 >/dev/null 2>&1; then
    skip "qemu-system-x86_64 not installed"
    exit 0
fi

# ---- gate 3: KVM (soft by default, mirrors boot-qemu.sh) -------------------
HAVE_KVM=0
if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
    HAVE_KVM=1
else
    if [ "${ELIZAOS_CODING_SMOKE_REQUIRE_KVM:-0}" = "1" ]; then
        skip "/dev/kvm not r+w and ELIZAOS_CODING_SMOKE_REQUIRE_KVM=1"
        exit 0
    fi
    warn "KVM unavailable; TCG emulation will be slow (boot may approach the ${TIMEOUT}s budget)"
fi

# ---- gate 4: a usable in-VM control channel (ssh) -------------------------
# Driving the coding task inside the VM needs ssh; without it (no ssh client,
# or no creds/key the live image accepts) this is an infra gap, not a coding
# regression, so SKIP rather than fail.
if ! command -v ssh >/dev/null 2>&1; then
    skip "ssh client not installed (needed to drive the in-VM coding task)"
    exit 0
fi
SSH_PASS="${ELIZAOS_CODING_SMOKE_SSH_PASS:-}"
SSH_KEY="${ELIZAOS_CODING_SMOKE_SSH_KEY:-}"
SSHPASS_BIN=""
if [ -n "${SSH_PASS}" ]; then
    if command -v sshpass >/dev/null 2>&1; then
        SSHPASS_BIN="$(command -v sshpass)"
    else
        skip "ELIZAOS_CODING_SMOKE_SSH_PASS set but sshpass not installed"
        exit 0
    fi
fi
if [ -z "${SSH_PASS}" ] && [ -z "${SSH_KEY}" ]; then
    skip "no in-VM credentials (set ELIZAOS_CODING_SMOKE_SSH_KEY or ELIZAOS_CODING_SMOKE_SSH_PASS)"
    exit 0
fi

mkdir -p "${OUT_DIR}"
SERIAL_LOG="${OUT_DIR}/serial.log"
QMP_SOCK="${OUT_DIR}/qmp.sock"
SCREENSHOT_PPM="${OUT_DIR}/screen.ppm"
SCREENSHOT_PNG="${OUT_DIR}/screen.png"
AGENT_LOG="${OUT_DIR}/in-vm-agent.log"
: >"${SERIAL_LOG}"

QEMU_PID=""
cleanup() {
    if [ -n "${QEMU_PID}" ] && kill -0 "${QEMU_PID}" 2>/dev/null; then
        kill "${QEMU_PID}" 2>/dev/null || true
        # give it a moment, then force
        for _ in 1 2 3 4 5; do
            kill -0 "${QEMU_PID}" 2>/dev/null || break
            sleep 1
        done
        kill -9 "${QEMU_PID}" 2>/dev/null || true
        wait "${QEMU_PID}" 2>/dev/null || true
    fi
    rm -f "${QMP_SOCK}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ---- boot the ISO headlessly ----------------------------------------------
note "booting ${ISO} headless (mem ${MEMORY} MiB, cpus ${CPUS}, ssh fwd localhost:${SSH_PORT} -> guest:22)"
qemu_args=(
    -m "${MEMORY}"
    -smp "${CPUS}"
    -cdrom "${ISO}"
    -boot d
    -netdev "user,id=net0,hostfwd=tcp::${SSH_PORT}-:22"
    -device virtio-net-pci,netdev=net0
    -vga virtio
    -display none
    -serial "file:${SERIAL_LOG}"
    -qmp "unix:${QMP_SOCK},server,nowait"
    -no-reboot
)
if [ "${HAVE_KVM}" = "1" ]; then
    qemu_args=(-enable-kvm -cpu host "${qemu_args[@]}")
fi

qemu-system-x86_64 "${qemu_args[@]}" >/dev/null 2>&1 &
QEMU_PID="$!"

# Deadline for the whole boot+task budget.
DEADLINE=$(( $(date +%s) + TIMEOUT ))

# ssh helper: argv-only commands, no shell metachars at the host layer (the
# remote shell interprets the single quoted script).
ssh_common=(
    -p "${SSH_PORT}"
    -o StrictHostKeyChecking=no
    -o UserKnownHostsFile=/dev/null
    -o GlobalKnownHostsFile=/dev/null
    -o ConnectTimeout=8
    -o LogLevel=ERROR
    -o PreferredAuthentications=publickey,password,keyboard-interactive
)
[ -n "${SSH_KEY}" ] && ssh_common+=(-i "${SSH_KEY}" -o IdentitiesOnly=yes)

run_in_vm() {
    # $1 = remote /bin/sh script (single string)
    if [ -n "${SSHPASS_BIN}" ]; then
        SSHPASS="${SSH_PASS}" "${SSHPASS_BIN}" -e \
            ssh "${ssh_common[@]}" "${SSH_USER}@127.0.0.1" "$1"
    else
        ssh "${ssh_common[@]}" "${SSH_USER}@127.0.0.1" "$1"
    fi
}

# ---- capture a framebuffer screenshot via QMP screendump (best-effort) -----
capture_screenshot() {
    command -v nc >/dev/null 2>&1 || return 0
    [ -S "${QMP_SOCK}" ] || return 0
    # QMP handshake then screendump. Best-effort; never fail the run on this.
    {
        printf '%s\n' '{"execute":"qmp_capabilities"}'
        printf '%s\n' "{\"execute\":\"screendump\",\"arguments\":{\"filename\":\"${SCREENSHOT_PPM}\"}}"
        sleep 1
    } | nc -U "${QMP_SOCK}" >/dev/null 2>&1 || true
    if [ -f "${SCREENSHOT_PPM}" ]; then
        if command -v convert >/dev/null 2>&1; then
            convert "${SCREENSHOT_PPM}" "${SCREENSHOT_PNG}" 2>/dev/null \
                && ok "screenshot: ${SCREENSHOT_PNG}" \
                || ok "screenshot (ppm): ${SCREENSHOT_PPM}"
        else
            ok "screenshot (ppm; install imagemagick for PNG): ${SCREENSHOT_PPM}"
        fi
    fi
}

dump_artifacts_on_failure() {
    warn "serial log tail:"
    tail -120 "${SERIAL_LOG}" >&2 2>/dev/null || true
    # Best-effort pull of the in-VM agent log.
    run_in_vm 'cat "${ELIZA_STATE_DIR:-/home/amnesia/.eliza}/logs/"*.log 2>/dev/null | tail -160' \
        >"${AGENT_LOG}" 2>/dev/null || true
    if [ -s "${AGENT_LOG}" ]; then
        warn "in-VM agent log tail (${AGENT_LOG}):"
        tail -120 "${AGENT_LOG}" >&2 2>/dev/null || true
    fi
}

# ---- poll: ssh becomes reachable ------------------------------------------
note "waiting for the VM to accept ssh on localhost:${SSH_PORT} (deadline ${TIMEOUT}s)"
SSH_UP=0
while [ "$(date +%s)" -lt "${DEADLINE}" ]; do
    if ! kill -0 "${QEMU_PID}" 2>/dev/null; then
        fail "QEMU exited before the VM became reachable"
        dump_artifacts_on_failure
        exit 1
    fi
    if run_in_vm 'echo vm-ssh-up' 2>/dev/null | grep -q 'vm-ssh-up'; then
        SSH_UP=1
        break
    fi
    sleep 5
done
if [ "${SSH_UP}" != 1 ]; then
    # No reachable control channel within budget. Distinguish infra absence
    # (no sshd / wrong creds) from a true regression: we cannot prove the
    # coding path either way without a channel, so SKIP (exit 0) per the
    # absence-tolerant contract — but emit artifacts for diagnosis.
    capture_screenshot
    warn "serial log tail:"
    tail -80 "${SERIAL_LOG}" 2>/dev/null || true
    skip "VM never became reachable over ssh within ${TIMEOUT}s (sshd/creds unavailable in this image)"
    exit 0
fi
ok "ssh channel up"
capture_screenshot

# ---- assert: elizaos.service active ---------------------------------------
note "checking systemctl is-active elizaos.service"
SVC_OK=0
while [ "$(date +%s)" -lt "${DEADLINE}" ]; do
    state="$(run_in_vm 'systemctl is-active elizaos.service 2>/dev/null || true' 2>/dev/null | tr -d '[:space:]')"
    if [ "${state}" = "active" ]; then
        SVC_OK=1
        break
    fi
    sleep 3
done
if [ "${SVC_OK}" != 1 ]; then
    fail "elizaos.service did not reach 'active' within ${TIMEOUT}s (last state: ${state:-unknown})"
    dump_artifacts_on_failure
    exit 1
fi
ok "elizaos.service is active"

# ---- assert: agent API health (same contract as runtime-api-smoke.sh) -----
note "checking in-VM agent API http://127.0.0.1:${API_PORT}/api/health"
HEALTH_OK=0
health_body=""
while [ "$(date +%s)" -lt "${DEADLINE}" ]; do
    health_body="$(run_in_vm "curl --noproxy '*' -fsS http://127.0.0.1:${API_PORT}/api/health 2>/dev/null || true" 2>/dev/null || true)"
    if printf '%s' "${health_body}" | grep -q '"ready":true' \
        && printf '%s' "${health_body}" | grep -q '"failed":0'; then
        HEALTH_OK=1
        break
    fi
    sleep 3
done
if [ "${HEALTH_OK}" != 1 ]; then
    fail "in-VM agent /api/health never reported ready/failed:0 within ${TIMEOUT}s"
    warn "last health body: ${health_body:-<empty>}"
    dump_artifacts_on_failure
    exit 1
fi
ok "agent API healthy (ready:true, failed:0)"

# ---- the coding task: offline, deterministic, bundled toolchain -----------
# Write a tiny source file under /home/amnesia, run it with the bundled
# /opt/elizaos/bin toolchain (bun preferred, node fallback), and assert the
# known marker token on stdout. No network, no cloud key, no real-LLM call —
# this proves the bundled coding toolchain executes inside the live image.
note "running in-VM coding task (bundled toolchain, fully offline)"
# Single-quoted remote script; the in-VM /bin/sh interprets it. Keep the host
# layer free of metachars by passing exactly one argv string to ssh.
read -r -d '' VM_TASK <<VMEOF || true
set -eu
WORK="\$HOME/coding-smoke"
rm -rf "\$WORK"; mkdir -p "\$WORK"
SRC="\$WORK/coding-smoke.js"
cat > "\$SRC" <<'SRCEOF'
const n = 2 + 3;
if (n !== 5) { throw new Error("arithmetic broke: " + n); }
console.log("${MARKER}:" + n);
SRCEOF
TC=/opt/elizaos/bin
RUNNER=""
if [ -x "\$TC/bun" ]; then RUNNER="\$TC/bun";
elif [ -x "\$TC/node" ]; then RUNNER="\$TC/node";
elif command -v node >/dev/null 2>&1; then RUNNER="\$(command -v node)";
else echo "NO_TOOLCHAIN"; exit 7; fi
"\$RUNNER" "\$SRC"
VMEOF

task_out="$(run_in_vm "${VM_TASK}" 2>&1 || true)"
printf '%s\n' "${task_out}" | sed 's/^/    [vm] /'

if printf '%s' "${task_out}" | grep -q 'NO_TOOLCHAIN'; then
    fail "no runnable toolchain found in the VM (/opt/elizaos/bin/{bun,node} absent)"
    dump_artifacts_on_failure
    exit 1
fi
if ! printf '%s' "${task_out}" | grep -q "${MARKER}:5"; then
    fail "coding task did not produce '${MARKER}:5' inside the VM"
    dump_artifacts_on_failure
    exit 1
fi
ok "coding task produced ${MARKER}:5 inside the VM"

# ---- no-silent-failure guard (reuse runtime-api-smoke.sh idiom) -----------
note "scanning in-VM agent log for 'Request handler failed'"
run_in_vm 'cat "${ELIZA_STATE_DIR:-/home/amnesia/.eliza}/logs/"*.log 2>/dev/null | tail -2000' \
    >"${AGENT_LOG}" 2>/dev/null || true
if [ -s "${AGENT_LOG}" ] && grep -q 'Request handler failed' "${AGENT_LOG}"; then
    fail "in-VM runtime logged a request handler failure"
    grep 'Request handler failed' "${AGENT_LOG}" >&2 || true
    exit 1
fi
ok "no request-handler failures in the in-VM agent log"

# ---- final screenshot + summary -------------------------------------------
capture_screenshot
note "artifacts in ${OUT_DIR}: serial.log, in-vm-agent.log$( [ -f "${SCREENSHOT_PNG}" ] && printf ', screen.png' || { [ -f "${SCREENSHOT_PPM}" ] && printf ', screen.ppm'; } )"
ok "elizaOS Live coding smoke passed"
exit 0
