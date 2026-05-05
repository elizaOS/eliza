#!/bin/bash
# =============================================================================
# Babylon Benchmark Docker Entrypoint
# =============================================================================
#
# Orchestrates vLLM startup and benchmark execution.
#
# Modes:
#   1. Local model: Mount adapter at /models and set MODEL_PATH
#   2. HuggingFace: Set HF_MODEL to download from Hub
#   3. Base model only: Just set BASE_MODEL for evaluation
#
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# =============================================================================
# Configuration
# =============================================================================

# vLLM settings
VLLM_PORT="${VLLM_PORT:-9001}"
VLLM_HOST="${VLLM_HOST:-0.0.0.0}"
VLLM_GPU_MEMORY="${VLLM_GPU_MEMORY_UTILIZATION:-0.85}"
VLLM_MAX_LEN="${VLLM_MAX_MODEL_LEN:-4096}"

# Model settings
BASE_MODEL="${BASE_MODEL:-Qwen/Qwen2.5-0.5B-Instruct}"
MODEL_PATH="${MODEL_PATH:-${ADAPTER_PATH:-}}"
HF_MODEL="${HF_MODEL:-}"

# Benchmark settings
BENCHMARK_OUTPUT="${BENCHMARK_OUTPUT_DIR:-/benchmark-results}"
BENCHMARK_QUICK="${BENCHMARK_QUICK:-false}"
BENCHMARK_SCENARIO="${BENCHMARK_SCENARIO:-}"
BENCHMARK_ARCHETYPE="${BENCHMARK_ARCHETYPE:-trader}"
BENCHMARK_BASELINE="${BENCHMARK_BASELINE:-random}"

# =============================================================================
# Help
# =============================================================================

show_help() {
    cat << EOF
Babylon Benchmark Container

Usage: docker run [docker-options] babylon-benchmark:latest [options]

Options:
  --help, -h           Show this help message
  --scenario <id>      Run specific scenario (bull-market, bear-market, etc.)
  --quick              Use quick mode (shorter scenarios)
  --archetype <type>   Agent archetype (default: trader)
  --baseline <type>    Baseline strategy: random, momentum (default: random)
  --shell              Start interactive shell instead of benchmark

Environment Variables:
  BASE_MODEL           Base model name (default: Qwen/Qwen2.5-0.5B-Instruct)
  MODEL_PATH           Path to trained adapter (inside container)
  HF_MODEL             HuggingFace model ID to download
  HF_TOKEN             HuggingFace token for private models
  BENCHMARK_QUICK      Set to "true" for quick mode
  BENCHMARK_SCENARIO   Scenario ID to run
  BENCHMARK_ARCHETYPE  Agent archetype to test
  BENCHMARK_BASELINE   Baseline strategy

Examples:
  # Benchmark with local adapter
  docker run --gpus all -v ./trained_models:/models \\
    -e MODEL_PATH=/models/final_model \\
    babylon-benchmark:latest

  # Benchmark with HuggingFace model
  docker run --gpus all \\
    -e HF_MODEL=elizaos/ishtar-v0.1 \\
    -e HF_TOKEN=hf_xxx \\
    babylon-benchmark:latest

  # Quick benchmark on single scenario
  docker run --gpus all -v ./trained_models:/models \\
    -e MODEL_PATH=/models/final_model \\
    babylon-benchmark:latest --quick --scenario bear-market

EOF
    exit 0
}

# =============================================================================
# Parse Arguments
# =============================================================================

INTERACTIVE_SHELL=false
EXTRA_ARGS=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --help|-h)
            show_help
            ;;
        --shell)
            INTERACTIVE_SHELL=true
            shift
            ;;
        --quick)
            BENCHMARK_QUICK=true
            shift
            ;;
        --scenario)
            BENCHMARK_SCENARIO="$2"
            shift 2
            ;;
        --archetype)
            BENCHMARK_ARCHETYPE="$2"
            shift 2
            ;;
        --baseline)
            BENCHMARK_BASELINE="$2"
            shift 2
            ;;
        *)
            EXTRA_ARGS="$EXTRA_ARGS $1"
            shift
            ;;
    esac
done

# =============================================================================
# Interactive Shell Mode
# =============================================================================

if [ "$INTERACTIVE_SHELL" = true ]; then
    log_info "Starting interactive shell..."
    exec /bin/bash
fi

# =============================================================================
# Environment Validation
# =============================================================================

log_info "═══════════════════════════════════════════════════════════════"
log_info "              BABYLON BENCHMARK CONTAINER"
log_info "═══════════════════════════════════════════════════════════════"
echo ""

log_info "Configuration:"
echo "  Base Model:    $BASE_MODEL"
echo "  Model Path:    ${MODEL_PATH:-none}"
echo "  HF Model:      ${HF_MODEL:-none}"
echo "  vLLM URL:      http://localhost:$VLLM_PORT"
echo "  Quick Mode:    $BENCHMARK_QUICK"
echo "  Scenario:      ${BENCHMARK_SCENARIO:-all}"
echo "  Archetype:     $BENCHMARK_ARCHETYPE"
echo "  Baseline:      $BENCHMARK_BASELINE"
echo "  Output:        $BENCHMARK_OUTPUT"
echo ""

# Check GPU availability
if ! nvidia-smi &>/dev/null; then
    log_error "No GPU detected. Benchmarks require GPU acceleration."
    log_error "Run with: docker run --gpus all ..."
    exit 1
fi

log_success "GPU detected:"
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader | head -1

# =============================================================================
# Download HuggingFace Model (if specified)
# =============================================================================

if [ -n "$HF_MODEL" ]; then
    log_info "Downloading model from HuggingFace: $HF_MODEL"
    
    # Set token if provided
    if [ -n "$HF_TOKEN" ]; then
        export HUGGING_FACE_HUB_TOKEN="$HF_TOKEN"
    fi
    
    # Download using huggingface-cli
    export HF_DOWNLOAD_PATH="/models/hf-$(echo $HF_MODEL | tr '/' '-')"
    
    python3 -c "
from huggingface_hub import snapshot_download
import os

model_id = os.environ['HF_MODEL']
download_path = os.environ.get('HF_DOWNLOAD_PATH', '/models/hf-model')
token = os.environ.get('HF_TOKEN')

print(f'Downloading {model_id} to {download_path}...')
path = snapshot_download(
    repo_id=model_id,
    local_dir=download_path,
    token=token,
)
print(f'Downloaded to: {path}')
" || {
        log_error "Failed to download model from HuggingFace"
        exit 1
    }
    
    MODEL_PATH="$HF_DOWNLOAD_PATH"
    log_success "Model downloaded to: $MODEL_PATH"
fi

# =============================================================================
# Start vLLM Server
# =============================================================================

log_info "Starting vLLM server..."

# Build vLLM command
VLLM_CMD="python3 -m vllm.entrypoints.openai.api_server"
VLLM_CMD="$VLLM_CMD --model $BASE_MODEL"
VLLM_CMD="$VLLM_CMD --host $VLLM_HOST"
VLLM_CMD="$VLLM_CMD --port $VLLM_PORT"
VLLM_CMD="$VLLM_CMD --gpu-memory-utilization $VLLM_GPU_MEMORY"
VLLM_CMD="$VLLM_CMD --max-model-len $VLLM_MAX_LEN"
VLLM_CMD="$VLLM_CMD --trust-remote-code"
VLLM_CMD="$VLLM_CMD --enable-prefix-caching"

# Add model/adapter if specified
ADAPTER_NAME=""
IS_MERGED_MODEL=false
EFFECTIVE_MODEL="$BASE_MODEL"

# Fail fast if MODEL_PATH is set but doesn't exist
if [ -n "$MODEL_PATH" ] && [ ! -d "$MODEL_PATH" ]; then
    log_error "MODEL_PATH is set but directory does not exist: $MODEL_PATH"
    log_error "Either the model failed to download or the path is incorrect."
    if [ -f /tmp/vllm.log ]; then
        log_error "vLLM log (if available):"
        tail -20 /tmp/vllm.log 2>/dev/null || true
    fi
    exit 1
fi

if [ -n "$MODEL_PATH" ] && [ -d "$MODEL_PATH" ]; then
    # Check if it's a LoRA adapter (has adapter_config.json) or a full model
    if [ -f "$MODEL_PATH/adapter_config.json" ]; then
        log_info "Loading LoRA adapter: $MODEL_PATH"
        VLLM_CMD="$VLLM_CMD --enable-lora"
        VLLM_CMD="$VLLM_CMD --lora-modules trained-adapter=$MODEL_PATH"
        ADAPTER_NAME="trained-adapter"
    else
        log_info "Loading merged model: $MODEL_PATH"
        # Override the base model with the merged model path
        VLLM_CMD=$(echo "$VLLM_CMD" | sed "s|--model $BASE_MODEL|--model $MODEL_PATH|")
        IS_MERGED_MODEL=true
        EFFECTIVE_MODEL="$MODEL_PATH"
    fi
fi

# Start vLLM in background
log_info "vLLM command: $VLLM_CMD"
$VLLM_CMD > /tmp/vllm.log 2>&1 &
VLLM_PID=$!

# Wait for vLLM to be ready
log_info "Waiting for vLLM to be ready..."
MAX_WAIT=300
WAIT_COUNT=0

while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
    if curl -s http://localhost:$VLLM_PORT/health > /dev/null 2>&1; then
        log_success "vLLM is ready!"
        break
    fi
    
    # Check if vLLM process is still running
    if ! kill -0 $VLLM_PID 2>/dev/null; then
        log_error "vLLM process died unexpectedly"
        log_error "Last 50 lines of vLLM log:"
        tail -50 /tmp/vllm.log
        exit 1
    fi
    
    if [ $((WAIT_COUNT % 30)) -eq 0 ] && [ $WAIT_COUNT -gt 0 ]; then
        log_info "Still waiting for vLLM... ($WAIT_COUNT seconds)"
    fi
    
    sleep 1
    WAIT_COUNT=$((WAIT_COUNT + 1))
done

if [ $WAIT_COUNT -ge $MAX_WAIT ]; then
    log_error "vLLM failed to start within ${MAX_WAIT}s"
    log_error "vLLM log:"
    cat /tmp/vllm.log
    exit 1
fi

# Show available models
log_info "Available models:"
MODELS_RESPONSE=$(curl -s http://localhost:$VLLM_PORT/v1/models || echo "{}")
if echo "$MODELS_RESPONSE" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    for m in data.get('data', []):
        print(f'  - {m[\"id\"]}')
except json.JSONDecodeError:
    print('  (Could not fetch models list)')
"; then
    :
fi

echo ""

# =============================================================================
# Run Benchmark
# =============================================================================

log_info "Starting benchmark..."
echo ""

# Build benchmark command
BENCH_CMD="bun run scripts/run-vllm-benchmark.ts"
BENCH_CMD="$BENCH_CMD --vllm-url http://localhost:$VLLM_PORT"
BENCH_CMD="$BENCH_CMD --base-model $EFFECTIVE_MODEL"
BENCH_CMD="$BENCH_CMD --archetype $BENCHMARK_ARCHETYPE"
BENCH_CMD="$BENCH_CMD --baseline $BENCHMARK_BASELINE"
BENCH_CMD="$BENCH_CMD --output $BENCHMARK_OUTPUT"

if [ -n "$ADAPTER_NAME" ]; then
    # Use the LoRA module name if adapter is loaded
    BENCH_CMD="$BENCH_CMD --model $ADAPTER_NAME"
fi

if [ "$BENCHMARK_QUICK" = true ] || [ "$BENCHMARK_QUICK" = "true" ]; then
    BENCH_CMD="$BENCH_CMD --quick"
fi

if [ -n "$BENCHMARK_SCENARIO" ]; then
    BENCH_CMD="$BENCH_CMD --scenario $BENCHMARK_SCENARIO"
fi

# Add any extra arguments
BENCH_CMD="$BENCH_CMD $EXTRA_ARGS"

log_info "Benchmark command: $BENCH_CMD"
echo ""

# Run benchmark
cd /app/packages/training
$BENCH_CMD
BENCH_EXIT=$?

# =============================================================================
# Cleanup
# =============================================================================

log_info "Stopping vLLM..."
kill $VLLM_PID 2>/dev/null || true

if [ $BENCH_EXIT -eq 0 ]; then
    log_success "Benchmark completed successfully!"
else
    log_error "Benchmark failed with exit code: $BENCH_EXIT"
fi

exit $BENCH_EXIT

