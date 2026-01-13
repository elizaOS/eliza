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

## License

MIT License - see LICENSE file for details.
