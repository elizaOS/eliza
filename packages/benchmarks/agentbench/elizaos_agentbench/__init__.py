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

The benchmark supports two execution modes:
1. Full ElizaOS Pipeline: Uses message_service.handle_message() with the complete
   agent flow including providers, memory, and conversation history.
2. Direct Mode: Uses runtime.generate_text() directly for testing.

Usage:
    from elizaos_agentbench import AgentBenchRunner, AgentBenchConfig
    from elizaos_agentbench.eliza_harness import create_benchmark_runtime

    # Create full ElizaOS runtime
    runtime = await create_benchmark_runtime()

    # Run benchmarks with full pipeline
    config = AgentBenchConfig(output_dir="./results")
    runner = AgentBenchRunner(config=config, runtime=runtime)
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
    # ElizaOS Integration
    "ElizaAgentHarness",
    "create_benchmark_runtime",
    "create_benchmark_character",
    "BenchmarkDatabaseAdapter",
    # Benchmark Actions
    "create_benchmark_actions",
    "create_benchmark_plugin",
]

__version__ = "0.1.0"
