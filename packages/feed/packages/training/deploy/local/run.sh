#!/bin/bash
# Babylon Training - Local Docker Run
#
# Quick script to run training locally with Docker.
#
# Usage:
#   ./run.sh                          # Use defaults
#   ./run.sh --profile 12gb           # Specify profile
#   ./run.sh --steps 100              # Specify steps
#   ./run.sh --interactive            # Start bash shell
#
# Prerequisites:
#   - Docker with NVIDIA Container Toolkit
#   - Built training image (or pull from registry)
#   - .env file in deploy/ directory

set -e

# ============================================================================
# Configuration
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
TRAINING_DIR="$(dirname "$DEPLOY_DIR")"

# Defaults
IMAGE="${BABYLON_IMAGE:-revlentless/babylon-training:0.2.1}"
ENV_FILE="${BABYLON_ENV_FILE:-$DEPLOY_DIR/.env}"
PROFILE="${BABYLON_PROFILE:-12gb}"
STEPS="${BABYLON_STEPS:-100}"
MIN_AGENTS="${BABYLON_MIN_AGENTS:-1}"
HF_DATASET=""
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
        --env-file)
            ENV_FILE="$2"
            shift 2
            ;;
        --profile)
            PROFILE="$2"
            shift 2
            ;;
        --steps)
            STEPS="$2"
            shift 2
            ;;
        --min-agents-per-window|--min-agents)
            MIN_AGENTS="$2"
            shift 2
            ;;
        --hf-dataset)
            HF_DATASET="$2"
            shift 2
            ;;
        --interactive|-i)
            INTERACTIVE=true
            shift
            ;;
        --help|-h)
            echo "Babylon Training - Local Docker Run"
            echo ""
            echo "Usage: ./run.sh [options]"
            echo ""
            echo "Options:"
            echo "  --image <image>      Docker image (default: $IMAGE)"
            echo "  --env-file <path>    Environment file (default: $ENV_FILE)"
            echo "  --profile <profile>  GPU profile: 12gb, 24gb, l40, a100, h100"
            echo "  --steps <n>          Training steps (default: $STEPS)"
            echo "  --min-agents <n>     Min agents per window (default: $MIN_AGENTS)"
            echo "  --hf-dataset <id>    HuggingFace dataset instead of DB (e.g., elizaos/enkidu-trajectories-test)"
            echo "  --interactive, -i    Start interactive bash shell"
            echo "  --help, -h           Show this help"
            echo ""
            echo "Environment variables:"
            echo "  BABYLON_IMAGE        Override default image"
            echo "  BABYLON_ENV_FILE     Override default env file"
            echo "  BABYLON_PROFILE      Override default profile"
            echo "  BABYLON_STEPS        Override default steps"
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

# Check env file
if [[ ! -f "$ENV_FILE" ]]; then
    echo "⚠ Environment file not found: $ENV_FILE"
    echo ""
    echo "Create one with:"
    echo "  cp $DEPLOY_DIR/env.example $DEPLOY_DIR/.env"
    echo "  # Then edit .env with your DATABASE_URL, etc."
    exit 1
fi

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker not found. Please install Docker."
    exit 1
fi

# Check NVIDIA runtime
if ! docker info 2>/dev/null | grep -q "Runtimes.*nvidia"; then
    echo "⚠ NVIDIA Container Toolkit may not be installed."
    echo "  See: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html"
fi

# ============================================================================
# Run
# ============================================================================

echo "============================================"
echo "  Babylon RL Training - Local"
echo "============================================"
echo ""
echo "Image:      $IMAGE"
echo "Env file:   $ENV_FILE"
echo "Profile:    $PROFILE"
echo "Steps:      $STEPS"
echo "Min agents: $MIN_AGENTS"
if [[ -n "$HF_DATASET" ]]; then
    echo "HF Dataset: $HF_DATASET"
fi
echo ""

# Build docker run command
# Note: Training saves to /app/python/trained_models (relative to python/ dir)
DOCKER_CMD=(
    docker run
    --gpus all
    --network host
    --env-file "$ENV_FILE"
    -v "$TRAINING_DIR/trained_models:/app/python/trained_models"
    -v "$TRAINING_DIR/logs:/app/logs"
)

if [[ "$INTERACTIVE" == "true" ]]; then
    echo "Starting interactive shell..."
    echo ""
    "${DOCKER_CMD[@]}" -it "$IMAGE" bash
else
    echo "Starting training..."
    echo ""
    
    # Build training command
    TRAIN_CMD=(
        python3 python/scripts/run_training.py
        --profile "$PROFILE"
        --steps "$STEPS"
        --min-agents-per-window "$MIN_AGENTS"
    )
    
    # Add HF dataset if specified
    if [[ -n "$HF_DATASET" ]]; then
        TRAIN_CMD+=(--hf-dataset "$HF_DATASET")
    fi
    
    "${DOCKER_CMD[@]}" "$IMAGE" "${TRAIN_CMD[@]}" "${EXTRA_ARGS[@]}"
fi

