# ElizaOS AgentBench

A faithful re-implementation of [AgentBench](https://github.com/THUDM/AgentBench)
(THUDM, ICLR 2024) for evaluating ElizaOS / Hermes / OpenClaw agents
against the official AgentBench task data and scoring contracts.

## What this is - and what it isn't

This package runs the **official AgentBench dev / test splits** that
are vendored under `upstream/`. The eight environments are wired
end-to-end:

| Environment | Wiring | Notes |
|---|---|---|
| Operating System (OS) | full | uses upstream `os_interaction/data/{dev,1..7}` |
| Database (DB) | full | upstream `dbbench/{dev,standard}.jsonl`, label-based result-set scoring |
| Knowledge Graph (KG) | partial | reads upstream `knowledgegraph/{dev,std}.json`; full SPARQL backend requires Virtuoso (`AGENTBENCH_KG_SPARQL_URL`) |
| Lateral Thinking Puzzle | full | upstream xlsx (`dev`, `standard`); local heuristic host when no eval-agent is configured |
| Card Game (Avalon) | stub | upstream native AI SDK is not vendored; set `AGENTBENCH_CARD_GAME_BIN` to enable |
| Householding (ALFWorld) | lazy | needs `pip install alfworld && alfworld-download` + `ALFWORLD_DATA` |
| Web Shopping (WebShop) | lazy | needs the WebShop product corpus (`WEBSHOP_DATA_DIR`) |
| Web Browsing (Mind2Web) | full (single-turn) | uses upstream's prompt fixtures; full HTML-trace eval via `packages/benchmarks/mind2web` |

> **Scores are run on upstream's official dev/test sets.** No
> hand-written sample tasks remain in this package - the previous
> `SAMPLE_PRODUCTS`, `SAMPLE_ENTITIES`, and 3-puzzle LTP fixture have
> all been removed. Per-env task counts come straight from the
> vendored upstream data (DB dev: 60, DB test: 300; KG dev: ~50, KG
> test: ~1200; OS dev: ~26, OS test: aggregated across 7 categories;
> LTP dev/standard from xlsx; etc.).
>
> Compare your numbers against the public AgentBench leaderboard:
> <https://llmbench.ai/agent/data>.

## Installation

```bash
cd packages/benchmarks/agentbench
pip install -e .

# Optional extras:
pip install openpyxl   # required to load LTP xlsx data
pip install alfworld   # full ALFWorld evaluation
```

## Quick start

```python
import asyncio
from elizaos_agentbench import (
    AgentBenchRunner,
    AgentBenchConfig,
    BenchmarkSplit,
    EnvironmentConfig,
)

async def main():
    config = AgentBenchConfig(
        output_dir="./results",
        split=BenchmarkSplit.DEV,        # or BenchmarkSplit.TEST
        save_detailed_logs=True,
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

## Scoring contracts

Each adapter mirrors upstream's scoring code:

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

Everything in `upstream/` comes from
<https://github.com/THUDM/AgentBench> under Apache 2.0. See
`upstream/LICENSE` and `upstream/README.md`.

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
  benchmark_actions.py         # compatibility stubs for the legacy Python Eliza
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
