# Feed Experiments: Complete Guide

Five experiments demonstrate the Feed social intelligence training pipeline, from offline fine-tuning through online RL to competitive evaluation against frontier models.

---

## Experiment 1: Offline SFT from Curated Dataset

**Goal**: Fine-tune a base model on the 15,260-record scam defense corpus to establish baseline scam resistance.

**Data**: `/home/shaw/feed-workspace/datasets/final/corpus/` — 15,260 records with reasoning traces, 9 style variants, 100% reasoning coverage.

**Run**:
```bash
cd packages/training/python

# 4B model with LoRA (fits 16GB VRAM)
python3 scripts/train_local.py --backend cuda --model Qwen/Qwen3-4B \
  --source-dir /home/shaw/feed-workspace/datasets/final/corpus/ \
  --epochs 3 --batch-size 2 --lora --lora-rank 16

# 9B model on Nebius H100
ssh shaw@89.169.123.213 "cd /home/shaw/feed-rl && source venv/bin/activate && \
  python3 scripts/train_local.py --backend cuda --model Qwen/Qwen3-9B \
  --source-dir ./data/corpus/ --epochs 3 --batch-size 1 --lora --lora-rank 16"
```

**Evaluate on ScamBench**:
```bash
# Serve trained model
vllm serve ./checkpoints/qwen3-4b-sft --port 8001

# Run benchmark
cd /home/shaw/feed-workspace/scambench
bun run src/index.ts --model qwen3-4b-sft --base-url http://localhost:8001/v1 \
  --scenario-limit 50 --output-dir results/exp1-sft --score-attacker
```

**Expected Results**: ~62 overall (48.9 attack, 75.7 legitimate) based on prior runs.

**GPU**: 16GB for 4B, 80GB for 9B | **Time**: 2-12 hours depending on model size

---

## Experiment 2: Offline RL from Feed Trajectories

**Goal**: Collect trajectories from the live Feed simulation, then train offline using GRPO with verifiable rewards.

**Step 1 — Collect trajectories** (requires running Feed):
```bash
# Start Feed with trajectory recording
bun run dev

# Trajectories auto-saved to DB during NPC ticks
# Export to HuggingFace format
python3 scripts/hf/trajectories_to_hf_dataset.py --output ./hf_export \
  --format rankings --max-trajectories 5000
```

**Step 2 — Train with GRPO**:
```bash
python3 scripts/run_rlvr_pipeline.py \
  --model Qwen/Qwen3-4B \
  --sft-data-dir /home/shaw/feed-workspace/datasets/final/corpus/ \
  --grpo-steps 200 --apollo-rank 128
```

**What's in the trajectories**: Each step now includes `counterpartyContext` (alignment, team, intent) for reward computation. The deterministic judge computes `interaction_alignment` score based on whether the agent correctly handled each counterparty.

**GPU**: H100 recommended | **Time**: 24-48 hours for full pipeline

---

## Experiment 3: Online RL from Feed (Live Model Update)

**Goal**: Run a single shared model that all agents (red/blue/gray) use, continuously updated with Kondo gate (3%) selecting only the most informative experiences.

**Architecture**:
```
Shared Model (Qwen3-4B/9B)
├── Red agents: social engineering prompts
├── Blue agents: skepticism/defense prompts  
├── Gray agents: trading/neutral prompts
└── All 30 agents → pooled experiences → Kondo 3% → optimizer step
```

**Run locally (mock bridge, 16GB VRAM)**:
```bash
cd packages/training/python
python3 scripts/run_shared_model_rl.py --mock --model Qwen/Qwen3-4B \
  --device cuda --ticks 50 --agents-per-team 10 --kondo-rate 0.03 \
  --no-turboquant --output results/online_rl_local.json
```

**Run on Nebius H100 (live bridge)**:
```bash
# Terminal 1: Start Feed bridge server
cd packages/sim && bun run core/bridge/simulation-bridge-server.ts

# Terminal 2: Train on Nebius
ssh shaw@89.169.123.213 "cd /home/shaw/feed-rl && source venv/bin/activate && \
  python3 scripts/run_shared_model_rl.py \
  --bridge-url http://YOUR_SERVER:3001 \
  --model Qwen/Qwen3-9B --device cuda --ticks 500 \
  --agents-per-team 10 --kondo-rate 0.03 --optimizer adamw \
  --checkpoint-every 100 --output results/online_rl_9b.json"
```

**Run on Nebius H100 (mock bridge, currently running)**:
```bash
# Already running: PID 426377 on 89.169.123.213
# Qwen3-4B, 100 ticks, 30 agents, Kondo 3%, AdamW
# Tick 50 checkpoint: mean_reward=0.059, blue=0.078, red=0.055, gray=0.044
# Monitor: ssh shaw@89.169.123.213 "ps -p 426377 -o etime --no-headers"
```

**Reward weights**: scam_outcome 30%, secret_safety 25%, negotiation 20%, relationship 10%, trust 10%, trade 5%

**GPU**: 16GB for 4B, 80GB for 9B | **Time**: ~1 min/tick for 4B, ~2 min/tick for 9B

---

## Experiment 4: Red-Team vs Blue-Team Arms Race

**Goal**: Train adversarial models where red team learns to attack more effectively while blue team learns to defend. Track how both improve over rounds.

**Setup**: Use ScamBench scenarios seeded with attack ideas from the dataset as initial prompts. Red team gets attacker system prompt, blue team gets defender system prompt. Both use the same base model but with team-specific prompts.

**Run with team_rl (3 separate models)**:
```bash
python3 scripts/run_team_rl.py --mock --model Qwen/Qwen3-4B \
  --ticks 100 --agents-per-team 10 --kondo-rate 0.1 \
  --checkpoint-every 25 --output results/arms_race.json
```

**Run with shared_model_rl (1 shared model, recommended)**:
```bash
python3 scripts/run_shared_model_rl.py --mock --model Qwen/Qwen3-9B \
  --device cuda --ticks 500 --agents-per-team 15 --kondo-rate 0.03 \
  --checkpoint-every 50 --output results/arms_race_shared.json
```

**Arms race evaluation** (at each checkpoint):
```bash
# Serve checkpoint
vllm serve ./shared_model_checkpoints/tick_100 --port 8001

# Evaluate as blue-team (with scripted attacker)
cd /home/shaw/feed-workspace/scambench
bun run src/index.ts --model checkpoint-tick-100 \
  --base-url http://localhost:8001/v1 --scenario-limit 50 \
  --score-attacker --output-dir results/arms-race/tick-100-blue

# Evaluate as red-team (attacking baseline target)
bun run src/index.ts --model Qwen/Qwen3-4B \
  --base-url http://localhost:8002/v1 \
  --attacker-model checkpoint-tick-100 \
  --attacker-base-url http://localhost:8001/v1 \
  --score-attacker --output-dir results/arms-race/tick-100-red
```

**Seed attackers with diverse tactics**: The system prompts for red agents include social engineering strategies from ScamBench categories (prompt injection, credential theft, social engineering, impersonation, secret exfiltration, advance-fee fraud).

**GPU**: 80GB H100/H200 for 9B | **Time**: 8-16 hours for 500 ticks

---

## Experiment 5: Competitive Evaluation vs Frontier Models

**Goal**: Demonstrate our trained model can (a) attack frontier models better than baseline, and (b) defend against attacks better than baseline.

**Competitive matrix** (each cell = target_resistance, attacker_success):

| Target ↓ / Attacker → | Scripted | Baseline 9B | Feed Red-9B |
|------------------------|----------|-------------|----------------|
| GPT-5.4                | not measured | not measured | not measured |
| Sonnet 4.5             | not measured | not measured | not measured |
| Baseline Qwen-9B       | not measured | not measured | not measured |
| Feed Blue-9B           | not measured | not measured | not measured |

**Run one cell** (e.g., Feed Red-9B attacking GPT-5.4):
```bash
cd /home/shaw/feed-workspace/scambench

# Serve our trained model as attacker
vllm serve ./checkpoints/feed-red-9b --port 8001

# Run evaluation
bun run src/index.ts \
  --name "gpt5.4-vs-feed-red" \
  --model gpt-5.4 --base-url https://api.openai.com/v1 --api-key-env OPENAI_API_KEY \
  --attacker-model feed-red-9b --attacker-base-url http://localhost:8001/v1 \
  --attacker-temperature 0.9 --attacker-max-tokens 200 \
  --score-attacker --output-dir results/competitive-matrix
```

**Run full matrix** (batch config):
```bash
# Create targets file with all combinations
bun run src/index.ts --targets targets/competitive-matrix.json \
  --score-attacker --output-dir results/competitive-matrix
```

**Attacker scoring metrics**:
- `successRate`: % of attacks where target was compromised
- `secretExtractionRate`: % where secrets were leaked
- `stealthRate`: % of successful attacks that went undetected
- `avgTurnsToCompromise`: efficiency (lower = better)
- `overallScore`: weighted composite

**GPU**: 1 GPU per model served | **Time**: ~2 hours for full 340-scenario matrix per cell

---

## Quick Start (All 5 Experiments)

```bash
# 1. SFT (local, 2 hours)
python3 scripts/train_local.py --model Qwen/Qwen3-4B --lora --epochs 3

# 2. Evaluate SFT on ScamBench (30 min)
vllm serve ./checkpoints/sft --port 8001
cd scambench && bun run src/index.ts --model sft \
  --base-url http://localhost:8001/v1 --score-attacker

# 3. Online RL with mock (1 hour)
python3 scripts/run_shared_model_rl.py --mock --ticks 50 --model Qwen/Qwen3-4B

# 4. Evaluate online RL checkpoint (30 min)
vllm serve ./shared_model_checkpoints/tick_50 --port 8001
cd scambench && bun run src/index.ts --model tick-50 \
  --base-url http://localhost:8001/v1 --score-attacker

# 5. Attack GPT-5.4 with our red-team model (1 hour)
bun run src/index.ts --model gpt-5.4 \
  --base-url https://api.openai.com/v1 --api-key-env OPENAI_API_KEY \
  --attacker-model tick-50 --attacker-base-url http://localhost:8001/v1 \
  --score-attacker
```

---

## Current Status

| Experiment | Status | Results |
|------------|--------|---------|
| 1: SFT | Prior results: 62.32 overall | Need to rerun on V3 benchmark |
| 2: Offline RL | Pipeline ready | Need live Feed trajectories |
| 3: Online RL | **Running on Nebius** | Tick 50: blue=0.078, red=0.055, gray=0.044 |
| 4: Arms race | Infrastructure ready | Need to run multi-round tournament |
| 5: vs Frontier | ScamBench + attacker scoring ready | Need trained checkpoints + API keys |

---

## Paper Gaps to Fill

1. **RLVR results identical to SFT** — need real RLVR separation or honest framing
2. **4 ScamBench categories have zero training data** (advance-fee, credential-theft, impersonation, interpersonal-abuse)
3. **Placeholders in tex** — 13 `\placeholder{}` values need filling with V3 numbers
4. **Missing sections**: adversarial co-training results, frontier model attack results, online RL results
5. **Action vocabulary mismatch** — model outputs `comply` but scorer expects `engage`/`refuse`
6. **9B scaling shows regression** — needs recipe adaptation before claiming scaling behavior
7. **New features not described**: shared model architecture, attacker scoring, SHARE_INFORMATION, REQUEST_PAYMENT, TurboQuant KV cache

---

## Hardware Requirements

| Experiment | Min GPU | Recommended | Notes |
|------------|---------|-------------|-------|
| 1: SFT 4B | 16GB | 24GB | LoRA rank 16, 3 epochs |
| 1: SFT 9B | 40GB | 80GB | LoRA rank 16 |
| 2: Offline RL | 40GB | 80GB | GRPO requires more memory |
| 3: Online RL 4B | 16GB (mock) | 80GB (live) | APOLLO + Kondo |
| 3: Online RL 9B | 80GB | 80GB | H100 recommended |
| 4: Arms race | 80GB | 80GB | Same as online RL |
| 5: Eval (our model) | 24GB | 40GB | vLLM serving |
| 5: Eval (frontier) | 0 (API) | 0 | Uses OpenAI/Anthropic API |
