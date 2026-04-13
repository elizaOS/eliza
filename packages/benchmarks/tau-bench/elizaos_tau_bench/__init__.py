"""
ElizaOS Tau-bench - Tool-Agent-User Interaction Benchmark.

Tau-bench evaluates LLMs' ability to effectively utilize tools in real-world
customer service scenarios across multiple domains:

- Retail Domain: E-commerce customer support (orders, returns, refunds)
- Airline Domain: Flight booking and management (reservations, changes, cancellations)

Key metrics:
- Pass^k: Reliability metric measuring success across k independent trials
- Tool Call Accuracy: Correct tool selection and parameter extraction
- Policy Compliance: Adherence to domain-specific business rules
- Response Quality: Helpfulness and accuracy of final responses
"""

__version__ = "0.1.0"

from elizaos_tau_bench.types import (
    TauDomain,
    ToolCallStatus,
    ToolDefinition,
    ToolCall,
    ToolResult,
    PolicyConstraint,
    TauBenchTask,
    TauBenchResult,
    TauBenchReport,
    TauBenchConfig,
    PassKMetrics,
)
from elizaos_tau_bench.dataset import DataValidationError
from elizaos_tau_bench.evaluator import TauBenchEvaluator
from elizaos_tau_bench.agent import TauAgent  # Legacy mock agent
from elizaos_tau_bench.eliza_agent import (
    ElizaOSTauAgent,
    MockTauAgent,
    create_tau_agent,
    ELIZAOS_AVAILABLE,
)
from elizaos_tau_bench.constants import LEADERBOARD_SCORES
from elizaos_tau_bench.environments.base import DomainEnvironment
from elizaos_tau_bench.environments.retail import RetailEnvironment
from elizaos_tau_bench.environments.airline import AirlineEnvironment
from elizaos_tau_bench.runner import TauBenchRunner

__all__ = [
    # Types
    "TauDomain",
    "ToolCallStatus",
    "ToolDefinition",
    "ToolCall",
    "ToolResult",
    "PolicyConstraint",
    "TauBenchTask",
    "TauBenchResult",
    "TauBenchReport",
    "TauBenchConfig",
    "PassKMetrics",
    # Core components
    "TauBenchRunner",
    "TauBenchEvaluator",
    "TauAgent",
    # ElizaOS-integrated agents
    "ElizaOSTauAgent",
    "MockTauAgent",
    "create_tau_agent",
    "ELIZAOS_AVAILABLE",
    # Environments
    "DomainEnvironment",
    "RetailEnvironment",
    "AirlineEnvironment",
    # Errors
    "DataValidationError",
    # Constants
    "LEADERBOARD_SCORES",
]
