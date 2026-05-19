#!/bin/sh
# run_linux_smoke.sh — fail-closed Linux boot smoke for the Eliza CPU AP.
#
# Goal: drive OpenSBI + U-Boot + Linux 6.x on the Chipyard-generated Rocket
# Verilator binary, with a minimal initramfs. Emit a JSON result and a
# transcript fragment hash to docs/evidence/cpu_ap/. Treat absence of any
# step in the build chain as a BLOCKED outcome, never a soft pass.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RESULTS_DIR="${ROOT}/build/reports/linux_smoke"
EVIDENCE_DIR="${ROOT}/build/evidence/cpu_ap"
RESULT_JSON="${RESULTS_DIR}/result.json"
TRANSCRIPT_FILE="${EVIDENCE_DIR}/eliza_e1_linux_boot.log"
mkdir -p "${RESULTS_DIR}" "${EVIDENCE_DIR}"

write_blocked() {
    reason=$1
    cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_linux_smoke_result.v1",
  "status": "blocked",
  "reason": "${reason}",
  "result_recorded_at": "$(date -u +%FT%TZ)",
  "config": "ElizaRocketConfig",
  "manifest": "generators/chipyard/eliza-rocket-manifest.json"
}
EOF
    echo "STATUS: BLOCKED cpu.linux_smoke - ${reason}"
    exit 0
}

# Step 1: Chipyard external checkout pinned via docs/generators/chipyard/.
if [ ! -d "${ROOT}/external/chipyard/generators/rocket-chip" ]; then
    write_blocked "external/chipyard/generators/rocket-chip missing; run scripts/bootstrap_chipyard.sh first"
fi

# Step 2: Generated Verilator simulator must exist; this is the boundary
# between repo-local scaffold and real hardware evidence.
SIMULATOR="${ROOT}/build/chipyard/eliza_rocket/simulator"
if [ ! -x "${SIMULATOR}" ]; then
    write_blocked "build/chipyard/eliza_rocket/simulator absent; run scripts/run_chipyard_eliza_verilator.sh first"
fi

# Step 3: Linux + initramfs payload.
LINUX_PAYLOAD="${E1_LINUX_PAYLOAD:-}"
if [ -z "${LINUX_PAYLOAD}" ]; then
    write_blocked "E1_LINUX_PAYLOAD not set; point at a built Linux+initramfs ELF (typically OpenSBI fw_payload)"
fi
if [ ! -f "${LINUX_PAYLOAD}" ]; then
    write_blocked "E1_LINUX_PAYLOAD=${LINUX_PAYLOAD} not found"
fi

# Step 4: OpenSBI handoff. The Chipyard runner already chains OpenSBI; we
# capture its serial log to ${TRANSCRIPT_FILE} and post-filter for the
# canonical Linux markers required by docs/evidence/cpu-ap-evidence-manifest.json.
echo "[run_linux_smoke] running ${SIMULATOR} ${LINUX_PAYLOAD}"
"${SIMULATOR}" "${LINUX_PAYLOAD}" 2>&1 | tee "${TRANSCRIPT_FILE}" || true

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
  "reason": "missing markers in transcript: ${missing}",
  "transcript": "build/evidence/cpu_ap/eliza_e1_linux_boot.log",
  "result_recorded_at": "$(date -u +%FT%TZ)",
  "config": "ElizaRocketConfig"
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
  "config": "ElizaRocketConfig"
}
EOF
echo "STATUS: PASS cpu.linux_smoke - OpenSBI + Linux markers found"
