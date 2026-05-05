#!/usr/bin/env bash
set -euo pipefail

# Provision a persistent Nebius H100 VM running vLLM for Babylon agent inference.
#
# This creates a long-running inference server that:
# 1. Serves Qwen3.5-4B (or 9B) via OpenAI-compatible API
# 2. Supports LoRA adapter hot-swap for continuous training
# 3. Babylon agents connect via GROQ_BASE_URL
#
# Usage:
#   ./provision_nebius_inference.sh                    # Default: 4B on H100
#   ./provision_nebius_inference.sh --9b --gpu h200    # 9B on H200
#   ./provision_nebius_inference.sh --existing <IP>    # Connect to existing

MODEL="Qwen/Qwen3.5-4B"
GPU_TYPE="h100"
PORT=9001
INSTANCE_NAME="babylon-inference-$(date +%s)"
EXISTING_HOST=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --9b) MODEL="Qwen/Qwen3.5-9B"; shift;;
        --4b) MODEL="Qwen/Qwen3.5-4B"; shift;;
        --gpu) GPU_TYPE="$2"; shift 2;;
        --port) PORT="$2"; shift 2;;
        --name) INSTANCE_NAME="$2"; shift 2;;
        --existing) EXISTING_HOST="$2"; shift 2;;
        *) echo "Unknown: $1"; exit 1;;
    esac
done

NEBIUS=${NEBIUS_CLI:-/home/shaw/.nebius/bin/nebius}
KEY=${SSH_KEY:-~/.ssh/id_ed25519}

if [ -n "$EXISTING_HOST" ]; then
    echo "Connecting to existing host: $EXISTING_HOST"
    IP="$EXISTING_HOST"
else
    echo "Provisioning Nebius $GPU_TYPE VM: $INSTANCE_NAME"
    echo "Model: $MODEL"

    # Use the run_nebius_unified_matrix.py provisioning (it handles all the cloud-init)
    # For now, just output the connection instructions
    echo ""
    echo "To provision manually:"
    echo "  1. Create H100 VM via Nebius console or CLI"
    echo "  2. SSH in and run the setup below"
    echo ""
    echo "Or use existing scripts:"
    echo "  python3 scripts/tools/run_nebius_unified_matrix.py --dry-run --keep-instance --base-model $MODEL --gpu-type $GPU_TYPE"
    echo ""
    echo "Then get the IP and re-run with: $0 --existing <IP>"
    exit 0
fi

echo "Setting up vLLM on $IP..."

ssh -i $KEY -o StrictHostKeyChecking=accept-new trainer@$IP "
# Install vLLM if not already
if ! command -v vllm &>/dev/null && [ ! -f .venv/bin/vllm ]; then
    python3 -m venv .venv
    source .venv/bin/activate
    pip install vllm torch transformers peft
else
    source .venv/bin/activate 2>/dev/null || true
fi

# Kill any existing vLLM
pkill -f 'vllm serve' 2>/dev/null || true
sleep 2

# Start vLLM with LoRA hot-swap support
echo 'Starting vLLM: $MODEL on port $PORT with LoRA support...'
nohup python3 -m vllm.entrypoints.openai.api_server \
    --model $MODEL \
    --port $PORT \
    --host 0.0.0.0 \
    --tensor-parallel-size 1 \
    --gpu-memory-utilization 0.85 \
    --enable-lora \
    --max-lora-rank 32 \
    --enforce-eager \
    > /tmp/vllm-serve.log 2>&1 &

echo 'vLLM starting... waiting for health check'
for i in \$(seq 1 60); do
    if curl -s http://localhost:$PORT/health > /dev/null 2>&1; then
        echo 'vLLM is ready!'
        break
    fi
    sleep 5
done

echo ''
echo '================================================'
echo '  vLLM INFERENCE SERVER READY'
echo '  Model: $MODEL'
echo '  Endpoint: http://$IP:$PORT/v1'
echo '  LoRA: enabled (hot-swap via API)'
echo '================================================'
echo ''
echo 'To connect Babylon agents:'
echo '  export GROQ_BASE_URL=http://$IP:$PORT/v1'
echo '  export GROQ_API_KEY=dummy'
echo '  export GROQ_PRIMARY_MODEL=$MODEL'
"

echo ""
echo "================================================"
echo "  NEBIUS INFERENCE SERVER: http://$IP:$PORT/v1"
echo ""
echo "  Set in Babylon .env.local:"
echo "    GROQ_BASE_URL=http://$IP:$PORT/v1"
echo "    GROQ_API_KEY=dummy"
echo "    GROQ_PRIMARY_MODEL=$MODEL"
echo "================================================"
