# Debugging

Common issues and how to debug them.

## Quick Diagnostics

```bash
# Check GPU
nvidia-smi

# Check database
psql $DATABASE_URL -c "SELECT COUNT(*) FROM trajectories"

# Check Python environment
cd packages/training/python
source venv/bin/activate
python -c "import torch; print(f'CUDA: {torch.cuda.is_available()}')"

# Check vLLM can start
python -m vllm.entrypoints.openai.api_server \
    --model Qwen/Qwen2.5-0.5B-Instruct \
    --port 8001 \
    --gpu-memory-utilization 0.25
```

## Common Issues

### CUDA Out of Memory

**Symptom:**

```text
RuntimeError: CUDA out of memory. Tried to allocate X MiB
```

**Causes & Fixes:**

1. **vLLM using too much memory**

   ```bash
   # Reduce vLLM allocation
   python scripts/run_training.py --profile 12gb --vllm-gpu-memory 0.2
   ```

2. **Batch size too large**

   ```bash
   python scripts/run_training.py --profile 12gb --batch-size 1
   ```

3. **Another process using GPU**

   ```bash
   # Check what's using GPU
   nvidia-smi
   
   # Kill zombie vLLM processes
   pkill -f "vllm.entrypoints"
   ```

4. **Accumulated gradients**
   - Restart training (memory leak possible)

### vLLM Won't Start

**Symptom:**

```text
TimeoutError: vLLM server did not start within 120s
```

**Fixes:**

1. **Increase timeout**

   ```bash
   export VLLM_STARTUP_TIMEOUT=300
   ```

2. **Check GPU availability**

   ```bash
   nvidia-smi
   # Should show free memory
   ```

3. **Try manual start**

   ```bash
   python -m vllm.entrypoints.openai.api_server \
       --model Qwen/Qwen2.5-0.5B-Instruct \
       --port 8001 \
       --gpu-memory-utilization 0.25
   ```

4. **Check port not in use**

   ```bash
   lsof -i :8001
   # Kill if occupied
   ```

### No Trajectories Found

**Symptom:**

```text
ValueError: No valid trajectory groups found
```

**Fixes:**

1. **Check database has data**

   ```sql
   SELECT COUNT(*) FROM trajectories;
   SELECT COUNT(*) FROM trajectories 
   WHERE "createdAt" > NOW() - INTERVAL '72 hours';
   ```

2. **Generate data**

   ```bash
   make tier4-generate
   make tier4-import
   ```

3. **Increase lookback window**

   ```bash
   python scripts/run_training.py --lookback-hours 168  # 1 week
   ```

4. **Lower requirements**

   ```bash
   python scripts/run_training.py --min-agents-per-window 1 --min-actions 2
   ```

### Training Loss Not Decreasing

**Causes:**

1. **All scores identical** - GRPO needs variance

   ```bash
   # Check in W&B or logs
   # Look for: score_std > 0.1
   ```
   Fix: Check scoring pipeline

2. **Learning rate too low**

   ```bash
   python scripts/run_training.py --lr 5e-5
   ```

3. **Bad data** - All trajectories similar

   ```bash
   # Generate more diverse data
   bun run packages/engine/examples/generate-training-data.ts --npcs 20 --hours 24
   ```

### Scores All Same

**Symptom:**

```text
[WARNING] All scores identical in batch, GRPO will skip
```

**Fixes:**

1. **Check format validation**

   ```python
   # Debug in Python
   from training.format_validator import validate_response_format
   result = validate_response_format(response)
   print(result)
   ```

2. **Check tiebreaker is applied**
   - Look for epsilon in `_score_with_judge`

3. **Increase group_size**

   ```bash
   python scripts/run_training.py --group-size 8
   ```

### Database Connection Failed

**Symptom:**

```text
ConnectionRefusedError: [Errno 111] Connection refused
```

**Fixes:**

1. **Start database**

   ```bash
   make db-up
   make db-migrate
   ```

2. **Check DATABASE_URL**

   ```bash
   echo $DATABASE_URL
   # Should be: postgresql://user:pass@host:port/db
   ```

3. **Test connection**

   ```bash
   psql $DATABASE_URL -c "SELECT 1"
   ```

### Import Errors

**Symptom:**

```text
ModuleNotFoundError: No module named 'training'
```

**Fix:**

```bash
cd packages/training/python
pip install -e .
```

**Symptom:**

```text
ModuleNotFoundError: No module named 'atroposlib'
```

**Fix:**

```bash
pip install atroposlib
# or
pip install -r requirements.txt
```

## Debugging Tools

### Enable Verbose Logging

```python
# In your script
import logging
logging.basicConfig(level=logging.DEBUG)

# Or for specific module
logging.getLogger("babylon_env").setLevel(logging.DEBUG)
```

### Debug Training Step

```python
# In babylon_env.py, add prints
def _score_with_judge(self, trajectory, response, archetype):
    print(f"=== Scoring ===")
    print(f"Archetype: {archetype}")
    print(f"Response: {response[:200]}...")
    
    format_result = validate_response_format(response)
    print(f"Format valid: {format_result.has_valid_json}")
    
    reasoning_score = score_response(response)
    print(f"Reasoning score: {reasoning_score}")
    
    # ... rest of scoring
    
    print(f"Final score: {final_score}")
    return final_score
```

### Test Scoring Standalone

```python
#!/usr/bin/env python3
"""debug_scoring.py - Test scoring in isolation"""

from training.rewards import *
from training.format_validator import validate_response_format
from training.quality_scorer import score_response

# Sample response
response = """
<thinking>
Market shows bullish momentum. I should buy ETH.
</thinking>

```json
{"action": "BUY", "ticker": "ETH", "amount": 1000}
```
"""

# Format
fmt = validate_response_format(response)
print(f"Format valid: {fmt.has_valid_json}")
print(f"Action type: {fmt.action.action_type}")

# Reasoning
rsn = score_response(response)
print(f"Reasoning score: {rsn}")

# Full composite
inputs = TrajectoryRewardInputs(
    final_pnl=100,
    starting_balance=10000,
    format_score=0.8,
    reasoning_score=rsn,
)
metrics = BehaviorMetrics(trades_executed=5, win_rate=0.6)
score = archetype_composite_reward(inputs, "trader", metrics)
print(f"Composite score: {score}")
```

### Monitor GPU During Training

```bash
# Terminal 1: Run training
make train-12gb

# Terminal 2: Monitor GPU
watch -n 1 nvidia-smi

# Look for:
# - Training process: 40-60% memory
# - vLLM process: 20-35% memory
# - No OOM
```

## Check W&B Logs

For training issues, W&B provides:

1. **Loss curve** - Should decrease
2. **Score distribution** - Should have variance
3. **Learning rate** - Per scheduler
4. **Gradient norm** - Should be 0.1-10

## Profiling

```python
import cProfile
import pstats

profiler = cProfile.Profile()
profiler.enable()

# Your code here
result = score_trajectory(trajectory)

profiler.disable()
stats = pstats.Stats(profiler).sort_stats('cumtime')
stats.print_stats(10)  # Top 10 slowest
```

## Getting Help

### Collect Diagnostic Info

```bash
# System info
python --version
pip show torch transformers vllm
nvidia-smi

# Environment
echo $DATABASE_URL
echo $CUDA_VISIBLE_DEVICES

# Recent errors
tail -100 python/logs/training.log
```

### Minimal Reproduction

1. Isolate the failing component
2. Create minimal test case
3. Include:
   - Python version
   - Package versions
   - GPU info
   - Input data (anonymized)
   - Full error traceback
