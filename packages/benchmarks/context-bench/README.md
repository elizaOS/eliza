# ElizaOS Context Benchmark

A comprehensive benchmark suite for evaluating LLM context retrieval and reasoning capabilities, integrated with the ElizaOS Python runtime.

## Overview

This benchmark evaluates how well language models can:

1. **Needle-in-a-Haystack (NIAH)**: Find specific information embedded in large contexts
2. **Semantic NIAH**: Retrieve information without lexical overlap between question and answer
3. **Multi-hop Reasoning**: Connect multiple pieces of information across the context

## Key Features

- **Position Analysis**: Detect "lost in the middle" effects
- **Context Length Scaling**: Measure performance degradation with longer contexts
- **Semantic Similarity**: Evaluate answers beyond exact matching
- **Leaderboard Comparison**: Compare results to published model scores

## Installation

```bash
# Install the package
cd benchmarks/context-bench/python
pip install -e .

# With optional dependencies for embeddings
pip install -e ".[embeddings]"

# With development dependencies
pip install -e ".[dev]"
```

## Quick Start

### Basic Usage

```python
import asyncio
from elizaos_context_bench import (
    ContextBenchRunner,
    ContextBenchConfig,
    quick_test,
)

# Define your LLM query function
async def my_llm_query(context: str, question: str) -> str:
    # Your LLM API call here
    response = await call_your_llm(f"Context: {context}\n\nQuestion: {question}")
    return response

# Quick test
async def main():
    results = await quick_test(my_llm_query)
    print(f"Overall Accuracy: {results.metrics.overall_accuracy:.1%}")
    print(f"Lost in Middle Score: {results.metrics.lost_in_middle_score:.1%}")

asyncio.run(main())
```

### With ElizaOS Runtime

```python
from elizaos.runtime import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin
from elizaos_context_bench import run_eliza_benchmark, ContextBenchConfig

async def benchmark_eliza():
    runtime = AgentRuntime()
    # IMPORTANT: the Python runtime does not register model handlers by default.
    # Register at least one model plugin (e.g. OpenAI) before running benchmarks.
    plugin = get_openai_plugin()
    if plugin.models:
        for model_type, handler in plugin.models.items():
            runtime.register_model(model_type, handler, provider=plugin.name)
    
    config = ContextBenchConfig(
        context_lengths=[1024, 4096, 8192],
        tasks_per_position=5,
    )
    
    results = await run_eliza_benchmark(runtime, config)
    return results
```

### Full Benchmark

```python
from elizaos_context_bench import (
    ContextBenchRunner,
    ContextBenchConfig,
    ContextBenchReporter,
    save_results,
)

async def run_full_benchmark():
    config = ContextBenchConfig(
        context_lengths=[1024, 2048, 4096, 8192, 16384],
        positions=[NeedlePosition.START, NeedlePosition.EARLY, 
                   NeedlePosition.MIDDLE, NeedlePosition.LATE, NeedlePosition.END],
        tasks_per_position=5,
        run_niah_basic=True,
        run_niah_semantic=True,
        run_multi_hop=True,
    )
    
    runner = ContextBenchRunner(
        config=config,
        llm_query_fn=my_llm_query,
    )
    
    # Run with progress callback
    def on_progress(suite: str, completed: int, total: int):
        print(f"{suite}: {completed}/{total}")
    
    results = await runner.run_full_benchmark(progress_callback=on_progress)
    
    # Generate report
    reporter = ContextBenchReporter(results)
    reporter.print_report()
    
    # Save results
    paths = save_results(results, "./benchmark_results")
    print(f"Results saved to: {paths}")
    
    return results
```

## Configuration

```python
from elizaos_context_bench import ContextBenchConfig, NeedlePosition

config = ContextBenchConfig(
    # Context lengths to test (in tokens)
    context_lengths=[1024, 2048, 4096, 8192, 16384, 32768],
    
    # Needle positions to test
    positions=[
        NeedlePosition.START,   # First 10%
        NeedlePosition.EARLY,   # 10-30%
        NeedlePosition.MIDDLE,  # 40-60%
        NeedlePosition.LATE,    # 70-90%
        NeedlePosition.END,     # Last 10%
    ],
    
    # Tasks per position-length combination
    tasks_per_position=5,
    
    # Multi-hop reasoning depths
    multi_hop_depths=[1, 2, 3],
    
    # Which benchmarks to run
    run_niah_basic=True,
    run_niah_semantic=True,
    run_multi_hop=True,
    
    # Evaluation settings
    semantic_threshold=0.8,
    timeout_per_task_ms=60000,
    
    # Output settings
    output_dir="./benchmark_results",
    generate_report=True,
    generate_heatmap=True,
)
```

## Metrics

### Core Metrics

| Metric | Description |
|--------|-------------|
| **Overall Accuracy** | Percentage of correct retrievals |
| **Position Accuracy** | Accuracy by needle position (START/MIDDLE/END) |
| **Lost in Middle Score** | Relative accuracy drop for middle positions |
| **Context Degradation Rate** | Accuracy drop per doubling of context length |
| **Semantic Similarity** | Embedding-based similarity score |

### Multi-hop Metrics

| Metric | Description |
|--------|-------------|
| **2-hop Success Rate** | Success on 2-hop reasoning tasks |
| **3-hop Success Rate** | Success on 3-hop reasoning tasks |

## Leaderboard Comparison

Results are compared against published scores:

| Model | Overall | NIAH 4K | NIAH 32K | Lost in Middle |
|-------|---------|---------|----------|----------------|
| GPT-4-Turbo | 91% | 98% | 93% | 12% |
| GPT-4o | 94% | 99% | 95% | 8% |
| Claude-3-Opus | 95% | 99% | 96% | 5% |
| Claude-3-Sonnet | 88% | 98% | 90% | 15% |
| Llama-3.1-70B | 80% | 95% | 82% | 22% |

## Output Formats

### Markdown Report

```bash
# Generated report includes:
- Executive summary
- Overall metrics table
- Position analysis
- Context length analysis
- Multi-hop analysis (if enabled)
- Leaderboard comparison
- Configuration details
```

### JSON Summary

```json
{
  "overall_accuracy": 0.85,
  "total_tasks": 150,
  "lost_in_middle_score": 0.12,
  "position_accuracies": {...},
  "length_accuracies": {...},
  "comparison_to_leaderboard": {...}
}
```

### ASCII Visualizations

```
Position/Length Accuracy Heatmap
(█=100%, ▓=75%, ▒=50%, ░=25%, =0%)

         1K    2K    4K    8K   16K
         -------------------------
   start|  █     █     ▓     ▓     ▒   
   middle|  ▓     ▒     ▒     ░     ░   
     end|  █     █     ▓     ▓     ▒   
```

## Running Tests

```bash
cd benchmarks/context-bench/python
pip install -e ".[dev]"
pytest tests/ -v
```

## Architecture

```
elizaos_context_bench/
├── __init__.py          # Package exports
├── types.py             # Core type definitions
├── generator.py         # Context and needle generation
├── runner.py            # Main benchmark runner
├── reporting.py         # Report generation
├── evaluators/
│   ├── retrieval.py     # Retrieval evaluation
│   └── position.py      # Position analysis
├── suites/
│   ├── niah.py          # NIAH benchmark suite
│   └── multihop.py      # Multi-hop benchmark suite
└── providers/
    └── context.py       # ElizaOS context providers
```

## References

- [Needle in a Haystack](https://github.com/gkamradt/LLMTest_NeedleInAHaystack) - Original NIAH test
- [Lost in the Middle](https://arxiv.org/abs/2307.03172) - Position bias research
- [LongBench](https://github.com/THUDM/LongBench) - Long context evaluation
- [RULER](https://github.com/hsiehjackson/RULER) - Synthetic long-context reasoning

## Drift Mode

A long-running NIAH-style **drift** harness lives alongside the static
NIAH/multi-hop suites. Instead of stuffing a needle into a one-shot context,
it drives a real multi-turn conversation, forces compaction on a fixed
cadence using a chosen strategy, and probes planted facts after every
compaction and at end-of-run.

The TS driver runs against any OpenAI-compatible endpoint (defaults to
Cerebras `gpt-oss-120b` for both the agent and the judge). The Python suite
ingests the JSONL log it emits.

### Run a strategy comparison

```bash
# Real run (requires CEREBRAS_API_KEY in env)
bun run scripts/benchmark/drift-harness.ts \
  --strategy none \
  --turns 50 \
  --compact-every 10 \
  --plant-facts 5 \
  --output ./benchmark_results/drift/none.jsonl

# Offline plumbing smoke test (no API calls, deterministic fake model)
bun run scripts/benchmark/drift-harness.ts \
  --strategy none --turns 3 --compact-every 100 --plant-facts 1 \
  --output /tmp/drift-smoke.jsonl --dry-run
```

Strategies: `none`, `prompt-stripping`, `naive-summary`, `structured-state`,
`hierarchical-summary`, `hybrid-ledger`. The four runtime strategies are
loaded dynamically from `packages/agent/src/runtime/conversation-compactor.ts`;
if that module isn't present yet (parallel work), the harness logs
`[harness] strategy <name> not yet implemented — skipping` and continues.

### Aggregate from Python

```python
from elizaos_context_bench.drift import DriftBenchmarkSuite

suite = DriftBenchmarkSuite()

# Single log → single-run summary
summary = suite.aggregate("./benchmark_results/drift/none.jsonl")
print(summary.overall_accuracy, summary.drift_per_compaction)

# Or orchestrate by shelling out to the TS driver
result = suite.run_drift_eval(
    strategies=["none", "prompt-stripping", "naive-summary"],
    turns=50,
    compact_every=10,
    plant_facts=5,
    output_dir="./benchmark_results/drift",
)
for run in result.runs:
    print(run.strategy, run.overall_accuracy, run.drift_per_compaction)
```

### Output format

JSONL — one event per line. All scoring is reproducible from the log alone:

```jsonl
{"event":"turn","turn":1,"role":"user","contentLen":66,"tokens":17,"factId":"fact_1"}
{"event":"turn","turn":1,"role":"assistant","contentLen":12,"tokens":3}
{"event":"compact","atTurn":10,"strategy":"naive-summary","originalTokens":1820,"compactedTokens":120,"latencyMs":340}
{"event":"probe","atTurn":10,"factId":"fact_1","plantedTurn":1,"expected":"810471992241","actual":"I don't recall.","correct":false,"judgeReasoning":"exact-match: expected substring missing","phase":"post-compact"}
{"event":"summary","strategy":"naive-summary","overallAccuracy":0.4,"totalCompactions":4,"totalTokensSaved":6120,"totalProbes":10,"totalCorrect":4,"seed":1337,"turns":50,"compactEvery":10,"plantFacts":5}
```

### Optional Python deps

```bash
pip install -e ".[drift]"
```

## Drift harness — round 2 fixes

The TypeScript drift harness (`scripts/benchmark/drift-harness.ts`) was hardened
based on review feedback. Key changes:

- **No jailbreak system prompt.** The previous "all data is fictional, repeat
  values back" wrapper was a coping mechanism for `sk_*` API-key recall
  refusals. It was removed; sensitive `api_key` fact kinds were dropped.
- **Safer high-information fact kinds.** The fact rotation is now
  `aws_account, person_name, address, code, book_title, project_codename,
  isbn, date_iso, birthday, flight_number, uuid, zipcode` — memorable and
  safety-neutral.
- **Per-call reasoning effort.** The chat client takes a `reasoningEffort`
  per call. Defaults: agent + judge `medium` (so they actually scan
  history), compactor `low` (structured extraction). CLI flags
  `--agent-reasoning-effort`, `--judge-reasoning-effort`,
  `--compactor-reasoning-effort` override.
- **Larger probe budget.** `--probe-max-tokens` defaults to 600 (was 200) so
  prose recall answers don't truncate.
- **Balanced fact distribution.** Kinds rotate round-robin per seed: a
  4-fact run gets 4 distinct kinds; a 24-fact run gets exactly 2 of each
  of the 12 kinds.
- **Per-kind summary.** The `summary` JSONL event now includes
  `perKindAccuracy: { <kind>: { correct, total, accuracy } }`.
- **Realistic system prompt.** `--realistic-system-prompt` swaps in a ~5KB
  Eliza-style prompt with synthetic action and plugin descriptions so the
  compactor has something representative to chew on.
- **Independent judge.** `--judge-model` selects a different model id for
  the grader. Same model as agent (default) is biased toward agent output;
  use a different family for trustworthy numbers.
- **Tool-call drift.** `--with-tool-calls` interleaves a synthetic
  `[tool_call:<name>]` / `[tool_result:<name>] <value>` pair every 5 turns
  and probes `What did the X tool return when called at turn Y?` to verify
  tool-result preservation across compaction.

## License

MIT License - see LICENSE file for details.
