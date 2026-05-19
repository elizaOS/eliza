#!/bin/sh
# run_linux_smoke.sh — fail-closed Linux boot smoke for the Eliza CPU AP.
#
# Goal: drive OpenSBI + U-Boot + Linux 6.x on the Chipyard-generated Rocket
# Verilator binary, with a minimal initramfs. Emit a JSON result and a
# transcript fragment hash to docs/evidence/cpu_ap/. Treat absence of any
# step in the build chain as a BLOCKED outcome, never a soft pass.
#
# Build-chain dependencies, in order of consumption:
#
#   - external/chipyard/                              (chipyard checkout)
#   - external/chipyard/generators/rocket-chip/       (rocket-chip submodule)
#   - external/riscv64-linux-gnu/bin/riscv64-linux-gnu-gcc
#                                                     (Linux toolchain)
#   - external/xpack-riscv-none-elf-gcc-15.2.0-1/...  (bare-metal toolchain
#                                                      for OpenSBI fw_payload)
#   - build/chipyard/eliza_rocket/simulator           (Chipyard verilator sim)
#   - $E1_LINUX_PAYLOAD                               (OpenSBI fw_payload.elf
#                                                      containing kernel +
#                                                      initramfs)
#
# Any missing item triggers a BLOCKED result with the exact path / command
# the operator needs. The downstream gate at
# docs/evidence/cpu_ap/linux-boot-evidence-gate.yaml treats BLOCKED as
# acceptable until the dev-board tapeout window opens.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RESULTS_DIR="${ROOT}/build/reports/linux_smoke"
EVIDENCE_DIR="${ROOT}/build/evidence/cpu_ap"
RESULT_JSON="${RESULTS_DIR}/result.json"
TRANSCRIPT_FILE="${EVIDENCE_DIR}/eliza_e1_linux_boot.log"
mkdir -p "${RESULTS_DIR}" "${EVIDENCE_DIR}"

CONFIG_NAME="${E1_LINUX_DUT_CONFIG:-ElizaRocketConfig}"
DUT_KIND="${E1_LINUX_DUT_KIND:-rocket}"

write_blocked() {
    reason=$1
    missing_dep=$2
    next_command=$3
    cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_linux_smoke_result.v1",
  "status": "blocked",
  "reason": "${reason}",
  "missing_dependency": "${missing_dep}",
  "next_command": "${next_command}",
  "result_recorded_at": "$(date -u +%FT%TZ)",
  "config": "${CONFIG_NAME}",
  "dut_kind": "${DUT_KIND}",
  "manifest": "generators/chipyard/eliza-rocket-manifest.json"
}
EOF
    echo "STATUS: BLOCKED cpu.linux_smoke - ${reason}"
    echo "  missing: ${missing_dep}"
    echo "  next:    ${next_command}"
    exit 0
}

# Step 1: Chipyard external checkout pinned via docs/generators/chipyard/.
if [ ! -d "${ROOT}/external/chipyard/generators/rocket-chip" ]; then
    write_blocked \
        "Chipyard external/rocket-chip checkout absent" \
        "external/chipyard/generators/rocket-chip" \
        "scripts/bootstrap_chipyard.sh"
fi

# Step 2: Generated Verilator simulator must exist; this is the boundary
# between repo-local scaffold and real hardware evidence.
SIMULATOR_DEFAULT="${ROOT}/build/chipyard/eliza_rocket/simulator"
SIMULATOR="${E1_LINUX_SIMULATOR:-${SIMULATOR_DEFAULT}}"
if [ ! -x "${SIMULATOR}" ]; then
    write_blocked \
        "Chipyard-generated Verilator simulator absent" \
        "${SIMULATOR}" \
        "scripts/run_chipyard_eliza_verilator.sh && python3 scripts/check_chipyard_verilator_linux_smoke.py"
fi

# Step 3: Linux + initramfs payload.
LINUX_PAYLOAD="${E1_LINUX_PAYLOAD:-}"
if [ -z "${LINUX_PAYLOAD}" ]; then
    write_blocked \
        "E1_LINUX_PAYLOAD not set" \
        "OpenSBI fw_payload.elf with Linux + initramfs" \
        "E1_LINUX_PAYLOAD=/path/to/fw_payload.elf make linux-smoke"
fi
if [ ! -f "${LINUX_PAYLOAD}" ]; then
    write_blocked \
        "E1_LINUX_PAYLOAD points to missing file" \
        "${LINUX_PAYLOAD}" \
        "rebuild OpenSBI + Linux + initramfs, then re-export E1_LINUX_PAYLOAD"
fi

# Step 4: OpenSBI handoff. The Chipyard runner already chains OpenSBI; we
# capture its serial log to ${TRANSCRIPT_FILE} and post-filter for the
# canonical Linux markers required by docs/evidence/cpu-ap-evidence-manifest.json.
echo "[run_linux_smoke] simulator: ${SIMULATOR}"
echo "[run_linux_smoke] payload:   ${LINUX_PAYLOAD}"
echo "[run_linux_smoke] transcript: ${TRANSCRIPT_FILE}"

# Run with a hard wall-clock cap so a stuck simulator does not block CI
# indefinitely; the cap is large enough for a full Linux boot.
TIMEOUT_S="${E1_LINUX_TIMEOUT_S:-900}"
if command -v timeout >/dev/null 2>&1; then
    timeout "${TIMEOUT_S}" "${SIMULATOR}" "${LINUX_PAYLOAD}" \
        2>&1 | tee "${TRANSCRIPT_FILE}" || true
else
    "${SIMULATOR}" "${LINUX_PAYLOAD}" 2>&1 | tee "${TRANSCRIPT_FILE}" || true
fi

# Step 5: Verify markers.
REQUIRED_MARKERS="OpenSBI v Linux version Booting Linux on physical CPU 0x0 console: console-uart Run /init Welcome to"
missing=
for marker in ${REQUIRED_MARKERS}; do
    grep -F "${marker}" "${TRANSCRIPT_FILE}" > /dev/null 2>&1 || missing="${missing} ${marker}"
done

if [ -n "${missing}" ]; then
    cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_linux_smoke_result.v1",
  "status": "fail",
  "reason": "missing markers in transcript:${missing}",
  "transcript": "build/evidence/cpu_ap/eliza_e1_linux_boot.log",
  "result_recorded_at": "$(date -u +%FT%TZ)",
  "config": "${CONFIG_NAME}",
  "dut_kind": "${DUT_KIND}"
}
EOF
    echo "STATUS: FAIL cpu.linux_smoke - missing markers:${missing}"
    exit 1
fi

cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_linux_smoke_result.v1",
  "status": "pass",
  "transcript": "build/evidence/cpu_ap/eliza_e1_linux_boot.log",
  "result_recorded_at": "$(date -u +%FT%TZ)",
  "config": "${CONFIG_NAME}",
  "dut_kind": "${DUT_KIND}"
}
EOF
echo "STATUS: PASS cpu.linux_smoke - OpenSBI + Linux markers found"
