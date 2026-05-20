#!/usr/bin/env bash
# Local AlphaChip pre-training driver.
#
# Runs one PPO iteration end-to-end against the vendored Ariane test fixtures
# using the local Python venv at external/circuit_training/.venv. This is the
# proof-of-life harness; it is **not** the full multi-day pre-training run.
#
# Topology (single host):
#   * Reverb replay buffer server on $REVERB_PORT.
#   * One ppo_collect worker bound to the Ariane netlist.
#   * One train_ppo trainer (CPU on this host; GPU on hosts where USE_GPU=1).
# The trainer drives `train.num_iterations=1` so the loop terminates after one
# policy update.
#
# Fails closed when plc_wrapper_main is unavailable. plc_wrapper_main is a
# closed-source Google binary (upstream issue google-research/circuit_training#11,
# maintainer esonghori: "the source code for the plc_wrapper_main binary
# includes lots of internal Google dependencies which make extremely hard to
# clean for open-sourcing."). We cannot build it from source. Drop a known-good
# binary at $PLC_WRAPPER_MAIN or at external/circuit_training/checkpoints/
# plc_wrapper_main before running this script.
#
# Evidence: emits build/reports/alphachip/pretraining-smoke.json with
# schema=eliza.alphachip.pretraining.v1 on every run (success, failure, or
# fail-closed-blocked).
set -u

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "${SCRIPT_DIR}/../.." && pwd)
CT_DIR="${CT_DIR:-${REPO_ROOT}/external/circuit_training}"
VENV_PY="${VENV_PY:-${CT_DIR}/.venv/bin/python}"
NETLIST_FILE="${NETLIST_FILE:-${CT_DIR}/circuit_training/environment/test_data/ariane/netlist.pb.txt}"
INIT_PLACEMENT="${INIT_PLACEMENT:-${CT_DIR}/circuit_training/environment/test_data/ariane/initial.plc}"
ROOT_DIR="${ROOT_DIR:-${REPO_ROOT}/build/alphachip/pretraining-smoke/run_00}"
REVERB_PORT="${REVERB_PORT:-8008}"
EVIDENCE_DIR="${EVIDENCE_DIR:-${REPO_ROOT}/build/reports/alphachip}"
EVIDENCE_FILE="${EVIDENCE_DIR}/pretraining-smoke.json"
SEQUENCE_LENGTH="${SEQUENCE_LENGTH:-134}"
EPISODES_PER_ITERATION="${EPISODES_PER_ITERATION:-4}"
PER_REPLICA_BATCH_SIZE="${PER_REPLICA_BATCH_SIZE:-4}"
GLOBAL_SEED="${GLOBAL_SEED:-111}"
STD_CELL_PLACER_MODE="${STD_CELL_PLACER_MODE:-fd}"
ITERATION_TIMEOUT_S="${ITERATION_TIMEOUT_S:-1800}"

mkdir -p -- "${EVIDENCE_DIR}" "${ROOT_DIR}"
NOW_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)

emit_evidence() {
    local status="$1" iterations="$2" detail="$3" plc_path="$4" plc_sha="$5"
    cat >"${EVIDENCE_FILE}" <<JSON
{
  "schema": "eliza.alphachip.pretraining.v1",
  "status": "${status}",
  "iterations_completed": ${iterations},
  "last_run_utc": "${NOW_UTC}",
  "plc_wrapper_main_path": ${plc_path},
  "plc_wrapper_sha256": ${plc_sha},
  "netlist_file": "${NETLIST_FILE}",
  "init_placement": "${INIT_PLACEMENT}",
  "root_dir": "${ROOT_DIR}",
  "python_venv": "${VENV_PY}",
  "reverb_port": ${REVERB_PORT},
  "sequence_length": ${SEQUENCE_LENGTH},
  "episodes_per_iteration": ${EPISODES_PER_ITERATION},
  "per_replica_batch_size": ${PER_REPLICA_BATCH_SIZE},
  "std_cell_placer_mode": "${STD_CELL_PLACER_MODE}",
  "host": "$(hostname)",
  "gpu_available": ${GPU_AVAILABLE:-false},
  "detail": ${detail}
}
JSON
}

json_str() {
    python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "${1-}"
}

resolve_plc_wrapper_main() {
    local candidates=()
    if [ -n "${PLC_WRAPPER_MAIN:-}" ]; then
        candidates+=("${PLC_WRAPPER_MAIN}")
    fi
    candidates+=(
        "${CT_DIR}/checkpoints/plc_wrapper_main"
        "/usr/local/bin/plc_wrapper_main"
    )
    for c in "${candidates[@]}"; do
        if [ -x "${c}" ]; then
            printf '%s\n' "${c}"
            return 0
        fi
    done
    return 1
}

# GPU probe (non-fatal; CPU is the documented fallback path).
GPU_AVAILABLE=false
if command -v nvidia-smi >/dev/null 2>&1; then
    if nvidia-smi -L >/dev/null 2>&1; then
        GPU_AVAILABLE=true
    fi
fi

if [ ! -x "${VENV_PY}" ]; then
    emit_evidence "blocked_python_venv" 0 "$(json_str "Python venv missing at ${VENV_PY}. Bootstrap with: cd external/circuit_training && uv venv --python 3.11 .venv && .venv/bin/python -m pip install 'tf-agents[reverb]~=0.19.0' tf-keras absl-py gin-config protobuf")" null null
    printf 'run_pretraining.sh: missing python venv at %s; see %s\n' "${VENV_PY}" "${EVIDENCE_FILE}" >&2
    exit 2
fi

if ! PLC_BIN=$(resolve_plc_wrapper_main); then
    emit_evidence "blocked_plc_wrapper_main" 0 "$(json_str "plc_wrapper_main not found at \$PLC_WRAPPER_MAIN, ${CT_DIR}/checkpoints/plc_wrapper_main, or /usr/local/bin/plc_wrapper_main. plc_wrapper_main is a closed-source Google binary (upstream google-research/circuit_training#11). The canonical GCS URL has returned HTTP 403 since Feb 2026. Recovery: obtain a pre-Feb-2026 copy and place it at \$PLC_WRAPPER_MAIN or external/circuit_training/checkpoints/plc_wrapper_main (chmod +x). See docs/toolchain/alphachip-checkpoint-blocker.md.")" null null
    printf 'run_pretraining.sh: plc_wrapper_main not found; see %s\n' "${EVIDENCE_FILE}" >&2
    exit 3
fi

PLC_SHA=$(sha256sum -- "${PLC_BIN}" | awk '{print $1}')

if [ ! -f "${NETLIST_FILE}" ] || [ ! -f "${INIT_PLACEMENT}" ]; then
    emit_evidence "blocked_ariane_fixtures" 0 "$(json_str "Ariane fixtures missing at ${NETLIST_FILE} / ${INIT_PLACEMENT}")" "$(json_str "${PLC_BIN}")" "$(json_str "${PLC_SHA}")"
    printf 'run_pretraining.sh: missing Ariane fixtures; see %s\n' "${EVIDENCE_FILE}" >&2
    exit 4
fi

export TF_USE_LEGACY_KERAS=1
export PYTHONPATH="${CT_DIR}${PYTHONPATH:+:${PYTHONPATH}}"

REVERB_LOG="${ROOT_DIR}/reverb.log"
COLLECT_LOG="${ROOT_DIR}/collect.log"
TRAIN_LOG="${ROOT_DIR}/train.log"
: >"${REVERB_LOG}"
: >"${COLLECT_LOG}"
: >"${TRAIN_LOG}"

# shellcheck disable=SC2329
cleanup() {
    if [ -n "${REVERB_PID:-}" ]; then kill "${REVERB_PID}" 2>/dev/null || true; fi
    if [ -n "${COLLECT_PID:-}" ]; then kill "${COLLECT_PID}" 2>/dev/null || true; fi
    if [ -n "${TRAIN_PID:-}" ]; then kill "${TRAIN_PID}" 2>/dev/null || true; fi
}
trap cleanup EXIT

# Reverb replay buffer.
"${VENV_PY}" -m circuit_training.learning.ppo_reverb_server \
    --root_dir="${ROOT_DIR}" \
    --port="${REVERB_PORT}" \
    --global_seed="${GLOBAL_SEED}" \
    >"${REVERB_LOG}" 2>&1 &
REVERB_PID=$!

# Wait for reverb to bind the port (max 60s).
REVERB_READY=false
for _ in $(seq 1 60); do
    if (echo > "/dev/tcp/127.0.0.1/${REVERB_PORT}") 2>/dev/null; then
        REVERB_READY=true
        break
    fi
    sleep 1
done
if [ "${REVERB_READY}" != true ]; then
    emit_evidence "failed_reverb_start" 0 "$(json_str "Reverb did not bind 127.0.0.1:${REVERB_PORT} within 60s; see ${REVERB_LOG}")" "$(json_str "${PLC_BIN}")" "$(json_str "${PLC_SHA}")"
    printf 'run_pretraining.sh: reverb did not start; see %s and %s\n' "${REVERB_LOG}" "${EVIDENCE_FILE}" >&2
    exit 5
fi

REVERB_SERVER="127.0.0.1:${REVERB_PORT}"

# Collect worker.
"${VENV_PY}" -m circuit_training.learning.ppo_collect \
    --root_dir="${ROOT_DIR}" \
    --replay_buffer_server_address="${REVERB_SERVER}" \
    --variable_container_server_address="${REVERB_SERVER}" \
    --task_id=0 \
    --netlist_file="${NETLIST_FILE}" \
    --init_placement="${INIT_PLACEMENT}" \
    --plc_wrapper_main="${PLC_BIN}" \
    --std_cell_placer_mode="${STD_CELL_PLACER_MODE}" \
    --global_seed="${GLOBAL_SEED}" \
    >"${COLLECT_LOG}" 2>&1 &
COLLECT_PID=$!

# Trainer — exactly one iteration.
TRAIN_GPU_FLAG=()
if [ "${GPU_AVAILABLE}" = true ]; then
    TRAIN_GPU_FLAG=(--use_gpu)
fi

timeout --preserve-status --signal=TERM "${ITERATION_TIMEOUT_S}" \
    "${VENV_PY}" -m circuit_training.learning.train_ppo \
        --root_dir="${ROOT_DIR}" \
        --replay_buffer_server_address="${REVERB_SERVER}" \
        --variable_container_server_address="${REVERB_SERVER}" \
        --netlist_file="${NETLIST_FILE}" \
        --init_placement="${INIT_PLACEMENT}" \
        --plc_wrapper_main="${PLC_BIN}" \
        --sequence_length="${SEQUENCE_LENGTH}" \
        --std_cell_placer_mode="${STD_CELL_PLACER_MODE}" \
        --global_seed="${GLOBAL_SEED}" \
        --gin_bindings="train.num_iterations=1" \
        --gin_bindings="train.num_episodes_per_iteration=${EPISODES_PER_ITERATION}" \
        --gin_bindings="train.per_replica_batch_size=${PER_REPLICA_BATCH_SIZE}" \
        "${TRAIN_GPU_FLAG[@]}" \
        >"${TRAIN_LOG}" 2>&1 &
TRAIN_PID=$!

set +e
wait "${TRAIN_PID}"
TRAIN_RC=$?
set -e

ITERATIONS_DONE=0
if grep -qE 'iteration: *1\b|num_iterations.*1.*completed|Iteration #1 finished' "${TRAIN_LOG}" 2>/dev/null; then
    ITERATIONS_DONE=1
fi
# tf-agents typically prints "Train iteration 1" when a step completes.
if [ "${ITERATIONS_DONE}" -eq 0 ] && grep -qE 'Train iteration [1-9]' "${TRAIN_LOG}" 2>/dev/null; then
    ITERATIONS_DONE=1
fi

if [ "${TRAIN_RC}" -eq 0 ] && [ "${ITERATIONS_DONE}" -ge 1 ]; then
    emit_evidence "ok" "${ITERATIONS_DONE}" "$(json_str "One PPO iteration completed against Ariane fixtures using the local plc_wrapper_main binary.")" "$(json_str "${PLC_BIN}")" "$(json_str "${PLC_SHA}")"
    printf '%s\n' "${ROOT_DIR}"
    exit 0
fi

emit_evidence "failed_train_iteration" "${ITERATIONS_DONE}" "$(json_str "trainer exit ${TRAIN_RC}; see ${TRAIN_LOG} (reverb=${REVERB_LOG}, collect=${COLLECT_LOG})")" "$(json_str "${PLC_BIN}")" "$(json_str "${PLC_SHA}")"
printf 'run_pretraining.sh: trainer failed (rc=%s); see %s and %s\n' "${TRAIN_RC}" "${TRAIN_LOG}" "${EVIDENCE_FILE}" >&2
exit 6
