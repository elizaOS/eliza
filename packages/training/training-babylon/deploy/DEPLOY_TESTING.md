# Babylon Deploy System - Full Test Plan

Complete end-to-end testing of training, dataset, model, and benchmark infrastructure.

---

## Overview

### Test Environments

| Environment | GPU | VRAM | Purpose |
|-------------|-----|------|---------|
| **Local** | RTX 3060 | 12GB | Validate all flows work |
| **RunPod** | H100/4090 | 80GB/24GB | Production-scale validation |

### Test Matrix

| Component | Local | RunPod |
|-----------|-------|--------|
| Training (DB source) | ✓ | ✗ (can't reach local DB) |
| Training (HF dataset source) | ✓ | ✓ |
| Create HF Dataset | ✓ | - |
| Push Model to HF | ✓ | ✓ |
| Pull Model from HF | ✓ | ✓ |
| Benchmark (local model) | ✓ | - |
| Benchmark (HF model) | ✓ | ✓ |

### Key Learnings

1. **RunPod cannot access local databases** - Always use `--hf-dataset` for cloud training
2. **GRPO requires `raw` format datasets** - Not `preferences` (that's for DPO)
3. **min_agents_per_window** - Set to 1 if windows have single trajectories
4. **Base model must match** - Training and benchmark must use same base model
5. **Merged vs LoRA models** - Training produces merged models by default; benchmark detects this automatically

---

## Naming Conventions

### Models (HuggingFace)

| Purpose | Repo ID | Base Model | Description |
|---------|---------|------------|-------------|
| Local test (12GB) | `elizaos/gilgamesh-test-3060` | `Qwen/Qwen2.5-0.5B-Instruct` | RTX 3060 trained |
| RunPod test (H100) | `elizaos/gilgamesh-test-h100` | `Qwen/Qwen2.5-14B-Instruct` | H100 trained |
| Production | `elizaos/gilgamesh-v0.1` | TBD | First release |

### Datasets (HuggingFace)

| Purpose | Repo ID | Format | Description |
|---------|---------|--------|-------------|
| GRPO training | `elizaos/enkidu-trajectories-raw` | `raw` split | Full trajectories for GRPO |
| DPO training | `elizaos/enkidu-trajectories-preferences` | `preferences` split | Preference pairs |
| Small test | `elizaos/enkidu-trajectories-test` | `raw` split | 100 trajectories |

### Docker Images

| Image | Tag | Registry |
|-------|-----|----------|
| Base | `revlentless/babylon-base:0.2.1` | Docker Hub |
| Training | `revlentless/babylon-training:0.2.1` | Docker Hub |
| Benchmark | `revlentless/babylon-benchmark:0.1.0` | Docker Hub |

### GPU Profiles

| Profile | Base Model | GPU Memory | Use Case |
|---------|------------|------------|----------|
| `12gb` | `Qwen/Qwen2.5-0.5B-Instruct` | 0.45 | RTX 3060 (12GB) |
| `24gb` | `Qwen/Qwen2.5-3B-Instruct` | 0.50 | RTX 4090 (24GB) |
| `h100` | `Qwen/Qwen2.5-14B-Instruct` | 0.50 | H100 (80GB) |

---

## Environment Variables

### Required for All Tests

```bash
# deploy/.env - Master environment file

# =============================================================================
# CORE (Required for database source)
# =============================================================================
DATABASE_URL="postgresql://postgres.xxxx:password@aws-0-us-west-1.pooler.supabase.com:6543/postgres"

# =============================================================================
# HUGGINGFACE (Required for HF operations)
# =============================================================================
HF_TOKEN="hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
HF_ORG="elizaos"

# =============================================================================
# WEIGHTS & BIASES (Optional but recommended)
# =============================================================================
WANDB_API_KEY="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
WANDB_PROJECT="babylon-training"
WANDB_ENTITY="your-entity"

# =============================================================================
# RUNPOD (Required for RunPod tests)
# =============================================================================
RUNPOD_API_KEY="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# =============================================================================
# DOCKER (Optional, defaults shown)
# =============================================================================
DOCKER_REGISTRY="revlentless"
TAG="0.2.1"

# =============================================================================
# TRAINING DEFAULTS (Optional)
# =============================================================================
TRAINING_PROFILE="12gb"
TRAINING_STEPS="5"
MIN_AGENTS_PER_WINDOW="1"
```

### Environment by Phase

#### Phase 1: Local Testing

```bash
# Minimal required for local training from DB
DATABASE_URL="postgresql://..."  # Your Supabase URL
HF_TOKEN="hf_..."                # For pushing models/datasets
WANDB_API_KEY="..."              # Optional, for tracking

# Export explicitly (source may truncate values with special chars)
export DATABASE_URL="postgresql://..."
export HF_TOKEN="hf_..."
```

#### Phase 2: RunPod Testing

```bash
# Additional for RunPod (DB not accessible from cloud!)
RUNPOD_API_KEY="..."             # From RunPod console
HF_TOKEN="hf_..."                # CRITICAL: needed for private datasets
DOCKER_REGISTRY="revlentless"    # Your Docker Hub org
```

---

## Prerequisites

### 1. Environment Setup

```bash
cd packages/training

# Copy template
cp deploy/.env.example deploy/.env

# Edit with your values (see Environment Variables section above)
nano deploy/.env
```

### 2. Verify Prerequisites

```bash
# Export env vars (use set -a to auto-export)
set -a && source deploy/.env && set +a

# Check Docker + GPU
docker run --rm --gpus all nvidia/cuda:12.4-base-ubuntu22.04 nvidia-smi

# Check HuggingFace CLI
pip install huggingface_hub
huggingface-cli whoami  # Should show your username

# Verify database connection and trajectory count
psql "$DATABASE_URL" -c 'SELECT COUNT(*) as total, COUNT(CASE WHEN "stepsJson" IS NOT NULL THEN 1 END) as with_steps FROM trajectories;'
```

### 3. Build Docker Images

```bash
cd deploy/docker

# Build all images with test tag
./build.sh base -t 0.2.1 -o revlentless
./build.sh training -t 0.2.1 -o revlentless
./build.sh benchmark -t 0.1.0 -o revlentless

# Verify images exist
docker images | grep babylon
```

---

## Phase 1: Local Testing (RTX 3060 12GB)

### Environment for Phase 1

```bash
# Required in deploy/.env or exported in shell
export DATABASE_URL="postgresql://postgres.xxxx:password@host:6543/postgres"
export HF_TOKEN="hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export WANDB_API_KEY="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"  # Optional
```

---

### Test 1.1: Training from Database

**Goal**: Verify core training pipeline works with DB trajectory source.

**Model Output**: `trained_models/gilgamesh-local-001/`

**Profile**: `12gb` → Base model: `Qwen/Qwen2.5-0.5B-Instruct`

```bash
cd packages/training/deploy/local

# Verify env is set
echo $DATABASE_URL | head -c 30

# Run minimal training (5 steps)
./run.sh \
  --image revlentless/babylon-training:0.2.1 \
  --profile 12gb \
  --steps 5 \
  --min-agents 1 \
  --env-file ../.env

# Expected output:
# - Training starts without errors
# - vLLM loads Qwen/Qwen2.5-0.5B-Instruct
# - Batches are processed (not "Empty batch")
# - Checkpoints saved to trained_models/
```

**Verify:**
```bash
# Check model output
ls -la ../../trained_models/

# Should see either:
# - final_model/ with adapter_config.json (LoRA adapter)
# - final_model/ with model.safetensors (merged model)

# Rename for clarity
mv ../../trained_models/final_model ../../trained_models/gilgamesh-local-001
```

**Troubleshooting:**
- `Empty batch, skipping step` → Your windows have < 2 trajectories. Use `--min-agents 1`
- `NO SUCCESSFUL TRAINING STEPS` → All scores identical or data quality issue

**Expected Duration**: ~5-10 minutes

---

### Test 1.2: Create HuggingFace Dataset

**Goal**: Export trajectories from DB to HF dataset format.

**Dataset Name**: `elizaos/enkidu-trajectories-raw`

```bash
cd packages/training

# Export env vars explicitly (source may truncate special chars in passwords)
export DATABASE_URL="postgresql://postgres.xxxx:password@host:6543/postgres"
export HF_TOKEN="hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export HF_HOME="$HOME/.cache/huggingface"

# Export trajectories in RAW format (required for GRPO training)
python python/scripts/hf/trajectories_to_hf_dataset.py \
  --output ./hf_dataset_raw \
  --format raw \
  --max-trajectories 1000

# Expected output:
# - hf_dataset_raw/ directory created
# - Contains parquet files
```

**Verify:**
```bash
ls -la hf_dataset_raw/

# Quick inspect
python -c "from datasets import load_from_disk; ds = load_from_disk('hf_dataset_raw'); print(ds)"
```

**Push to HuggingFace:**
```bash
# Push as raw dataset (creates repo if needed)
python python/scripts/hf/trajectories_to_hf_dataset.py \
  --output ./hf_dataset_raw \
  --format raw \
  --max-trajectories 1000 \
  --push-to-hub elizaos/enkidu-trajectories-raw

# Verify dataset loads from HuggingFace
python -c "
from datasets import load_dataset
ds = load_dataset('elizaos/enkidu-trajectories-raw', split='raw')
print(f'Loaded {len(ds)} rows')
print('Columns:', ds.column_names)
"
```

**Dataset Format Notes:**
- `raw` format: Full trajectory data for GRPO training
- `preferences` format: Preference pairs for DPO training
- `sft` format: Supervised fine-tuning format

---

### Test 1.3: Training from HuggingFace Dataset

**Goal**: Verify training can use HF dataset instead of DB.

**Important**: GRPO training requires `raw` format datasets.

```bash
cd packages/training/deploy/local

# Export HF_TOKEN for private datasets
export HF_TOKEN="hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# Run training with HF source
./run.sh \
  --image revlentless/babylon-training:0.2.1 \
  --profile 12gb \
  --steps 5 \
  --min-agents 1 \
  --env-file ../.env \
  --hf-dataset elizaos/enkidu-trajectories-raw

# Expected output:
# - "Using HuggingFace dataset: elizaos/enkidu-trajectories-raw"
# - "Split: raw"
# - Training proceeds normally
```

**Verify:**
```bash
ls -la ../../trained_models/
```

**Troubleshooting:**
- `Empty batch` with HF dataset → Check dataset has `raw` split, not just `preferences`
- `HF_TRAJECTORY_DATASET not set` → The `--hf-dataset` flag wasn't passed correctly

---

### Test 1.4: Push Model to HuggingFace

**Goal**: Upload trained model to HuggingFace Hub.

**Model Name**: `elizaos/gilgamesh-test-3060`

```bash
cd packages/training

# Export tokens
export HF_TOKEN="hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export HF_HOME="$HOME/.cache/huggingface"

# Push the trained model
python python/scripts/hf/push_model_to_hf.py \
  --adapter-path ./trained_models/gilgamesh-local-001 \
  --repo-id elizaos/gilgamesh-test-3060 \
  --private \
  --base-model Qwen/Qwen2.5-0.5B-Instruct

# Expected output:
# - Model uploaded to HF
# - Model card generated
```

**Verify:**
```text
https://huggingface.co/elizaos/gilgamesh-test-3060
```

**Notes:**
- If model has `model.safetensors`, it's a merged model (not LoRA adapter)
- If model has `adapter_model.safetensors`, it's a LoRA adapter
- The benchmark script handles both automatically

---

### Test 1.5: Benchmark with Local Model

**Goal**: Run benchmark against locally trained model.

**Important**: `--base-model` must match the model used during training!

```bash
cd packages/training/deploy/local

# Export HF_TOKEN for model access
export HF_TOKEN="hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# Quick benchmark (7-day scenarios)
./benchmark.sh \
  --image revlentless/babylon-benchmark:0.1.0 \
  --model gilgamesh-local-001 \
  --base-model Qwen/Qwen2.5-0.5B-Instruct \
  --quick

# Expected output:
# - vLLM starts with correct base model
# - Model loaded (LoRA adapter or merged model detected automatically)
# - Scenarios run
# - Results saved to benchmark-results/
```

**Verify:**
```bash
ls -la ../../benchmark-results/

# Check JSON reports
cat ../../benchmark-results/*.json | python -m json.tool | head -50
```

**Understanding Results:**
- `[WARN] vLLM request failed (attempt N) { "error": "Failed to parse JSON" }` → Model returned non-JSON response. This is expected for untrained/poorly trained models.
- A well-trained model should return valid JSON action responses most of the time.

---

### Test 1.6: Benchmark with HuggingFace Model

**Goal**: Pull model from HF and benchmark it.

```bash
cd packages/training/deploy/local

# Export HF_TOKEN for private model access
export HF_TOKEN="hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# Benchmark the model we pushed (must match base model!)
./benchmark.sh \
  --image revlentless/babylon-benchmark:0.1.0 \
  --hf-model elizaos/gilgamesh-test-3060 \
  --base-model Qwen/Qwen2.5-0.5B-Instruct \
  --quick

# Benchmark base model for comparison (public, no token needed)
./benchmark.sh \
  --image revlentless/babylon-benchmark:0.1.0 \
  --hf-model Qwen/Qwen2.5-0.5B-Instruct \
  --base-model Qwen/Qwen2.5-0.5B-Instruct \
  --quick \
  --scenario bull-market
```

**Verify:**
```bash
# Compare results
ls -la ../../benchmark-results/
```

---

### Test 1.7: Full Benchmark Suite

**Goal**: Run all scenarios against trained model.

```bash
cd packages/training/deploy/local

export HF_TOKEN="hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# Full benchmark (all scenarios, 22-day)
./benchmark.sh \
  --image revlentless/babylon-benchmark:0.1.0 \
  --model gilgamesh-local-001 \
  --base-model Qwen/Qwen2.5-0.5B-Instruct \
  --full

# Single scenario deep dive
./benchmark.sh \
  --image revlentless/babylon-benchmark:0.1.0 \
  --model gilgamesh-local-001 \
  --base-model Qwen/Qwen2.5-0.5B-Instruct \
  --scenario bear-market
```

**Available Scenarios:**
- `bull-market` - Steady uptrend
- `bear-market` - Crash and recovery
- `scandal-unfolds` - Hidden truth revealed
- `pump-and-dump` - Manipulation event

---

### Test 1.8: Interactive Shell

**Goal**: Verify interactive debugging works.

```bash
cd packages/training/deploy/local

# Training container shell
./run.sh \
  --image revlentless/babylon-training:0.2.1 \
  --env-file ../.env \
  --interactive

# Inside container, verify:
nvidia-smi                              # GPU visible
ls /app/python/trained_models/          # Models accessible
python3 -c "import torch; print(torch.cuda.is_available())"  # CUDA works
env | grep -E "(DATABASE|HF_|WANDB)"    # Env vars set
exit

# Benchmark container shell
./benchmark.sh \
  --image revlentless/babylon-benchmark:0.1.0 \
  --interactive

# Inside container, verify:
nvidia-smi
bun --version
ls /models/
exit
```

---

## Phase 2: RunPod Testing

### Environment for Phase 2

```bash
# Required in deploy/.env (RunPod reads from here)
RUNPOD_API_KEY="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
HF_TOKEN="hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"       # CRITICAL for private datasets!
WANDB_API_KEY="..."                               # Optional
DOCKER_REGISTRY="revlentless"

# Note: DATABASE_URL won't work from RunPod (can't reach local DB)
# Must use --hf-dataset instead
```

### Important: RunPod Data Source

**RunPod has trouble accesses local/private databases.** Use `--hf-dataset`:

```bash
# WRONG
python setup.py train --gpu h100 ...

# CORRECT (uses HF dataset)
python setup.py train --gpu h100 --hf-dataset elizaos/enkidu-trajectories-raw ...
```

---

### Test 2.1: Push Docker Images to Registry

```bash
cd packages/training/deploy/docker

# Login to Docker Hub first
docker login

# Push images to Docker Hub
./build.sh push-base -t 0.2.1 -o revlentless
./build.sh push-training -t 0.2.1 -o revlentless
./build.sh push-benchmark -t 0.1.0 -o revlentless

# Verify images are accessible (from another machine or after logout)
docker pull revlentless/babylon-training:0.2.1
docker pull revlentless/babylon-benchmark:0.1.0
```

---

### Test 2.2: Training on RunPod (4090, HF Dataset)

**Goal**: Run training on cloud GPU with HuggingFace dataset source.

**Note**: Using HF dataset because RunPod can't reach local databases.

```bash
cd packages/training/deploy/runpod

# Verify API access
python setup.py list

# Start training pod (4090 for cost efficiency)
python setup.py train \
  --gpu 4090 \
  --image revlentless/babylon-training:0.2.1 \
  --env-file ../.env \
  --steps 100 \
  --profile 24gb \
  --hf-dataset elizaos/enkidu-trajectories-raw \
  --min-agents-per-window 1 \
  --name gilgamesh-runpod-4090 \
  --spot \
  --community

# Monitor
python setup.py list

# Check logs at https://console.runpod.io/pods
```

**Wait for completion (~30 min), then:**
```bash
# Get pod ID from list
python setup.py list

# View logs
python setup.py logs <pod-id>

# Stop pod when done
python setup.py stop <pod-id>
```

**Model Recovery**: SSH into pod before stopping to push model to HF.

---

### Test 2.3: Training on RunPod (H100, More Steps)

**Goal**: Train a better model with more compute.

**Model Name**: `elizaos/gilgamesh-test-h100`

**Profile**: `h100` → Base model: `Qwen/Qwen2.5-14B-Instruct`

```bash
cd packages/training/deploy/runpod

# H100 for faster training
python setup.py train \
  --gpu h100 \
  --image revlentless/babylon-training:0.2.1 \
  --env-file ../.env \
  --steps 500 \
  --profile h100 \
  --hf-dataset elizaos/enkidu-trajectories-raw \
  --min-agents-per-window 1 \
  --name gilgamesh-runpod-h100

# Monitor
python setup.py list

# Estimated time: ~45 min
# Estimated cost: ~$3
```

**Post-Training**: SSH into pod to push model before terminating:
```bash
# In pod SSH session:
export HF_TOKEN="hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export HF_HOME=/tmp/hf_cache

python python/scripts/hf/push_model_to_hf.py \
  --adapter-path ./trained_models/final_model \
  --repo-id elizaos/gilgamesh-test-h100 \
  --private \
  --base-model Qwen/Qwen2.5-14B-Instruct
```

---

### Test 2.4: Benchmark on RunPod (Quick)

**Goal**: Run quick benchmark on cloud GPU.

```bash
cd packages/training/deploy/runpod

# Benchmark the model we trained locally
python setup.py benchmark \
  --gpu 4090 \
  --hf-model elizaos/gilgamesh-test-3060 \
  --base-model Qwen/Qwen2.5-0.5B-Instruct \
  --quick \
  --spot \
  --community \
  --name gilgamesh-bench-quick

# Monitor
python setup.py list
```

**Estimated Duration**: ~15 min
**Estimated Cost**: ~$0.15

---

### Test 2.5: Benchmark on RunPod (Full Suite)

**Goal**: Run full benchmark suite on H100-trained model.

```bash
cd packages/training/deploy/runpod

# Full benchmark (all scenarios)
python setup.py benchmark \
  --gpu 4090 \
  --hf-model elizaos/gilgamesh-test-h100 \
  --base-model Qwen/Qwen2.5-14B-Instruct \
  --name gilgamesh-bench-full

# Single scenario (specific test)
python setup.py benchmark \
  --gpu 4090 \
  --hf-model elizaos/gilgamesh-test-h100 \
  --base-model Qwen/Qwen2.5-14B-Instruct \
  --scenario bear-market \
  --spot \
  --community \
  --name gilgamesh-bench-bear
```

---

### Test 2.6: Benchmark Base Model (Comparison)

**Goal**: Benchmark untrained base model for comparison.

```bash
cd packages/training/deploy/runpod

# Benchmark base model (public, no HF_TOKEN needed)
python setup.py benchmark \
  --gpu 4090 \
  --hf-model Qwen/Qwen2.5-0.5B-Instruct \
  --base-model Qwen/Qwen2.5-0.5B-Instruct \
  --quick \
  --spot \
  --community \
  --name baseline-qwen

# This gives us a baseline to compare trained models against
```

---

### Test 2.7: Cleanup

**Goal**: Terminate all test pods.

```bash
cd packages/training/deploy/runpod

# List all pods
python setup.py list

# Stop each pod
python setup.py stop <pod-id-1>
python setup.py stop <pod-id-2>
# ... etc

# Verify all stopped
python setup.py list
```

---

## Phase 3: Makefile Validation

**Goal**: Verify all Makefile targets work.

### Environment for Phase 3

```bash
# Same as Phase 1, just ensure deploy/.env is configured
cd packages/training
set -a && source deploy/.env && set +a
```

---

### Test 3.1: Docker Build Targets

```bash
cd packages/training

# Build targets
make docker-base TAG=0.2.1 ORG=revlentless
make docker-training TAG=0.2.1 ORG=revlentless
make docker-benchmark TAG=0.1.0 ORG=revlentless

# Verify
docker images | grep babylon
```

---

### Test 3.2: Local Training Targets

```bash
cd packages/training

# Local training (uses run.sh under the hood)
make local-train STEPS=5 PROFILE=12gb MIN_AGENTS=1

# Local shell
make local-shell
# Inside: run nvidia-smi, then exit
```

---

### Test 3.3: Local Benchmark Targets

```bash
cd packages/training

# Quick benchmark
make local-benchmark-quick MODEL=gilgamesh-local-001 BASE_MODEL=Qwen/Qwen2.5-0.5B-Instruct

# Full benchmark
make local-benchmark MODEL=gilgamesh-local-001 BASE_MODEL=Qwen/Qwen2.5-0.5B-Instruct
```

---

### Test 3.4: Help and Info

```bash
cd packages/training

# Show all available targets
make help

# Verify all sections are documented
```

---

## Success Criteria

### Phase 1 (Local) Checklist

- [ ] **1.1** Training completes: `trained_models/gilgamesh-local-001/` exists with model files
- [ ] **1.2** Dataset created locally: `hf_dataset_raw/` exists
- [ ] **1.2** Dataset pushed: `elizaos/enkidu-trajectories-raw` on HF with `raw` split
- [ ] **1.3** HF dataset training works: No "Empty batch" errors
- [ ] **1.4** Model pushed: `elizaos/gilgamesh-test-3060` on HF
- [ ] **1.5** Local benchmark runs: JSON report in `benchmark-results/`
- [ ] **1.6** HF model benchmark runs: Can pull and benchmark HF model
- [ ] **1.7** Full benchmark suite: All 4 scenarios complete
- [ ] **1.8** Interactive shells work for both training and benchmark

### Phase 2 (RunPod) Checklist

- [ ] **2.1** Images pushed to Docker Hub
- [ ] **2.2** 4090 training pod runs with HF dataset (not DB)
- [ ] **2.3** H100 training pod runs, model pushed to `elizaos/gilgamesh-test-h100`
- [ ] **2.4** Quick benchmark pod runs
- [ ] **2.5** Full benchmark pod runs
- [ ] **2.6** Baseline benchmark runs (untrained model)
- [ ] **2.7** All pods cleaned up

### Phase 3 (Makefile) Checklist

- [ ] **3.1** Docker build targets work
- [ ] **3.2** Local training targets work
- [ ] **3.3** Local benchmark targets work
- [ ] **3.4** Help text is accurate and complete

### Final Artifacts

After all tests, you should have:

| Artifact | Location |
|----------|----------|
| Local model | `trained_models/gilgamesh-local-001/` |
| Raw dataset (GRPO) | `elizaos/enkidu-trajectories-raw` (HF) |
| Local trained model | `elizaos/gilgamesh-test-3060` (HF) |
| Cloud trained model | `elizaos/gilgamesh-test-h100` (HF) |
| Benchmark results | `benchmark-results/*.json` |

---

## Troubleshooting Guide

### Common Issues

| Issue | Symptom | Fix |
|-------|---------|-----|
| CUDA OOM | `OutOfMemoryError` | Use smaller profile (`12gb`) |
| vLLM won't start | Container exits immediately | Check `nvidia-smi`, driver ≥550 |
| Empty batches | `Empty batch, skipping step` | Use `--min-agents 1` or check dataset format |
| No training steps | `NO SUCCESSFUL TRAINING STEPS` | Data quality issue - check scoring |
| HF push fails | `401 Unauthorized` | Export `HF_TOKEN` |
| HF dataset not found | `404 Not Found` | Check repo exists, token valid for private repos |
| RunPod API error | `Set RUNPOD_API_KEY` | Add to `.env` file |
| Database timeout | `connection refused` | Check DATABASE_URL, allow IP |
| Wrong base model | vLLM errors or poor results | Match `--base-model` to training profile |
| JSON parse errors | `Failed to parse JSON` | Expected for untrained models |

### Debug Commands

```bash
# ============================================
# Local Debugging
# ============================================

# Check GPU status
nvidia-smi

# Check Docker GPU access
docker run --rm --gpus all nvidia/cuda:12.4-base-ubuntu22.04 nvidia-smi

# Check container logs
docker ps
docker logs <container-id> 2>&1 | tail -100

# Check database connection
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM trajectories;"

# Check trajectory data quality
psql "$DATABASE_URL" -c 'SELECT COUNT(*) FROM trajectories WHERE "stepsJson" IS NOT NULL;'

# Check HF auth
huggingface-cli whoami

# Check HF token is set
echo $HF_TOKEN | head -c 10

# ============================================
# Inside Container Debugging
# ============================================

# Start interactive shell
./deploy/local/run.sh --interactive --env-file ../.env

# Inside container:
nvidia-smi                                    # GPU visible?
python3 -c "import torch; print(torch.cuda.is_available())"  # CUDA works?
env | grep -E "(DATABASE|HF_|WANDB|TRAJECTORY)"  # Env vars set?
curl http://localhost:9001/health             # vLLM running?

# ============================================
# RunPod Debugging
# ============================================

# List pods
python deploy/runpod/setup.py list

# Check logs (opens web console)
python deploy/runpod/setup.py logs <pod-id>

# SSH into pod (from RunPod console)
# Then check same things as container debugging above
```

### Specific Error Solutions

**"Empty batch, skipping step" on every step**
```bash
# Your windows have only 1 trajectory each. Options:
# 1. Use --min-agents 1 or --min-agents-per-window 1
./run.sh --min-agents 1 ...

# 2. Or check your dataset has enough trajectories per window
psql "$DATABASE_URL" -c 'SELECT "windowId", COUNT(*) FROM trajectories GROUP BY "windowId" ORDER BY COUNT(*) DESC LIMIT 10;'
```

**"NO SUCCESSFUL TRAINING STEPS - model NOT saved"**
```bash
# All scores are identical or data quality issue
# Check your scoring logic produces different scores
# Check dataset has varied trajectories
```

**"Model not saving to host"**
```bash
# Check volume mount path. Should be:
# -v "$TRAINING_DIR/trained_models:/app/python/trained_models"
```

**"HF dataset not loading" on RunPod**
```bash
# RunPod can't see local databases! Use --hf-dataset:
python setup.py train --hf-dataset elizaos/enkidu-trajectories-raw ...

# Also ensure HF_TOKEN is in your .env file for private datasets
```

**"vLLM request failed - Failed to parse JSON" repeatedly**
```bash
# This is expected for untrained/poorly trained models
# The model is not outputting valid JSON actions
# This is a training quality issue, not infrastructure
```

**"CUDA 12.9 required, please update driver"**
```bash
# Your driver is too old. Update to 570+:
sudo apt update
sudo apt install cuda-drivers-570
sudo reboot
```

---

## Notes

### Before Testing

- [ ] Verify `elizaos` HuggingFace org access
- [ ] Ensure RunPod account has credits (~$5 needed)
- [ ] Create HF repos ahead of time (or let scripts create them)

### Dataset Format Reminder

| Format | Split Name | Use Case |
|--------|------------|----------|
| `raw` | `raw` | GRPO training (what we use) |
| `preferences` | `preferences` | DPO training |
| `sft` | `sft` | Supervised fine-tuning |

The training pipeline expects `raw` format by default.

### Base Model Matching

**Critical**: The base model must match between training and benchmarking!

| Profile | Training Base Model | Benchmark `--base-model` |
|---------|---------------------|--------------------------|
| `12gb` | `Qwen/Qwen2.5-0.5B-Instruct` | `Qwen/Qwen2.5-0.5B-Instruct` |
| `24gb` | `Qwen/Qwen2.5-3B-Instruct` | `Qwen/Qwen2.5-3B-Instruct` |
| `h100` | `Qwen/Qwen2.5-14B-Instruct` | `Qwen/Qwen2.5-14B-Instruct` |

---

## Estimated Time

| Phase | Tests | Duration |
|-------|-------|----------|
| Prerequisites | Setup, builds | 30 min |
| Phase 1.1-1.2 | Training + Dataset | 30 min |
| Phase 1.3-1.4 | HF training + Push | 30 min |
| Phase 1.5-1.8 | Benchmarks + Shell | 1 hour |
| Phase 2.1-2.3 | RunPod training | 1.5 hours |
| Phase 2.4-2.7 | RunPod benchmarks | 1 hour |
| Phase 3 | Makefile | 30 min |
| **Total** | | **~5-6 hours** |

---

## Cost Estimate (RunPod)

| Test | GPU | Type | Duration | Est. Cost |
|------|-----|------|----------|-----------|
| 2.2 Training | 4090 | Spot | ~30 min | ~$0.25 |
| 2.3 Training | H100 | On-demand | ~45 min | ~$3.00 |
| 2.4 Benchmark | 4090 | Spot | ~15 min | ~$0.15 |
| 2.5 Benchmark | 4090 | On-demand | ~30 min | ~$0.25 |
| 2.6 Baseline | 4090 | Spot | ~15 min | ~$0.15 |
| **Total** | | | | **~$4-5** |

---

## Quick Reference

### Model Names

```
elizaos/gilgamesh-test-3060    # Local RTX 3060 trained (Qwen2.5-0.5B base)
elizaos/gilgamesh-test-h100    # RunPod H100 trained (Qwen2.5-14B base)
elizaos/gilgamesh-v0.1         # First production model (future)
```

### Dataset Names

```
elizaos/enkidu-trajectories-raw   # GRPO training (raw format)
elizaos/enkidu-trajectories-test  # Small test dataset
```

### Docker Images

```
revlentless/babylon-base:0.2.1
revlentless/babylon-training:0.2.1
revlentless/babylon-benchmark:0.1.0
```

### Key Directories

```
packages/training/
├── deploy/.env                    # Master environment file
├── trained_models/                # Model outputs
│   └── gilgamesh-local-001/
├── benchmark-results/             # Benchmark JSON reports
├── hf_dataset_raw/                # Temporary dataset export
└── logs/                          # Training logs
```

### Quick Commands

```bash
# Local training (DB source)
./deploy/local/run.sh --profile 12gb --steps 5 --min-agents 1 --env-file deploy/.env

# Local training (HF source)
./deploy/local/run.sh --profile 12gb --steps 5 --min-agents 1 --env-file deploy/.env --hf-dataset elizaos/enkidu-trajectories-raw

# Local benchmark
./deploy/local/benchmark.sh --model gilgamesh-local-001 --base-model Qwen/Qwen2.5-0.5B-Instruct --quick

# RunPod training (always use --hf-dataset!)
python deploy/runpod/setup.py train --gpu h100 --hf-dataset elizaos/enkidu-trajectories-raw --min-agents-per-window 1 --env-file ../.env

# Push model
python python/scripts/hf/push_model_to_hf.py --adapter-path ./trained_models/gilgamesh-local-001 --repo-id elizaos/gilgamesh-test --base-model Qwen/Qwen2.5-0.5B-Instruct
```
