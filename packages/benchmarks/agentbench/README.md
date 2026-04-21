# ElizaOS AgentBench

A comprehensive implementation of [AgentBench](https://github.com/THUDM/AgentBench) for evaluating ElizaOS Python agents across 8 diverse environments.

## Overview

AgentBench evaluates LLMs functioning as autonomous agents across diverse interactive environments:

| Environment | Description | Status |
|-------------|-------------|--------|
| **Operating System (OS)** | Linux terminal interaction | ✅ Implemented |
| **Database (DB)** | SQL query generation and execution | ✅ Implemented |
| **Knowledge Graph (KG)** | SPARQL-like queries | ✅ Implemented |
| **Digital Card Game** | Strategic card games | 🔄 Planned |
| **Lateral Thinking Puzzle** | Creative reasoning | ✅ Implemented |
| **Householding (ALFWorld)** | Task decomposition | 🔄 Planned |
| **Web Shopping** | Online product search and purchase | ✅ Implemented |
| **Web Browsing** | General web navigation | 🔄 Planned |

## Installation

```bash
# From the benchmarks/agentbench/python directory
pip install -e .

# With development dependencies
pip install -e ".[dev]"
```

## Quick Start

### Run Full Benchmark

```python
import asyncio
from elizaos_agentbench import AgentBenchRunner, AgentBenchConfig
from elizaos.runtime import AgentRuntime

async def main():
    # Create ElizaOS runtime
    runtime = AgentRuntime()
    await runtime.initialize()

    # Configure benchmark
    config = AgentBenchConfig(
        output_dir="./results",
        save_detailed_logs=True,
    )

    # Run benchmark
    runner = AgentBenchRunner(config=config, runtime=runtime)
    report = await runner.run_benchmarks()

    print(f"Overall Success Rate: {report.overall_success_rate:.1%}")
    print(f"Tasks Completed: {report.passed_tasks}/{report.total_tasks}")

asyncio.run(main())
```

### Run Specific Environments

```python
from elizaos_agentbench import AgentBenchConfig, EnvironmentConfig

config = AgentBenchConfig()

# Enable only specific environments
config.os_config = EnvironmentConfig(enabled=True, max_tasks=50)
config.db_config = EnvironmentConfig(enabled=True, max_tasks=50)
config.web_shopping_config = EnvironmentConfig(enabled=True, max_tasks=30)

# Disable others
config.kg_config = EnvironmentConfig(enabled=False)
config.lateral_thinking_config = EnvironmentConfig(enabled=False)
```

### Use Command Line

```bash
# Run all environments
python -m elizaos_agentbench.cli run

# Run specific environment
python -m elizaos_agentbench.cli run --env os --env database

# With custom output directory
python -m elizaos_agentbench.cli run --output ./my_results
```

## Results Comparison

The benchmark compares ElizaOS performance against published baselines:

### Published GPT-4 Baseline Scores (ICLR 2024)

| Environment | GPT-4 Score |
|-------------|-------------|
| OS | 42.1% |
| Database | 32.6% |
| Knowledge Graph | 58.4% |
| Card Game | 42.8% |
| Lateral Thinking | 34.8% |
| Householding | 78.3% |
| Web Shopping | 50.5% |
| Web Browsing | 49.3% |

### Published GPT-3.5 Baseline Scores

| Environment | GPT-3.5 Score |
|-------------|---------------|
| OS | 36.0% |
| Database | 10.2% |
| Knowledge Graph | 16.4% |
| Card Game | 18.0% |
| Lateral Thinking | 10.9% |
| Householding | 13.7% |
| Web Shopping | 48.1% |
| Web Browsing | 15.0% |

## Output Files

After running the benchmark, you'll find:

- `agentbench-results.json` - Detailed JSON results
- `agentbench-report.md` - Human-readable markdown report
- `agentbench-detailed.json` - Full task-level logs (if enabled)

## Trajectory Logging (for Training)

AgentBench can log **end-to-end ElizaOS trajectories** (providers → canonical prompt → model response → actions → env reward)
via `elizaos_plugin_trajectory_logger`, and export datasets in ART or GRPO formats.

```bash
# Run and export OpenPipe ART trajectories
python run_benchmark.py --elizaos --env all --trajectories --trajectory-format art --output ./results

# Run and export grouped GRPO trajectories
python run_benchmark.py --elizaos --env all --trajectories --trajectory-format grpo --output ./results
```

## Testing

```bash
# Run tests
pytest

# With coverage
pytest --cov=elizaos_agentbench

# Specific test file
pytest elizaos_agentbench/tests/test_adapters.py -v
```

## Architecture

```
elizaos_agentbench/
├── __init__.py           # Package exports
├── types.py              # Core data types
├── runner.py             # Main benchmark runner
├── eliza_harness.py      # Canonical ElizaOS integration (handle_message flow)
├── benchmark_actions.py  # Benchmark Action definitions
├── adapters/
│   ├── base.py           # Base adapter interface
│   ├── os_adapter.py     # OS environment
│   ├── db_adapter.py     # Database environment
│   ├── webshop_adapter.py # Web shopping environment
│   ├── kg_adapter.py     # Knowledge graph environment
│   └── lateral_thinking_adapter.py # Puzzle environment
└── tests/
    ├── test_types.py
    ├── test_adapters.py
    └── test_runner.py
```

## References

- [AgentBench Paper (ICLR 2024)](https://arxiv.org/abs/2308.03688)
- [AgentBench GitHub](https://github.com/THUDM/AgentBench)
- [ElizaOS Documentation](https://elizaos.ai)

## License

MIT License - see LICENSE file for details.
