# ElizaOS Benchmark Orchestrator

Run any integrated benchmark (or all benchmarks), store normalized results in
SQLite/JSON, and inspect history in the browser viewer.

Use the workspace Python (`/Users/shawwalters/eliza-workspace/.venv/bin/python`)
for consistent dependency versions across benchmark subprocesses.

## Paths

- Results DB: `benchmarks/benchmark_results/orchestrator.sqlite`
- Viewer dataset: `benchmarks/benchmark_results/viewer_data.json`
- Static viewer UI: `benchmarks/viewer/index.html`

## List integrated benchmarks

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator list-benchmarks
```

This verifies adapter coverage for all benchmark directories under `benchmarks/`.

## Run benchmarks idempotently

Run one benchmark:

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator run \
  --benchmarks solana \
  --provider groq \
  --model openai/gpt-oss-120b
```

Run all benchmarks:

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator run \
  --all \
  --provider groq \
  --model openai/gpt-oss-120b
```

Idempotent behavior:

- Existing successful signatures are skipped automatically.
- `--rerun-failed` reruns only signatures whose latest run failed.
- `--force` always creates a fresh run.

Examples:

```bash
# rerun only failed signatures
/opt/miniconda3/bin/python -m benchmarks.orchestrator run --all --rerun-failed --provider groq --model openai/gpt-oss-120b

# force fresh runs
/opt/miniconda3/bin/python -m benchmarks.orchestrator run --all --force --provider groq --model openai/gpt-oss-120b
```

## Extra benchmark config

Use `--extra` with a JSON object for benchmark-specific knobs.
Adapter defaults are applied first, then `--extra` overrides are merged on top.
This keeps `run --all` idempotent with stable per-benchmark baseline settings
while still letting you override knobs when needed.

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator run \
  --benchmarks osworld \
  --provider groq \
  --model openai/gpt-oss-120b \
  --rerun-failed \
  --extra '{"max_tasks":1,"headless":true,"vm_ready_timeout_seconds":21600}'
```

`--extra` also supports a `per_benchmark` object for benchmark-specific overrides
in one `--all` run:

```bash
/Users/shawwalters/eliza-workspace/.venv/bin/python -m benchmarks.orchestrator run \
  --all \
  --agent eliza \
  --provider groq \
  --model openai/gpt-oss-120b \
  --extra "$(cat benchmarks/orchestrator/profiles/sample10.json)"
```

Profile included in repo:

- `benchmarks/orchestrator/profiles/sample10.json` - roughly 10% sampled run
  settings (where the benchmark supports sampling).
- `benchmarks/orchestrator/profiles/orchestrator_subagents.json` - orchestrator
  matrix profile for `swe_bench_orchestrated`, `gaia_orchestrated`, and
  `orchestrator_lifecycle`.

## Orchestrated Subagent Tracks

New orchestrator-centric benchmark IDs:

- `swe_bench_orchestrated`
- `gaia_orchestrated`
- `orchestrator_lifecycle`
- `eliza_replay`

Code matrix example:

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator run \
  --benchmarks swe_bench_orchestrated \
  --provider anthropic \
  --model claude-sonnet-4-6 \
  --extra '{"per_benchmark":{"swe_bench_orchestrated":{"matrix":true,"max_instances":3,"no_docker":true,"strict_capabilities":true}}}'
```

Research matrix example:

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator run \
  --benchmarks gaia_orchestrated \
  --provider groq \
  --model openai/gpt-oss-120b \
  --extra '{"per_benchmark":{"gaia_orchestrated":{"matrix":true,"dataset":"sample","max_questions":10,"strict_capabilities":true}}}'
```

Lifecycle suite example:

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator run \
  --benchmarks orchestrator_lifecycle \
  --provider openai \
  --model gpt-4o \
  --extra '{"per_benchmark":{"orchestrator_lifecycle":{"max_scenarios":12,"strict":true}}}'
```

Replay scoring example (from normalized Eliza capture artifacts):

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator run \
  --benchmarks eliza_replay \
  --provider groq \
  --model openai/gpt-oss-120b \
  --extra '{"per_benchmark":{"eliza_replay":{"capture_path":"/path/to/replays","capture_glob":"*.replay.json"}}}'
```

`capture_path` is required and must point to a file or directory of normalized `*.replay.json` artifacts.

## Viewer

Serve live viewer API + UI:

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator serve-viewer --host 127.0.0.1 --port 8877
```

Open: `http://127.0.0.1:8877/`

Viewer supports:

- Historical runs across all benchmarks.
- Sorting by `agent`, `run_id`, and other columns.
- High-score comparison columns (`high_score`, `delta`).
- Filtering by benchmark/status and text search.

## Rebuild viewer dataset

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator export-viewer-data
```

## Recover stale/interrupted runs

If an orchestrator process is interrupted, rows can remain in `running` state.
Recover them immediately and regenerate the viewer dataset:

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator recover-stale-runs --stale-seconds 0
```

Default behavior only recovers runs older than 300 seconds:

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator recover-stale-runs
```

## Show runs in terminal

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator show-runs --desc --limit 200
```

`show-runs` is sorted by `(agent, run_id)` and is useful for quick auditing.

## Comparing models (A vs B)

Run any benchmark suite against two models and print a side-by-side delta
table. Each side is a separate run group in SQLite, but both runs share a
``comparison_id`` so the comparison can be re-rendered later.

Spec format for ``--a`` / ``--b``: ``<provider>:<model>[@<base_url>]``.
The optional ``@<base_url>`` is forwarded to the provider as an OpenAI-
compatible base URL; for the ``vllm`` provider this points the orchestrator at
a self-hosted vLLM endpoint started via ``vllm serve``.

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator compare \
  --a "vllm:elizaos/eliza-1-2b@http://127.0.0.1:8001/v1" \
  --b "vllm:Qwen/Qwen3.5-2B@http://127.0.0.1:8002/v1" \
  --benchmarks eliza-format,bfcl,realm,context-bench
```

Optional flags:

- ``--max-examples N`` caps work per benchmark (forwarded as
  ``max_examples`` / ``max_tasks`` / ``sample`` so individual adapters pick it
  up however they natively wire sampling).
- ``--temperature 0.0`` (default).
- ``--out <dir>`` — directory for ``compare-<comparison_id>.json``. Defaults
  to ``benchmarks/benchmark_results/comparisons/``.

Output:

```
Comparison ID: cmp_20260504T120000Z_a1b2c3d4
A: vllm:elizaos/eliza-1-2b @ http://127.0.0.1:8001/v1
B: vllm:Qwen/Qwen3.5-2B @ http://127.0.0.1:8002/v1
Benchmarks: eliza-format, bfcl, realm, context-bench

benchmark      | A: vllm:elizaos/eliza-1-2b | B: vllm:Qwen/Qwen3.5-2B | delta (B-A) | winner
---------------+----------------------------+-------------------------+-------------+-------
eliza-format   | 0.9120                     | 0.7430                  | -0.1690     | A
bfcl           | 0.6840                     | 0.6920                  | +0.0080     | B
realm          | 0.5510                     | 0.5310                  | -0.0200     | A
context-bench  | 0.7400                     | 0.7250                  | -0.0150     | A

Wrote benchmarks/benchmark_results/comparisons/compare-cmp_20260504T120000Z_a1b2c3d4.json
```

Re-render a stored comparison:

```bash
/opt/miniconda3/bin/python -m benchmarks.orchestrator view-comparison \
  cmp_20260504T120000Z_a1b2c3d4
```

The ``vllm`` provider name is registered alongside ``openai`` / ``groq`` /
``anthropic``: every benchmark CLI that already accepts ``--provider``
accepts ``--provider vllm``, and the orchestrator forwards
``OPENAI_BASE_URL`` to the per-benchmark subprocess so OpenAI-compatible
clients hit the vLLM endpoint without code changes. Override the default
``http://127.0.0.1:8001/v1`` either via ``@<base_url>`` in the spec, the
``VLLM_BASE_URL`` env var, or the per-run ``vllm_base_url`` extra config.

## Stored metadata per run

Each run stores:

- benchmark ID + directory
- run ID + run group ID + signature + attempt
- status, duration, score, metrics, artifacts
- provider, model, agent label
- extra config used for the run
- benchmark and Eliza commit/version metadata
- high-score reference and delta
