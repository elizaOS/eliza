# Local Fine-Tuning Pipeline

This directory contains scripts to train RL adapters from Babylon simulation logs.

## Workflow

1. **Generate Data:** Run `bun packages/engine/examples/generate-training-data.ts`
2. **Score & Format:** Run `python ingest_and_score.py`
3. **Train:** Run `python train_from_csv.py`
4. **Test:** Run `python test_adapter.py`

## Quick Start

If you do not have a local Postgres database, Atropos server, or vLLM instance running, you can use the **Offline Pipeline**. This generates data to JSON files and uses direct PyTorch/HuggingFace libraries for training.

### Prerequisites

1. `GROQ_API_KEY` or `OPENAI_API_KEY` set in environment.
2. Python dependencies: `pip install torch transformers peft pandas datasets trl`

### Step 1: Generate Data (TypeScript)

Runs the game simulation in-memory and dumps "Observation -> Action" logs to JSON.

```bash
# Runs 24 simulated hours
bun packages/engine/examples/generate-training-data.ts
```

_Output:_ `training-data-output/trajectories/*.json`

### Step 2: Process & Score (Python)

Converts raw JSON logs into a scored CSV dataset (System/User/Assistant format).

```bash
cd packages/training/python/scripts/local-finetune
python ingest_and_score.py
```

_Output:_ `packages/training/data/scored_trajectories.csv`

### Step 3: Train Model (Python)

Fine-tunes a base model (Qwen2.5-0.5B by default) on your scored data using LoRA.

```bash
python train_from_csv.py --output ./my-model-v1
```

### Step 4: Test Inference

Interactively chat with your new LoRA adapter to verify behavior.

```bash
python test_adapter.py
```

---

## 🏗️ Production Architecture (Tinker/Atropos)

_For the full cloud-based pipeline involving Postgres, GRPO, and Tinker compute, refer to `scripts/run_full_pipeline.py`._
