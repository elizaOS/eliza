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
RUN_EVAL="${RUN_EVAL:-True}"
EVAL_OUTPUT_DIR="${EVAL_OUTPUT_DIR:-$ROOT_DIR/eval_output}"
GLOBAL_SEED="${GLOBAL_SEED:-111}"
OBS_MAX_NUM_NODES="${OBS_MAX_NUM_NODES:-}"
OBS_MAX_NUM_EDGES="${OBS_MAX_NUM_EDGES:-}"
OBS_MAX_GRID_SIZE="${OBS_MAX_GRID_SIZE:-}"
EXTRA_GIN_BINDINGS="${EXTRA_GIN_BINDINGS:-}"
POLICY_CHECKPOINT_DIR="${POLICY_CHECKPOINT_DIR:-}"
POLICY_SAVED_MODEL_DIR="${POLICY_SAVED_MODEL_DIR:-}"
CD_FINETUNE="${CD_FINETUNE:-False}"

mkdir -p "$SCRIPT_LOGS"
mkdir -p "$EVAL_OUTPUT_DIR"

REVERB_SERVER="${REVERB_SERVER_IP}:${REVERB_PORT}"
echo "Reverb server: $REVERB_SERVER"
echo "std_cell_placer_mode: $STD_CELL_PLACER_MODE"

GIN_FLAGS=()
add_gin_binding() {
  GIN_FLAGS+=(--gin_bindings="$1")
}

if [ -n "$OBS_MAX_NUM_NODES" ]; then
  echo "observation max_num_nodes: $OBS_MAX_NUM_NODES"
  add_gin_binding "ObservationConfig.max_num_nodes=${OBS_MAX_NUM_NODES}"
fi
if [ -n "$OBS_MAX_NUM_EDGES" ]; then
  echo "observation max_num_edges: $OBS_MAX_NUM_EDGES"
  add_gin_binding "ObservationConfig.max_num_edges=${OBS_MAX_NUM_EDGES}"
fi
if [ -n "$OBS_MAX_GRID_SIZE" ]; then
  echo "observation max_grid_size: $OBS_MAX_GRID_SIZE"
  add_gin_binding "ObservationConfig.max_grid_size=${OBS_MAX_GRID_SIZE}"
fi
if [ -n "$EXTRA_GIN_BINDINGS" ]; then
  while IFS= read -r binding; do
    [ -n "$binding" ] && add_gin_binding "$binding"
  done <<< "$EXTRA_GIN_BINDINGS"
fi

POLICY_FLAGS=()
if [ -n "$POLICY_CHECKPOINT_DIR" ]; then
  POLICY_FLAGS+=(--policy_checkpoint_dir="$POLICY_CHECKPOINT_DIR")
fi
if [ -n "$POLICY_SAVED_MODEL_DIR" ]; then
  POLICY_FLAGS+=(--policy_saved_model_dir="$POLICY_SAVED_MODEL_DIR")
fi

cleanup() {
  jobs -pr | xargs -r kill || true
}
trap cleanup EXIT INT TERM

CUDA_VISIBLE_DEVICES=-1 python3.9 -m circuit_training.learning.ppo_reverb_server \
  --root_dir="$ROOT_DIR" \
  --global_seed="$GLOBAL_SEED" \
  --port="$REVERB_PORT" \
  > "$SCRIPT_LOGS/reverb.log" 2>&1 &

for i in $(seq 1 "$NUM_COLLECT_JOBS"); do
  CUDA_VISIBLE_DEVICES=-1 python3.9 -m circuit_training.learning.ppo_collect \
    --root_dir="$ROOT_DIR" \
    --std_cell_placer_mode="$STD_CELL_PLACER_MODE" \
    --replay_buffer_server_address="$REVERB_SERVER" \
    --variable_container_server_address="$REVERB_SERVER" \
    --task_id="$i" \
    --max_sequence_length="$SEQUENCE_LENGTH" \
    --global_seed="$GLOBAL_SEED" \
    "${GIN_FLAGS[@]}" \
    --netlist_file="$NETLIST_FILE" \
    --init_placement="$INIT_PLACEMENT" \
    > "$SCRIPT_LOGS/collect_${i}.log" 2>&1 &
done

if [ "$RUN_EVAL" = "True" ] || [ "$RUN_EVAL" = "true" ] || [ "$RUN_EVAL" = "1" ]; then
  CUDA_VISIBLE_DEVICES=-1 python3.9 -m circuit_training.learning.eval \
    --root_dir="$ROOT_DIR" \
    --std_cell_placer_mode="$STD_CELL_PLACER_MODE" \
    --variable_container_server_address="$REVERB_SERVER" \
    --global_seed="$GLOBAL_SEED" \
    "${GIN_FLAGS[@]}" \
    --cd_finetune="$CD_FINETUNE" \
    --netlist_file="$NETLIST_FILE" \
    --init_placement="$INIT_PLACEMENT" \
    --output_placement_save_dir="$EVAL_OUTPUT_DIR" \
    > "$SCRIPT_LOGS/eval.log" 2>&1 &
fi

python3.9 -m circuit_training.learning.train_ppo \
  --root_dir="$ROOT_DIR" \
  --replay_buffer_server_address="$REVERB_SERVER" \
  --variable_container_server_address="$REVERB_SERVER" \
  --std_cell_placer_mode="$STD_CELL_PLACER_MODE" \
  --sequence_length="$SEQUENCE_LENGTH" \
  --global_seed="$GLOBAL_SEED" \
  "${GIN_FLAGS[@]}" \
  "${POLICY_FLAGS[@]}" \
  --gin_bindings="train.per_replica_batch_size=${PER_REPLICA_BATCH_SIZE}" \
  --gin_bindings="train.num_iterations=${TRAIN_ITERATIONS}" \
  --gin_bindings="train.num_episodes_per_iteration=${EPISODES_PER_ITERATION}" \
  --gin_bindings='train.num_epochs=4' \
  --netlist_file="$NETLIST_FILE" \
  --init_placement="$INIT_PLACEMENT" \
  --use_gpu="$USE_GPU"
