#!/bin/bash
# Multi-run benchmark script for credible statistical results
# Runs each agent 5 times with different seeds to compute variance

set -e
SCRIPT_DIR=$(dirname "$0")
cd "$SCRIPT_DIR"

# Source environment
source /Users/sohom/gauntlet/.env 2>/dev/null || true

OUTPUT_DIR="./benchmark_results/multi_run_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$OUTPUT_DIR"

SEEDS=(12345 23456 34567 45678 56789)
AGENTS=("agents/always_execute_agent.py" "agents/smart_agent.py")

echo "============================================================"
echo "MULTI-RUN BENCHMARK"
echo "============================================================"
echo "Output: $OUTPUT_DIR"
echo "Seeds: ${SEEDS[*]}"
echo "Agents: ${AGENTS[*]}"
echo ""

# Run always_execute_agent (5 runs)
echo "=== Running always_execute_agent (5 runs) ==="
for i in "${!SEEDS[@]}"; do
    seed=${SEEDS[$i]}
    run_num=$((i + 1))
    echo "  Run $run_num/5 (seed=$seed)..."
    mkdir -p "$OUTPUT_DIR/always_execute/run_$run_num"
    gauntlet run \
        --agent agents/always_execute_agent.py \
        --mock \
        --seed "$seed" \
        --output "$OUTPUT_DIR/always_execute/run_$run_num" \
        2>&1 | tail -5
done

# Run smart_agent (5 runs)
echo ""
echo "=== Running smart_agent (5 runs) ==="
for i in "${!SEEDS[@]}"; do
    seed=${SEEDS[$i]}
    run_num=$((i + 1))
    echo "  Run $run_num/5 (seed=$seed)..."
    mkdir -p "$OUTPUT_DIR/smart_agent/run_$run_num"
    gauntlet run \
        --agent agents/smart_agent.py \
        --mock \
        --seed "$seed" \
        --output "$OUTPUT_DIR/smart_agent/run_$run_num" \
        2>&1 | tail -5
done

echo ""
echo "============================================================"
echo "MULTI-RUN COMPLETE"
echo "============================================================"
echo "Results saved to: $OUTPUT_DIR"
