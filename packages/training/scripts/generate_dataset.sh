#!/bin/bash
#
# Generate Large Training Dataset
#
# Runs multiple parallel workers to generate trajectory data using the
# TypeScript simulation engine. Each worker uses a different seed for variety.
#
# Usage:
#   ./scripts/generate_dataset.sh [HOURS] [PARALLEL_WORKERS] [NPCS_PER_WORKER] [OUTPUT_DIR]
#
# Examples:
#   ./scripts/generate_dataset.sh                    # Default: 24h, 4 workers, 20 NPCs
#   ./scripts/generate_dataset.sh 48 8 30           # 48 hours, 8 workers, 30 NPCs
#   ./scripts/generate_dataset.sh 24 4 20 ./data    # Custom output directory
#
# Requirements:
#   - bun installed
#   - GROQ_API_KEY or OPENAI_API_KEY set
#   - generate-training-data.ts script available
#

set -e

# Configuration
HOURS=${1:-24}
PARALLEL=${2:-4}
NPCS=${3:-20}
OUTPUT_DIR=${4:-"./training-data-output"}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="$(dirname "$SCRIPT_DIR")/../engine"

# Ensure we're in the right directory
cd "$(dirname "$SCRIPT_DIR")"

echo "=============================================="
echo "Babylon Training Data Generator"
echo "=============================================="
echo ""
echo "Configuration:"
echo "  Hours per worker:     $HOURS"
echo "  Parallel workers:     $PARALLEL"
echo "  NPCs per worker:      $NPCS"
echo "  Output directory:     $OUTPUT_DIR"
echo "  Engine directory:     $ENGINE_DIR"
echo ""

# Check for required API keys
if [ -z "$GROQ_API_KEY" ] && [ -z "$OPENAI_API_KEY" ]; then
    echo "ERROR: Neither GROQ_API_KEY nor OPENAI_API_KEY is set"
    echo "Please set one of these environment variables"
    exit 1
fi

# Check for bun
if ! command -v bun &> /dev/null; then
    echo "ERROR: bun is not installed"
    echo "Install with: curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

# Check for TypeScript script
SCRIPT_PATH="$ENGINE_DIR/examples/generate-training-data.ts"
if [ ! -f "$SCRIPT_PATH" ]; then
    echo "ERROR: generate-training-data.ts not found at $SCRIPT_PATH"
    exit 1
fi

# Create output directories
mkdir -p "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/logs"

echo "Starting $PARALLEL parallel workers..."
echo ""

# Track PIDs for cleanup
PIDS=()

# Cleanup function
cleanup() {
    echo ""
    echo "Cleaning up..."
    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
        fi
    done
    exit 0
}

trap cleanup SIGINT SIGTERM

# Start workers
BASE_SEED=$(date +%s)
for i in $(seq 1 "$PARALLEL"); do
    SEED=$((BASE_SEED + i * 1000))
    WORKER_OUTPUT="$OUTPUT_DIR/batch_$i"
    LOG_FILE="$OUTPUT_DIR/logs/worker_$i.log"
    
    mkdir -p "$WORKER_OUTPUT"
    
    echo "Starting worker $i (seed: $SEED, output: $WORKER_OUTPUT)"
    
    # Run in background, redirect output to log file
    (
        cd "$ENGINE_DIR" && \
        bun run examples/generate-training-data.ts \
            --causal \
            --hours "$HOURS" \
            --npcs "$NPCS" \
            --seed "$SEED" \
            --output "$WORKER_OUTPUT" \
            2>&1
    ) > "$LOG_FILE" 2>&1 &
    
    PIDS+=($!)
done

echo ""
echo "All workers started. PIDs: ${PIDS[*]}"
echo "Logs available in: $OUTPUT_DIR/logs/"
echo ""
echo "Waiting for workers to complete..."
echo "(Press Ctrl+C to cancel)"
echo ""

# Wait for all workers to complete
FAILED=0
for i in "${!PIDS[@]}"; do
    pid=${PIDS[$i]}
    worker_num=$((i + 1))
    
    if wait "$pid"; then
        echo "✓ Worker $worker_num completed successfully"
    else
        echo "✗ Worker $worker_num failed (see logs/worker_$worker_num.log)"
        FAILED=$((FAILED + 1))
    fi
done

echo ""
echo "=============================================="
echo "Generation Complete"
echo "=============================================="

# Count trajectories
TOTAL_TRAJECTORIES=0
for i in $(seq 1 "$PARALLEL"); do
    WORKER_OUTPUT="$OUTPUT_DIR/batch_$i/trajectories"
    if [ -d "$WORKER_OUTPUT" ]; then
        COUNT=$(find "$WORKER_OUTPUT" -name "*.json" 2>/dev/null | wc -l)
        echo "  Worker $i: $COUNT trajectories"
        TOTAL_TRAJECTORIES=$((TOTAL_TRAJECTORIES + COUNT))
    fi
done

echo ""
echo "Total trajectories: $TOTAL_TRAJECTORIES"
echo "Output directory:   $OUTPUT_DIR"
echo "Failed workers:     $FAILED"
echo ""

if [ "$FAILED" -gt 0 ]; then
    echo "Some workers failed. Check logs for details."
    exit 1
fi

echo "Next steps:"
echo "  1. Merge trajectories:   python scripts/merge_trajectories.py $OUTPUT_DIR"
echo "  2. Validate data:        python scripts/import_json_trajectories.py --dry-run"
echo "  3. Import to database:   python scripts/import_json_trajectories.py"
echo ""


