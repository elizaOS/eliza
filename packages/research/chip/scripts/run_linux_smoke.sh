#!/bin/sh
# run_linux_smoke.sh — fail-closed Linux boot smoke for the Eliza CPU AP.
#
# Goal: drive OpenSBI + Linux 6.x on the Chipyard-generated Rocket
# Verilator binary, with the firemarshal-built initramfs payload. Emit a
# JSON result and a transcript fragment hash to docs/evidence/cpu_ap/.
# Treat absence of any step in the build chain as a BLOCKED outcome,
# never a soft pass.
#
# Build-chain dependencies, in order of consumption:
#
#   - external/chipyard/                              (chipyard checkout)
#   - external/chipyard/generators/rocket-chip/       (rocket-chip submodule)
#   - external/oss-cad-suite/bin/verilator            (verilator binary)
#   - build/chipyard/eliza_rocket/simulator/simulator-chipyard.harness-ElizaRocketConfig
#                                                     (built Verilator sim)
#   - $E1_LINUX_PAYLOAD or br-base-bin                (OpenSBI + Linux + initramfs ELF)
#   - external/chipyard/generators/testchipip/src/main/resources/dramsim2_ini
#                                                     (DRAMSim2 ini dir)
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
TRACE_FILE="${EVIDENCE_DIR}/eliza_e1_linux_boot.trace.log"
mkdir -p "${RESULTS_DIR}" "${EVIDENCE_DIR}"

CONFIG_NAME="${E1_LINUX_DUT_CONFIG:-ElizaRocketConfig}"
DUT_KIND="${E1_LINUX_DUT_KIND:-rocket}"

# Make verilator available for any downstream tooling.
if [ -d "${ROOT}/external/oss-cad-suite/bin" ]; then
    PATH="${ROOT}/external/oss-cad-suite/bin:${PATH}"
    export PATH
fi

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

# Step 2: Verilator binary must be on PATH (oss-cad-suite or system install).
if ! command -v verilator >/dev/null 2>&1; then
    write_blocked \
        "verilator not on PATH" \
        "verilator (oss-cad-suite or system install)" \
        "export PATH=\$PWD/external/oss-cad-suite/bin:\$PATH"
fi

# Step 3: Generated Verilator simulator must exist. The staged path is
# build/chipyard/eliza_rocket/simulator/simulator-chipyard.harness-<CONFIG>.
SIMULATOR_DIR="${ROOT}/build/chipyard/eliza_rocket/simulator"
SIMULATOR_DEFAULT="${SIMULATOR_DIR}/simulator-chipyard.harness-${CONFIG_NAME}"
SIMULATOR="${E1_LINUX_SIMULATOR:-${SIMULATOR_DEFAULT}}"
if [ ! -x "${SIMULATOR}" ]; then
    # Fall back to the in-tree chipyard build directory.
    SIMULATOR_FALLBACK="${ROOT}/external/chipyard/sims/verilator/simulator-chipyard.harness-${CONFIG_NAME}"
    if [ -x "${SIMULATOR_FALLBACK}" ]; then
        SIMULATOR="${SIMULATOR_FALLBACK}"
    else
        write_blocked \
            "Chipyard-generated Verilator simulator absent" \
            "${SIMULATOR}" \
            "scripts/run_chipyard_eliza_verilator.sh && python3 scripts/check_chipyard_verilator_linux_smoke.py"
    fi
fi

# Step 4: Linux + initramfs payload. If E1_LINUX_PAYLOAD is unset,
# fall back to the firemarshal-located payload via the payload-locator
# JSON the Chipyard wiring already emits.
LINUX_PAYLOAD="${E1_LINUX_PAYLOAD:-}"
if [ -z "${LINUX_PAYLOAD}" ] && [ -f "${ROOT}/build/chipyard/eliza_rocket/chipyard-linux-payload.json" ]; then
    LINUX_PAYLOAD=$(python3 -c '
import json, sys
from pathlib import Path
data = json.loads(Path(sys.argv[1]).read_text())
sel = data.get("selected_payload", "")
if sel:
    p = Path(sys.argv[2]) / sel
    if p.is_file():
        print(p)
' "${ROOT}/build/chipyard/eliza_rocket/chipyard-linux-payload.json" "${ROOT}")
fi
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

# Step 5: DRAMSim2 ini directory required by Chipyard-built sim.
DRAMSIM_INI_DIR="${ROOT}/external/chipyard/generators/testchipip/src/main/resources/dramsim2_ini"
if [ ! -d "${DRAMSIM_INI_DIR}" ]; then
    write_blocked \
        "DRAMSim2 ini directory absent" \
        "${DRAMSIM_INI_DIR}" \
        "git -C external/chipyard submodule update --init --recursive generators/testchipip"
fi

# Step 6: Run the simulator. The chipyard-built binary emits UART on
# stdout and instruction trace on stderr. We capture them separately so
# the canonical transcript only contains UART output.
echo "[run_linux_smoke] simulator: ${SIMULATOR}"
echo "[run_linux_smoke] payload:   ${LINUX_PAYLOAD}"
echo "[run_linux_smoke] transcript: ${TRANSCRIPT_FILE}"

# Wall-clock cap (default 30 minutes; override with E1_LINUX_TIMEOUT_S).
# Cycle cap (default 200M cycles; sufficient for OpenSBI -> Linux init on
# Verilator-Rocket; override with E1_LINUX_MAX_CYCLES).
TIMEOUT_S="${E1_LINUX_TIMEOUT_S:-1800}"
MAX_CYCLES="${E1_LINUX_MAX_CYCLES:-200000000}"

SIM_CMD="${SIMULATOR} +permissive +dramsim +dramsim_ini_dir=${DRAMSIM_INI_DIR} +max-cycles=${MAX_CYCLES} +loadmem=${LINUX_PAYLOAD} +permissive-off ${LINUX_PAYLOAD}"
echo "[run_linux_smoke] command: ${SIM_CMD}"
echo "[run_linux_smoke] max_cycles: ${MAX_CYCLES} timeout_s: ${TIMEOUT_S}"

if command -v timeout >/dev/null 2>&1; then
    timeout "${TIMEOUT_S}" sh -c "stdbuf -o0 -e0 ${SIM_CMD} </dev/null > '${TRANSCRIPT_FILE}' 2> '${TRACE_FILE}'" || true
else
    sh -c "stdbuf -o0 -e0 ${SIM_CMD} </dev/null > '${TRANSCRIPT_FILE}' 2> '${TRACE_FILE}'" || true
fi

# Step 7: Verify markers.
REQUIRED_MARKERS="OpenSBI v Linux version Booting Linux on physical CPU 0x0 console: console-uart Run /init Welcome to"
missing=
for marker in ${REQUIRED_MARKERS}; do
    grep -F "${marker}" "${TRANSCRIPT_FILE}" > /dev/null 2>&1 || missing="${missing} ${marker}"
done

TRANSCRIPT_SHA=$(sha256sum "${TRANSCRIPT_FILE}" | awk '{print $1}')
TRANSCRIPT_BYTES=$(wc -c < "${TRANSCRIPT_FILE}")

if [ -n "${missing}" ]; then
    cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_linux_smoke_result.v1",
  "status": "fail",
  "reason": "missing markers in transcript:${missing}",
  "transcript": "build/evidence/cpu_ap/eliza_e1_linux_boot.log",
  "transcript_sha256": "${TRANSCRIPT_SHA}",
  "transcript_bytes": ${TRANSCRIPT_BYTES},
  "max_cycles": ${MAX_CYCLES},
  "timeout_s": ${TIMEOUT_S},
  "result_recorded_at": "$(date -u +%FT%TZ)",
  "config": "${CONFIG_NAME}",
  "dut_kind": "${DUT_KIND}"
}
EOF
    echo "STATUS: FAIL cpu.linux_smoke - missing markers:${missing}"
    echo "  transcript_sha256: ${TRANSCRIPT_SHA}"
    echo "  transcript_bytes:  ${TRANSCRIPT_BYTES}"
    exit 1
fi

cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_linux_smoke_result.v1",
  "status": "pass",
  "transcript": "build/evidence/cpu_ap/eliza_e1_linux_boot.log",
  "transcript_sha256": "${TRANSCRIPT_SHA}",
  "transcript_bytes": ${TRANSCRIPT_BYTES},
  "max_cycles": ${MAX_CYCLES},
  "timeout_s": ${TIMEOUT_S},
  "result_recorded_at": "$(date -u +%FT%TZ)",
  "config": "${CONFIG_NAME}",
  "dut_kind": "${DUT_KIND}"
}
EOF
echo "STATUS: PASS cpu.linux_smoke - OpenSBI + Linux markers found"
echo "  transcript_sha256: ${TRANSCRIPT_SHA}"
echo "  transcript_bytes:  ${TRANSCRIPT_BYTES}"
