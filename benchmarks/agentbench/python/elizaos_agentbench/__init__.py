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

__all__ = [
    "AgentBenchEnvironment",
    "AgentBenchTask",
    "AgentBenchResult",
    "AgentBenchReport",
    "AgentBenchConfig",
    "EnvironmentConfig",
    "AgentBenchRunner",
    "EnvironmentAdapter",
]

__version__ = "0.1.0"
