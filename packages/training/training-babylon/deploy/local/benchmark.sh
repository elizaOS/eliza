#!/bin/bash
# Babylon Training - Local Benchmark Run
#
# Quick script to run benchmarks locally with Docker.
#
# Usage:
#   ./benchmark.sh                          # Benchmark final model (quick mode)
#   ./benchmark.sh --model step_500         # Benchmark specific checkpoint
#   ./benchmark.sh --scenario bear-market   # Run specific scenario
#   ./benchmark.sh --interactive            # Start bash shell
#
# Prerequisites:
#   - Docker with NVIDIA Container Toolkit
#   - Built benchmark image (or pull from registry)
#   - Trained model in trained_models/ directory

set -e

# ============================================================================
# Configuration
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
TRAINING_DIR="$(dirname "$DEPLOY_DIR")"

# Defaults
IMAGE="${BABYLON_BENCHMARK_IMAGE:-revlentless/babylon-benchmark:latest}"
MODEL=""
HF_MODEL=""
BASE_MODEL="${BASE_MODEL:-Qwen/Qwen2.5-0.5B-Instruct}"
MODE="quick"
SCENARIO=""
OUTPUT_DIR="$TRAINING_DIR/benchmark-results"
INTERACTIVE=false
EXTRA_ARGS=()

# ============================================================================
# Parse Arguments
# ============================================================================

while [[ $# -gt 0 ]]; do
    case $1 in
        --image)
            IMAGE="$2"
            shift 2
            ;;
        --model|-m)
            MODEL="$2"
            shift 2
            ;;
        --hf-model)
            HF_MODEL="$2"
            shift 2
            ;;
        --scenario|-s)
            SCENARIO="$2"
            shift 2
            ;;
        --quick)
            MODE="quick"
            shift
            ;;
        --full)
            MODE="full"
            shift
            ;;
        --output|-o)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --base-model|-b)
            BASE_MODEL="$2"
            shift 2
            ;;
        --interactive|-i)
            INTERACTIVE=true
            shift
            ;;
        --help|-h)
            echo "Babylon Benchmark - Local Docker Run"
            echo ""
            echo "Usage: ./benchmark.sh [options]"
            echo ""
            echo "Options:"
            echo "  --image <image>      Docker image (default: $IMAGE)"
            echo "  --model <name>       Model name in trained_models/"
            echo "  --hf-model <id>      HuggingFace model ID (e.g., elizaos/ishtar-v0.1)"
            echo "  --base-model, -b     Base model for LoRA (default: $BASE_MODEL)"
            echo "  --scenario <id>      Specific scenario (bull-market, bear-market, etc.)"
            echo "  --quick              Quick mode - 7-day scenarios (default)"
            echo "  --full               Full mode - 22-day scenarios"
            echo "  --output <dir>       Output directory (default: $OUTPUT_DIR)"
            echo "  --interactive, -i    Start interactive bash shell"
            echo "  --help, -h           Show this help"
            echo ""
            echo "Available scenarios:"
            echo "  bull-market, bear-market, scandal-unfolds, pump-and-dump"
            echo ""
            echo "Examples:"
            echo "  ./benchmark.sh --model final_model                     # Benchmark local model"
            echo "  ./benchmark.sh --hf-model elizaos/ishtar-v0.1          # Benchmark HF model"
            echo "  ./benchmark.sh --model step_500 --quick                # Benchmark checkpoint"
            echo "  ./benchmark.sh --scenario bear-market                  # Single scenario"
            echo "  ./benchmark.sh -b Qwen/Qwen2.5-0.5B-Instruct           # Use specific base model"
            exit 0
            ;;
        *)
            EXTRA_ARGS+=("$1")
            shift
            ;;
    esac
done

# ============================================================================
# Validate
# ============================================================================

# Must specify either --model or --hf-model
if [[ -z "$MODEL" && -z "$HF_MODEL" ]]; then
    echo "❌ Must specify either --model or --hf-model"
    echo ""
    echo "Examples:"
    echo "  ./benchmark.sh --model final_model"
    echo "  ./benchmark.sh --hf-model elizaos/ishtar-v0.1"
    exit 1
fi

# If local model, verify it exists
if [[ -n "$MODEL" ]]; then
    MODEL_PATH="$TRAINING_DIR/trained_models/$MODEL"
    if [[ ! -d "$MODEL_PATH" ]]; then
        echo "❌ Model not found: $MODEL_PATH"
        echo ""
        echo "Available models:"
        ls -la "$TRAINING_DIR/trained_models/" 2>/dev/null || echo "  No trained models found"
        exit 1
    fi
fi

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker not found. Please install Docker."
    exit 1
fi

# Create output directory
mkdir -p "$OUTPUT_DIR"

# ============================================================================
# Run
# ============================================================================

echo "============================================"
echo "  Babylon Benchmark - Local"
echo "============================================"
echo ""
echo "Image:      $IMAGE"
if [[ -n "$MODEL" ]]; then
    echo "Model:      $MODEL (local)"
else
    echo "HF Model:   $HF_MODEL"
fi
echo "Base Model: $BASE_MODEL"
echo "Mode:       $MODE"
echo "Scenario:   ${SCENARIO:-all}"
echo "Output:     $OUTPUT_DIR"
echo ""

# Build docker run command
DOCKER_CMD=(
    docker run
    --gpus all
    --network host
    -v "$TRAINING_DIR/data/benchmarks/scenarios:/app/packages/training/data/benchmarks/scenarios:ro"
    -v "$OUTPUT_DIR:/benchmark-results"
    -e BASE_MODEL="$BASE_MODEL"
    -e BENCHMARK_OUTPUT_DIR="/benchmark-results"
)

# Add model source (local or HF)
if [[ -n "$MODEL" ]]; then
    DOCKER_CMD+=(-v "$TRAINING_DIR/trained_models:/models:ro")
    DOCKER_CMD+=(-e MODEL_PATH="/models/$MODEL")
else
    DOCKER_CMD+=(-e HF_MODEL="$HF_MODEL")
    # Pass HF_TOKEN for private models
    if [[ -n "$HF_TOKEN" ]]; then
        DOCKER_CMD+=(-e HF_TOKEN="$HF_TOKEN")
    fi
fi

if [[ "$MODE" == "quick" ]]; then
    DOCKER_CMD+=(-e BENCHMARK_QUICK=true)
fi

if [[ -n "$SCENARIO" ]]; then
    DOCKER_CMD+=(-e BENCHMARK_SCENARIO="$SCENARIO")
fi

if [[ "$INTERACTIVE" == "true" ]]; then
    echo "Starting interactive shell..."
    echo ""
    "${DOCKER_CMD[@]}" -it "$IMAGE" bash
else
    echo "Starting benchmark..."
    echo ""
    "${DOCKER_CMD[@]}" "$IMAGE" "${EXTRA_ARGS[@]}"
fi
