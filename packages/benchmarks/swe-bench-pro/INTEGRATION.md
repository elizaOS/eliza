# SWE-bench Pro — Integration Notes

Upstream: https://github.com/scaleapi/SWE-bench_Pro-os
Dataset: https://huggingface.co/datasets/ScaleAI/SWE-bench_Pro
Paper: arXiv 2509.16941 — "SWE-bench Pro: Can AI Agents Solve Long-Horizon Software Engineering Tasks?"
Public leaderboard: https://scale.com/leaderboard/swe_bench_pro_public

This directory is a cleaned, vendored copy of the upstream public-set repo. Git metadata,
the marketing `index.html`, and the empty `SWE-agent` / `mini-swe-agent` submodule stubs
have been removed. What remains is the eval harness, helper code, run scripts, dockerfiles,
the public dataset jsonl (`helper_code/sweap_eval_full_v2.jsonl`), and the published
trajectory eval-result summaries under `traj/`.

## What it evaluates

Long-horizon "resolve a real GitHub issue" tasks. Each instance is `(codebase @ base_commit, issue text, gold patch, fail-to-pass + pass-to-pass test lists)`. The agent must produce a unified-diff `patch` that, when applied to the repo at `base_commit` and run against the instance's pre-built Docker image, makes the `FAIL_TO_PASS` tests pass and keeps the `PASS_TO_PASS` tests green. Tasks span 41 actively-maintained business / B2B / dev-tool repos (NodeBB, Element, Tutao, etc.). Headline numbers are low — GPT-5 sits at ~23% Pass@1 on the public split. Cost-capped paper runs use ≤$2/instance; the leaderboard variant uses a 250-turn cap with no cost limit.

## How tasks load

- Canonical source: HuggingFace `ScaleAI/SWE-bench_Pro`, split `test`. Loaded via `datasets.load_dataset(...)` — requires `pip install datasets` and a HuggingFace cache (no auth gate on the public split).
- Vendored copy: `helper_code/sweap_eval_full_v2.jsonl` (24MB, 731 instances, public-set only). The evaluator (`swe_bench_pro_eval.py`) accepts either a CSV or a JSONL via `--raw_sample_path` and reads columns: `instance_id`, `repo`, `base_commit`, `before_repo_set_cmd`, `selected_test_files_to_run`, `fail_to_pass`, `pass_to_pass`, `dockerhub_tag` (or derived from `repo`).
- The held-out (12 repos) and commercial (18 repos) splits are NOT in this repo; you submit predictions to Scale's hosted grader.

## Runner-vs-agent contract

This is the key architectural difference from regular SWE-bench: **the evaluator does not host an agent loop.** It takes pre-generated patches as input. The flow is:

1. **Agent (external):** for each instance, the agent is handed `(problem_statement, base_commit, repo @ that commit, image_name)` and must produce a `model_patch` (unified diff). Upstream's reference scaffolds are SWE-agent and mini-swe-agent, both git submodules that the repo author intentionally leaves empty here — you bring your own.
2. **Gather:** `helper_code/gather_patches.py` walks a directory of `instance_*/...pred` files (plain diff or JSON with `model_patch` / `patch` field) and emits one `[{instance_id, patch, prefix}, ...]` JSON list.
3. **Evaluate:** `swe_bench_pro_eval.py` for each instance:
   - Pulls `jefzda/sweap-images:<dockerhub_tag>` (or `<user>/sweap-images:<tag>` if you rehosted).
   - Spins it up via Modal sandbox (`--use_local_docker` swaps to Docker SDK; expect `linux/amd64` emulation on Apple Silicon).
   - Mounts a workspace with `patch.diff`, the instance-specific `run_scripts/<id>/run_script.sh` + `parser.py`, and an entry script that does `git reset --hard <base_commit> && git apply patch.diff && bash run_script.sh ... > stdout.log && python parser.py stdout.log stderr.log output.json`.
   - Reads `output.json` (shape: `{tests: [{name, status: PASSED|FAILED|SKIPPED|ERROR}, ...]}`) and marks the instance as resolved iff `(fail_to_pass ∪ pass_to_pass) ⊆ {tests where status == PASSED}`.

The agent contract is therefore "string in (problem statement + repo handle), string out (unified diff)". No tool-call protocol, no stdin/stdout streaming, no Docker awareness required on the agent side — the agent just needs file-system + shell access to the checked-out repo while authoring the patch.

## Scoring

- Per-instance: boolean `resolved` (all F2P and P2P tests pass after applying the patch).
- Aggregate: `accuracy = resolved / total` (Pass@1 on the public split). Reported alongside cost/turn caps. Output lands in `<output_dir>/eval_results.json` (`{instance_id: bool}`) plus per-instance `*_stdout.log`, `*_stderr.log`, `*_output.json`, `*_patch.diff`, `*_entryscript.sh`.

## Wiring into our adapters

Mirror `eliza-adapter/eliza_adapter/swe_bench.py`, but **the existing TEXT_LARGE-handler shim does not apply here** — that pattern relies on SWE-bench's in-tree agent loop calling a registered model handler each turn. SWE-bench Pro has no such loop. So the integration is two pieces:

1. **`swe_bench_pro.py` in each adapter (`eliza-adapter`, `hermes-adapter`, `openclaw-adapter`)** — a "patch producer". For each instance row from the dataset, build the problem-statement prompt (use `helper_code/create_problem_statement.py` as the canonical formatter), spin up the agent against a fresh clone of `repo@base_commit` inside a workspace, let it produce a diff, and write `<output_dir>/<instance_id>/<prefix>.pred`. The patch producer is what differs across adapters — `eliza-adapter` would drive the elizaOS runtime over HTTP (similar pattern to `client.py`), `hermes-adapter` and `openclaw-adapter` would drive their respective agent shells.
2. **`runner.py` orchestrator entry** in `benchmarks/run.py` / `registry.py`: register a new `swe_bench_pro` id whose `RunSpec` does (a) call the adapter's patch producer to populate a `predictions/` tree, (b) shell out to `python helper_code/gather_patches.py --directory predictions --prefix <run_id> --output patches.json`, (c) shell out to `python swe_bench_pro_eval.py --raw_sample_path helper_code/sweap_eval_full_v2.jsonl --patch_path patches.json --output_dir <out> --scripts_dir run_scripts --dockerhub_username jefzda [--use_local_docker]`, (d) summarize `eval_results.json` into the standard benchmark summary the parser at `registry.py:292` expects (`{summary: {resolve_rate}, ...}`).

Existing `swe_bench.py` files in each adapter remain — they target the original SWE-bench (Verified / Lite). Add `swe_bench_pro.py` alongside; do not overload the existing handler.

## Estimated minutes per task on Cerebras `gpt-oss-120b`

Rough order-of-magnitude only; not measured here.

- Patch generation: SWE-bench Pro tasks are explicitly multi-file, long-horizon. Paper runs use 250 turns at ~hundreds of input tokens / turn. At Cerebras's gpt-oss-120b throughput (~2000 tok/s), a fully utilized 250-turn run is ~3–6 minutes of pure generation, but each turn realistically spends 5–30s in tool I/O (file read, test run, edit). Expect **8–20 min/task** wall-clock for generation, with tail instances (NodeBB, Tutao) drifting past 30 min.
- Evaluation: ~1–5 min/instance in Docker (image pull dominates first time; subsequent runs cache). With Modal at `--num_workers=100` the harness amortizes to ~1 min/instance.
- End-to-end public split (731 instances): plan for **2–5 hours** of generation on a 32-way agent fleet, plus ~30–60 min of evaluation.

`gpt-oss-120b` is well below the leaderboard frontier (the published `gptoss-paper` run is in `traj/gptoss-paper/`). Use the leaderboard's gpt-oss results to bound expectations before burning Cerebras quota on a full run.

## Access gating and prerequisites

- **HuggingFace:** the `test` split is public — no token needed. `datasets` will still want a writable cache dir. Consumers that prefer offline mode can use the vendored `helper_code/sweap_eval_full_v2.jsonl` directly and skip `load_dataset`.
- **Docker images:** `docker.io/jefzda/sweap-images:<tag>` is public and unauthenticated. Plan for ~1–3 GB per image; full public split is ~hundreds of GB if every image is pulled. Use `--use_local_docker` for one-off debugging; use Modal (`modal setup`) for parallel runs at scale.
- **Modal:** `pip install modal` + `modal setup` (token via OAuth). Free tier has compute credits; full eval at `num_workers=100` will burn through them — assume paid plan for serious runs.
- **No external judge model required.** Scoring is purely test-pass/fail; no OpenAI / Anthropic key is needed by the evaluator (only by whichever agent you point at it).
- **Apple Silicon:** evaluator auto-detects arm64 and sets `--platform linux/amd64` for Docker; expect ~3–5x slowdown vs native amd64 hosts.
- **Held-out and commercial splits:** not runnable locally. Submissions go through Scale's hosted leaderboard — out of scope for this integration.

## File map

- `swe_bench_pro_eval.py` — evaluator entry. Reads patches JSON, runs each instance in Docker, writes `eval_results.json`.
- `helper_code/` — `gather_patches.py` (pred → patches.json), `extract_gold_patches.py` (sanity baseline from HF dataset), `create_problem_statement.py` (canonical prompt formatter), `image_uri.py` (instance_id → dockerhub tag), `generate_sweagent_instances.py` (SWE-agent YAML emitter, reference only), `sweap_eval_full_v2.jsonl` (vendored 731-row eval data).
- `run_scripts/instance_<id>/` — `run_script.sh` (per-instance test invocation), `parser.py` (stdout/stderr → `output.json`), `instance_info.txt` (instance metadata).
- `dockerfiles/{base,instance}_dockerfile/instance_<id>/Dockerfile` — read by the evaluator to harvest `ENV` lines (the actual images live on Docker Hub).
- `error_analysis/` — Scale's labeled failure-mode CSVs for `claude_sonnet_4` and `gpt-4o`. Reference only.
- `traj/<run_name>/eval_results.json` — published Pass@1 results for the leaderboard runs. Reference only; full per-turn trajectories live on S3 (`s3://scaleapi-results/swe-bench-pro/`).
- `requirements.txt` — `pandas`, `tqdm`, `datasets`, `modal`, `docker`, `huggingface_hub`.
- `README.md`, `LICENSE` — upstream, unmodified.

## Open questions before wiring

1. Do we want both the `--use_local_docker` and Modal paths exposed via `registry.py`, or pick one for CI?
2. Should the adapters drive only the public 731-instance split, or also support submitting to Scale's held-out grader? (Probably public-only for v1.)
3. Where does the patch-producer workspace live — reuse `swe-bench-workspace/` as a parent or stand up `swe-bench-pro-workspace/` alongside it? (The two splits' Docker images are not interchangeable, so separate workspaces is the cleaner option.)
