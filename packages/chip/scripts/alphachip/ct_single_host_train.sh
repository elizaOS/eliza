#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/e1-alphachip/run_00}"
SCRIPT_LOGS="${SCRIPT_LOGS:-$ROOT_DIR}"
REVERB_PORT="${REVERB_PORT:-8008}"
REVERB_SERVER_IP="${REVERB_SERVER_IP:-127.0.0.1}"
NETLIST_FILE="${NETLIST_FILE:-./circuit_training/environment/test_data/toy_macro_stdcell/netlist.pb.txt}"
INIT_PLACEMENT="${INIT_PLACEMENT:-./circuit_training/environment/test_data/toy_macro_stdcell/initial.plc}"
NUM_COLLECT_JOBS="${NUM_COLLECT_JOBS:-4}"
USE_GPU="${USE_GPU:-False}"
STD_CELL_PLACER_MODE="${STD_CELL_PLACER_MODE:-fd}"
SEQUENCE_LENGTH="${SEQUENCE_LENGTH:-3}"
TRAIN_ITERATIONS="${TRAIN_ITERATIONS:-1}"
EPISODES_PER_ITERATION="${EPISODES_PER_ITERATION:-5}"
PER_REPLICA_BATCH_SIZE="${PER_REPLICA_BATCH_SIZE:-5}"

mkdir -p "$SCRIPT_LOGS"

REVERB_SERVER="${REVERB_SERVER_IP}:${REVERB_PORT}"
echo "Reverb server: $REVERB_SERVER"
echo "std_cell_placer_mode: $STD_CELL_PLACER_MODE"

cleanup() {
  jobs -pr | xargs -r kill || true
}
trap cleanup EXIT INT TERM

CUDA_VISIBLE_DEVICES=-1 python3.9 -m circuit_training.learning.ppo_reverb_server \
  --root_dir="$ROOT_DIR" \
  --port="$REVERB_PORT" \
  > "$SCRIPT_LOGS/reverb.log" 2>&1 &

for i in $(seq 1 "$NUM_COLLECT_JOBS"); do
  CUDA_VISIBLE_DEVICES=-1 python3.9 -m circuit_training.learning.ppo_collect \
    --root_dir="$ROOT_DIR" \
    --std_cell_placer_mode="$STD_CELL_PLACER_MODE" \
    --replay_buffer_server_address="$REVERB_SERVER" \
    --variable_container_server_address="$REVERB_SERVER" \
    --task_id="$i" \
    --netlist_file="$NETLIST_FILE" \
    --init_placement="$INIT_PLACEMENT" \
    > "$SCRIPT_LOGS/collect_${i}.log" 2>&1 &
done

python3.9 -m circuit_training.learning.train_ppo \
  --root_dir="$ROOT_DIR" \
  --replay_buffer_server_address="$REVERB_SERVER" \
  --variable_container_server_address="$REVERB_SERVER" \
  --std_cell_placer_mode="$STD_CELL_PLACER_MODE" \
  --sequence_length="$SEQUENCE_LENGTH" \
  --gin_bindings="train.per_replica_batch_size=${PER_REPLICA_BATCH_SIZE}" \
  --gin_bindings="train.num_iterations=${TRAIN_ITERATIONS}" \
  --gin_bindings="train.num_episodes_per_iteration=${EPISODES_PER_ITERATION}" \
  --gin_bindings='train.num_epochs=4' \
  --netlist_file="$NETLIST_FILE" \
  --init_placement="$INIT_PLACEMENT" \
  --use_gpu="$USE_GPU"
