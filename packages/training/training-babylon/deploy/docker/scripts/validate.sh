#!/bin/bash
# Babylon Training Environment Validation
#
# Quick validation script to verify the container environment is correctly set up.
# Run this before starting training to catch configuration issues early.
#
# Usage:
#   ./validate.sh
#   docker exec <container> /app/scripts/validate.sh

set -e

echo "============================================"
echo "  Babylon Training - Environment Validation"
echo "============================================"
echo ""

ERRORS=0

# 1. GPU check
echo "[1/6] Checking GPUs..."
if command -v nvidia-smi &> /dev/null; then
    GPU_COUNT=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | wc -l)
    if [ "$GPU_COUNT" -gt 0 ]; then
        echo "  ✓ Found $GPU_COUNT GPU(s)"
        nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | sed 's/^/    /'
    else
        echo "  ✗ No GPUs detected"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo "  ✗ nvidia-smi not found"
    ERRORS=$((ERRORS + 1))
fi

# 2. Python packages
echo ""
echo "[2/6] Checking Python packages..."
python3 -c "
import sys
packages = ['torch', 'vllm', 'atroposlib', 'asyncpg', 'transformers', 'peft']
missing = []
for pkg in packages:
    try:
        __import__(pkg)
    except ImportError:
        missing.append(pkg)

if missing:
    print(f'  ✗ Missing packages: {missing}')
    sys.exit(1)
else:
    print('  ✓ All required packages installed')
" || ERRORS=$((ERRORS + 1))

# 3. CUDA availability
echo ""
echo "[3/6] Checking CUDA..."
python3 -c "
import torch
if torch.cuda.is_available():
    print(f'  ✓ CUDA available (PyTorch {torch.__version__})')
else:
    print('  ✗ CUDA not available')
    exit(1)
" || ERRORS=$((ERRORS + 1))

# 4. Database connection
echo ""
echo "[4/6] Checking database..."
if [ -z "$DATABASE_URL" ]; then
    echo "  ⚠ DATABASE_URL not set (required for training)"
else
    python3 -c "
import os, asyncio, asyncpg
async def test():
    pool = await asyncpg.create_pool(
        os.environ['DATABASE_URL'], 
        min_size=1, max_size=1, 
        statement_cache_size=0, 
        command_timeout=10
    )
    async with pool.acquire() as conn:
        count = await conn.fetchval('SELECT COUNT(*) FROM trajectories WHERE \"isTrainingData\" = true')
        print(f'  ✓ Connected - {count} training trajectories')
    await pool.close()
asyncio.run(test())
" || { echo "  ✗ Database connection failed"; ERRORS=$((ERRORS + 1)); }
fi

# 5. GPU profiles
echo ""
echo "[5/6] Checking GPU profiles..."
PROFILE_DIR="/app/python/config/profiles"
if [ -d "$PROFILE_DIR" ]; then
    PROFILE_COUNT=$(ls -1 "$PROFILE_DIR"/*.json 2>/dev/null | wc -l)
    echo "  ✓ Found $PROFILE_COUNT GPU profile(s)"
else
    # Try alternate location
    PROFILE_DIR="/app/config/profiles"
    if [ -d "$PROFILE_DIR" ]; then
        PROFILE_COUNT=$(ls -1 "$PROFILE_DIR"/*.json 2>/dev/null | wc -l)
        echo "  ✓ Found $PROFILE_COUNT GPU profile(s)"
    else
        echo "  ⚠ No profiles directory found"
    fi
fi

# 6. Model loading test
echo ""
echo "[6/6] Testing model loading (tokenizer only)..."
python3 -c "
from transformers import AutoTokenizer
tokenizer = AutoTokenizer.from_pretrained('Qwen/Qwen2.5-0.5B-Instruct', trust_remote_code=True)
print('  ✓ Tokenizer loads OK')
" || { echo "  ✗ Tokenizer load failed"; ERRORS=$((ERRORS + 1)); }

# Summary
echo ""
echo "============================================"
if [ "$ERRORS" -eq 0 ]; then
    echo "  ✓ Validation Complete - All checks passed!"
    echo "============================================"
    echo ""
    echo "Ready to train! Example:"
    echo "  python3 python/scripts/run_training.py --profile 12gb --steps 100"
    exit 0
else
    echo "  ✗ Validation Failed - $ERRORS error(s)"
    echo "============================================"
    exit 1
fi

