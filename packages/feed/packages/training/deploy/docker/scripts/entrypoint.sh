#!/bin/bash
# Babylon Training Container Entrypoint
# 
# This script runs on container startup to:
# 1. Validate GPU availability
# 2. Verify Python package installations
# 3. Test database connectivity
# 4. Execute the provided command

set -e

echo "============================================"
echo "  Babylon RL Training"
echo "============================================"
echo ""

# Check GPU availability
echo "Checking GPUs..."
if command -v nvidia-smi &> /dev/null; then
    nvidia-smi --query-gpu=name,memory.total --format=csv
else
    echo "WARNING: nvidia-smi not found. GPU may not be available."
fi
echo ""

# Verify installations
echo "Verifying installations..."
python3 -c "
import torch
print(f'PyTorch: {torch.__version__}')
print(f'CUDA available: {torch.cuda.is_available()}')
print(f'GPU count: {torch.cuda.device_count()}')
if torch.cuda.is_available():
    for i in range(torch.cuda.device_count()):
        print(f'  GPU {i}: {torch.cuda.get_device_name(i)}')
"

python3 -c "import vllm; print(f'vLLM: {vllm.__version__}')"

# Check attention backend info
python3 -c "
try:
    import flash_attn
    print(f'Flash Attention: {flash_attn.__version__}')
except ImportError:
    print('Flash Attention: Not installed (using FlashInfer instead)')
import os
backend = os.environ.get('VLLM_ATTENTION_BACKEND', 'auto')
print(f'Attention Backend: {backend}')
" 2>/dev/null || true

echo ""

# Check database connection if provided
if [ -n "$DATABASE_URL" ]; then
    echo "Testing database connection..."
    python3 -c "
import os
import asyncio
import asyncpg

async def test():
    try:
        pool = await asyncpg.create_pool(
            os.environ['DATABASE_URL'], 
            min_size=1, 
            max_size=1, 
            statement_cache_size=0,
            command_timeout=10
        )
        async with pool.acquire() as conn:
            count = await conn.fetchval('SELECT COUNT(*) FROM trajectories WHERE \"isTrainingData\" = true')
            print(f'✓ Database connected! Training trajectories: {count}')
        await pool.close()
    except Exception as e:
        print(f'⚠ Database connection failed: {e}')

asyncio.run(test())
" || echo "⚠ Database connection test failed."
    echo ""
else
    echo "⚠ DATABASE_URL not set - skipping database check"
    echo ""
fi

# Run the command
echo "Starting: $@"
echo "============================================"
exec "$@"

