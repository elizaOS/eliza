# elizaOS AgentBench

AgentBench task ingestion and local environment adapters for evaluating elizaOS,
Hermes, and OpenClaw agents. The loader is pinned to upstream commit
`d1e4a10db08c87075c78972e48ecc182be03e2d5`; this package does not yet provide a
publishable replacement for upstream's complete eight-environment runtime.

## What this is - and what it isn't

The pinned task files are staged under `upstream/data/` and verified against
`upstream/SOURCE.json`. Loading official prompts is distinct from reproducing
the official environment. Current execution status is:

| Environment | Wiring | Notes |
|---|---|---|
| Environment | Pinned dev/test tasks | Execution status |
|---|---:|---|
| Operating System (OS) | 26 / 144 | local Docker adapter; upstream parity still needs campaign validation |
| Database (DB) | 60 / 300 | local SQLite adapter; upstream parity still needs campaign validation |
| Knowledge Graph (KG) | 20 / 150 | blocked without the upstream Freebase/Virtuoso service |
| Lateral Thinking Puzzle | 20 / 50 | local heuristic host is not the upstream eval-agent |
| Card Game (Avalon) | 3 / 5 | blocked on the upstream native SDK and card server |
| Householding (ALFWorld) | 20 / 109 | blocked on the ALFWorld package and game corpus |
| Web Shopping (WebShop) | 20 / 500 | blocked on the official WebShop product corpus and simulator |
| Web Browsing (Mind2Web prompt fixtures) | 6 / 6 | six prompt fixtures only, not the full Mind2Web interaction benchmark |

The official test split contains 1,264 base tasks across all eight environments
(13,904 scenarios with the optional ten-variant expansion). `--env all` resolves
to all eight environments for counting and data validation, but full execution
fails before any model call until the four external runtime services above have
publication parity. Compact handwritten tasks remain available only through
explicit `--data-mode fixture` smoke runs; explicit environment selections are
diagnostic partial runs.

## Installation

```bash
cd packages/benchmarks/agentbench
pip install -e .

# Optional extras:
pip install openpyxl   # required to load LTP xlsx data
```

## Quick start

```python
import asyncio
from elizaos_agentbench import (
    AgentBenchRunner,
    AgentBenchConfig,
    AgentBenchDataMode,
    BenchmarkSplit,
    EnvironmentConfig,
)

async def main():
    config = AgentBenchConfig(
        output_dir="./results",
        split=BenchmarkSplit.DEV,        # or BenchmarkSplit.TEST
        save_detailed_logs=True,
        data_mode=AgentBenchDataMode.FULL,
    )
    # Limit task counts during iteration
    config.db_config = EnvironmentConfig(enabled=True, max_tasks=10)
    config.kg_config = EnvironmentConfig(enabled=True, max_tasks=10)
    config.os_config = EnvironmentConfig(enabled=True, max_tasks=5)
    config.lateral_thinking_config = EnvironmentConfig(enabled=True, max_tasks=5)

    runner = AgentBenchRunner(config=config, runtime=my_llm_runtime)
    report = await runner.run_benchmarks()

    for env, env_report in report.environment_reports.items():
        print(f"{env.value:>20}: {env_report.success_rate*100:5.1f}% "
              f"({env_report.passed_tasks}/{env_report.total_tasks})")

asyncio.run(main())
```

## Splits

`AgentBenchConfig.split` accepts `BenchmarkSplit.DEV` (small validation
slice, fast) or `BenchmarkSplit.TEST` (the leaderboard "standard"
split). Per-env file mapping is in
`elizaos_agentbench/upstream_loader.py`.

## Local scoring contracts

The local adapters preserve these task-level checks, but the external runtime
gaps above must be closed before comparing a result with the AgentBench
leaderboard:

- **DB** - compare the agent's final SELECT result set against the
  `label` list from upstream using `DBResultProcessor`-style
  normalization (None→"0", float tolerance 1e-2, comma stripping,
  percentage stripping). Falls back to executing `ground_truth` SQL
  only when no label is supplied.
- **KG** - set equality / F1 against upstream's `gold_ids` /
  `gold_names`.
- **OS** - upstream `match` (exact / regex) or `check` (script-based
  pass/fail).
- **LTP** - matches upstream's BLEU-keyed correctness check on the
  agent's deduced "truth" (汤底).
- **Mind2Web** - letter-based multiple-choice match against the
  upstream prompt fixture's gold reply.

## Vendored upstream

The ignored `upstream/data/` working asset is fetched from
<https://github.com/THUDM/AgentBench> at the revision recorded in
`upstream/SOURCE.json` and hash-verified before full-data loads. See
`upstream/README.md` for the reproducible fetch command.

## Trajectory logging (for training)

```bash
python run_benchmark.py --elizaos --env all --trajectories --trajectory-format art --output ./results
python run_benchmark.py --elizaos --env all --trajectories --trajectory-format grpo --output ./results
```

## Testing

```bash
cd packages/benchmarks/agentbench
pytest                                              # full suite
pytest elizaos_agentbench/tests/test_upstream_loader.py  # loader smoke
pytest elizaos_agentbench/tests/test_upstream_scoring.py # scoring smoke
```

## Architecture

```
elizaos_agentbench/
  types.py                     # AgentBenchTask, *Config, BenchmarkSplit, baselines
  upstream_loader.py           # loaders for the vendored upstream data
  runner.py                    # AgentBenchRunner: dispatch -> adapters -> report
  eliza_harness.py             # ElizaOS bridge adapter (used by run_benchmark.py)
  benchmark_actions.py         # compatibility shims for the legacy Python Eliza
  adapters/
    base.py
    db_adapter.py
    kg_adapter.py
    os_adapter.py
    lateral_thinking_adapter.py
    webshop_adapter.py
    card_game_adapter.py
    householding_adapter.py
    web_browsing_adapter.py
  tests/                       # 65+ tests; pytest under Python 3.12
upstream/                      # vendored THUDM/AgentBench (Apache 2.0)
```

## References

- [AgentBench Paper (ICLR 2024)](https://arxiv.org/abs/2308.03688)
- [AgentBench GitHub](https://github.com/THUDM/AgentBench)
- [AgentBench Leaderboard](https://llmbench.ai/agent/data)

## License

MIT License for this package (see `LICENSE`). The vendored upstream
is Apache 2.0; see `upstream/LICENSE`.
