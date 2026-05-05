# Training Pipeline Scripts

## Active Pipeline (top-level)

These scripts form the canonical training pipeline:

| Script | Purpose |
|--------|---------|
| `run_pipeline.py` | **Main entry point** — orchestrates SFT → eval → RL → ScamBench |
| `run_full_pipeline.py` | Local SFT/data-prep stage (called by run_pipeline) |
| `run_training.py` | RL training orchestrator (Atropos API + vLLM) |
| `run_rlvr_pipeline.py` | Scam-defense RLVR pipeline |
| `run_online_rl.py` | Online continuous RL training |
| `run_proof_pipeline.py` | End-to-end proof pipeline |
| `run_tinker_training.py` | Tinker cloud training entry point |
| `test_pipeline.py` | Training stack preflight validator |
| `train_local.py` | Unified local training (MLX + CUDA) |
| `run_scambench_local.py` | Local ScamBench evaluation |
| `run_trust_benchmark_local.py` | Local trust benchmark evaluation |
| `run_hermes_scambench_local.py` | ScamBench via Hermes agent runtime |
| `run_hermes_trust_benchmark_local.py` | Trust benchmark via Hermes runtime |
| `compare_local_models.py` | Base vs trained model comparison |
| `compare_served_models.py` | Served model comparison (MLX HTTP) |
| `auto_enrich_from_scambench.py` | Auto-boost regressed categories |
| `ingest_datasets_corpus.py` | Import from workspace datasets/ pipeline |
| `scam_defense_exchange.py` | Shared data exchange utilities |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `data-prep/` | Data materialization, generation, assembly, dedup (18 scripts) |
| `releases/` | Release management and health checks (5 scripts) |
| `analysis/` | Trajectory analysis, debugging, auditing (6 scripts) |
| `tools/` | Standalone utilities, proxies, validators (10 scripts) |
| `hf/` | HuggingFace dataset/model upload (2 scripts) |
| `local-finetune/` | Quick local fine-tuning workflow (4 scripts) |

## Running

```bash
# Full canonical pipeline
python scripts/run_pipeline.py --source-dir /path/to/corpus

# Online RL (requires bridge server)
cd packages/sim && bun run bridge-server  # Terminal 1
python scripts/run_online_rl.py --mode single  # Terminal 2

# ScamBench evaluation
python scripts/run_scambench_local.py --model Qwen/Qwen3.5-4B

# Ingest from workspace datasets/ pipeline
python scripts/ingest_datasets_corpus.py --mix balanced
```
