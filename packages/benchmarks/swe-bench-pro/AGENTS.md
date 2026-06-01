# SWE-bench Pro — Agent Guide

Vendored upstream harness for the ScaleAI SWE-bench Pro benchmark (arXiv:2509.16941).
Evaluates agents on long-horizon "resolve a real GitHub issue" tasks across 41
actively-maintained business/B2B repos (NodeBB, Element, Tutao, etc.). 731 instances
on the public split; Pass@1 frontier ~23% (GPT-5). Not yet registered in the suite
registry — integration notes are in `INTEGRATION.md`.

## Run

The evaluator is a three-step pipeline — agent → gather → eval:

```bash
# Step 1: generate patches (bring your own agent scaffold)
# Output: a directory of <instance_id>/<prefix>.pred files

# Step 2: collect predictions into one JSON
python helper_code/gather_patches.py \
    --directory <path_to_pred_files> \
    --prefix <run_id> \
    --output patches.json

# Step 3: evaluate against Docker images via Modal (recommended)
python swe_bench_pro_eval.py \
    --raw_sample_path=helper_code/sweap_eval_full_v2.jsonl \
    --patch_path=patches.json \
    --output_dir=<output_dir> \
    --scripts_dir=run_scripts \
    --num_workers=100 \
    --dockerhub_username=jefzda

# Step 3 (alternative): evaluate using local Docker (no Modal account needed)
python swe_bench_pro_eval.py \
    --raw_sample_path=helper_code/sweap_eval_full_v2.jsonl \
    --patch_path=patches.json \
    --output_dir=<output_dir> \
    --scripts_dir=run_scripts \
    --use_local_docker \
    --dockerhub_username=jefzda
```

Sanity-check with the gold patches from the HuggingFace dataset:

```bash
python helper_code/extract_gold_patches.py  # writes gold_patches.json
python swe_bench_pro_eval.py \
    --raw_sample_path=helper_code/sweap_eval_full_v2.jsonl \
    --patch_path=gold_patches.json \
    --output_dir=gold_eval_out \
    --scripts_dir=run_scripts \
    --use_local_docker \
    --dockerhub_username=jefzda
```

## Prerequisites

```bash
pip install -r requirements.txt   # pandas, tqdm, datasets, modal, docker, huggingface_hub
modal setup                        # only for the Modal path
# Docker daemon must be running for --use_local_docker
```

## Test the harness

No pytest suite is bundled with this upstream vendor copy. The canonical verification
step is running the gold-patch eval above and confirming `eval_results.json` shows
near-100% resolve rate.

## Layout

| Path | Role |
| --- | --- |
| `swe_bench_pro_eval.py` | Evaluator entrypoint — reads patches JSON, runs each instance in Docker, writes `eval_results.json` |
| `helper_code/gather_patches.py` | Collects `.pred` files → single patches JSON |
| `helper_code/extract_gold_patches.py` | Extracts gold patches from HuggingFace dataset for baseline check |
| `helper_code/create_problem_statement.py` | Canonical problem-statement prompt formatter (use in adapter) |
| `helper_code/sweap_eval_full_v2.jsonl` | Vendored 731-instance public-split dataset (24 MB) |
| `run_scripts/` | Per-instance `run_script.sh` + `parser.py` (test invocation + result parsing) |
| `dockerfiles/` | Per-instance Dockerfiles — used to harvest ENV vars; actual images are on Docker Hub |
| `traj/` | Published Pass@1 `eval_results.json` for leaderboard runs (reference only) |
| `error_analysis/` | Scale's labeled failure-mode CSVs for claude_sonnet_4 and gpt-4o (reference only) |
| `INTEGRATION.md` | Architecture notes for wiring this into the elizaOS adapter + registry |

## Notes

- Results write to `<output_dir>/eval_results.json` (`{instance_id: bool}`) plus
  per-instance `*_stdout.log`, `*_stderr.log`, `*_output.json`, `*_patch.diff`.
- Not yet scored via `registry/scores.py` — see `INTEGRATION.md` for the wiring plan.
- Docker images are public at `docker.io/jefzda/sweap-images:<dockerhub_tag>`;
  full public split pulls ~hundreds of GB — cache aggressively.
- Apple Silicon: evaluator auto-sets `--platform linux/amd64`; expect ~3–5x slowdown.
- Held-out and commercial splits are not runnable locally — submit to Scale's hosted grader.
- Full background: [README.md](README.md) and [INTEGRATION.md](INTEGRATION.md).
