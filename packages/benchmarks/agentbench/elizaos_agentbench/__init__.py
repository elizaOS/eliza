"""
ElizaOS AgentBench - Comprehensive benchmark for evaluating LLMs as agents.

AgentBench evaluates agents across 8 diverse environments:
- Operating System (OS): Linux terminal interaction
- Database (DB): SQL query generation and execution
- Knowledge Graph (KG): SPARQL-like queries
- Digital Card Game: Strategic card games
- Lateral Thinking Puzzle: Creative problem solving
- Householding (ALFWorld): Task decomposition and execution
- Web Shopping: Online product search and purchase
- Web Browsing: General web navigation

The benchmark supports bridge-backed Eliza execution through
``eliza_adapter.agentbench`` and direct mock execution for harness validation.

Usage:
    from elizaos_agentbench import AgentBenchRunner, AgentBenchConfig
    config = AgentBenchConfig(output_dir="./results")
    runner = AgentBenchRunner(config=config)
    report = await runner.run_benchmarks()
"""

from elizaos_agentbench import upstream_loader
from elizaos_agentbench.adapters.base import EnvironmentAdapter
from elizaos_agentbench.benchmark_actions import (
    create_benchmark_actions,
    create_benchmark_plugin,
)
from elizaos_agentbench.eliza_harness import (
    BenchmarkDatabaseAdapter,
    ElizaAgentHarness,
    create_benchmark_character,
    create_benchmark_runtime,
)
from elizaos_agentbench.runner import AgentBenchRunner, run_agentbench
from elizaos_agentbench.types import (
    AgentBenchConfig,
    AgentBenchDataMode,
    AgentBenchEnvironment,
    AgentBenchReport,
    AgentBenchResult,
    AgentBenchTask,
    BenchmarkSplit,
    EnvironmentConfig,
)

__all__ = [
    # Types
    "AgentBenchEnvironment",
    "AgentBenchTask",
    "AgentBenchResult",
    "AgentBenchReport",
    "AgentBenchConfig",
    "AgentBenchDataMode",
    "BenchmarkSplit",
    "EnvironmentConfig",
    # Runner
    "AgentBenchRunner",
    "run_agentbench",
    "EnvironmentAdapter",
    "upstream_loader",
    # Bridge compatibility helpers
    "ElizaAgentHarness",
    "create_benchmark_runtime",
    "create_benchmark_character",
    "BenchmarkDatabaseAdapter",
    # Benchmark Actions
    "create_benchmark_actions",
    "create_benchmark_plugin",
]

__version__ = "0.1.0"
