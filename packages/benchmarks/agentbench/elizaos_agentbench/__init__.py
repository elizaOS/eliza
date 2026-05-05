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

from elizaos_agentbench.types import (
    AgentBenchEnvironment,
    AgentBenchTask,
    AgentBenchResult,
    AgentBenchReport,
    AgentBenchConfig,
    EnvironmentConfig,
)
from elizaos_agentbench.runner import AgentBenchRunner
from elizaos_agentbench.adapters.base import EnvironmentAdapter
from elizaos_agentbench.eliza_harness import (
    ElizaAgentHarness,
    create_benchmark_runtime,
    create_benchmark_character,
    BenchmarkDatabaseAdapter,
)
from elizaos_agentbench.benchmark_actions import (
    create_benchmark_actions,
    create_benchmark_plugin,
)

__all__ = [
    # Types
    "AgentBenchEnvironment",
    "AgentBenchTask",
    "AgentBenchResult",
    "AgentBenchReport",
    "AgentBenchConfig",
    "EnvironmentConfig",
    # Runner
    "AgentBenchRunner",
    "EnvironmentAdapter",
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
