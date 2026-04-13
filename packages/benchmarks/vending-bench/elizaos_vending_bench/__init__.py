"""
Vending-Bench Benchmark Implementation for ElizaOS

A comprehensive implementation of the Vending-Bench benchmark for evaluating
LLM agent coherence in a simulated vending machine business.

Reference:
- Paper: https://arxiv.org/abs/2502.15840
- Leaderboard: https://andonlabs.com/evals/vending-bench
"""

from elizaos_vending_bench.agent import (
    LLMProvider,
    MockLLMProvider,
    VendingAgent,
)
from elizaos_vending_bench.environment import (
    EconomicModel,
    VendingEnvironment,
)
from elizaos_vending_bench.evaluator import CoherenceEvaluator
from elizaos_vending_bench.reporting import VendingBenchReporter
from elizaos_vending_bench.runner import VendingBenchRunner
from elizaos_vending_bench.types import (
    LEADERBOARD_SCORES,
    ActionType,
    AgentAction,
    AgentState,
    CoherenceError,
    CoherenceErrorType,
    DailySummary,
    DeliveredInventory,
    InventorySlot,
    # Enums
    ItemSize,
    LeaderboardComparison,
    LeaderboardEntry,
    Order,
    OrderStatus,
    # Data classes
    Product,
    Sale,
    Season,
    Supplier,
    VendingBenchConfig,
    VendingBenchMetrics,
    VendingBenchReport,
    VendingBenchResult,
    VendingMachine,
    WeatherCondition,
)


# Plugin (lazy import to avoid circular dependencies)
def get_plugin():
    """Get the ElizaOS plugin for Vending-Bench."""
    from elizaos_vending_bench.plugin import vending_bench_plugin

    return vending_bench_plugin


__version__ = "1.0.0"

__all__ = [
    # Version
    "__version__",
    # Enums
    "ItemSize",
    "OrderStatus",
    "WeatherCondition",
    "Season",
    "ActionType",
    "CoherenceErrorType",
    # Types
    "Product",
    "InventorySlot",
    "VendingMachine",
    "Supplier",
    "Order",
    "DeliveredInventory",
    "Sale",
    "DailySummary",
    "AgentState",
    "CoherenceError",
    "AgentAction",
    "VendingBenchResult",
    "VendingBenchMetrics",
    "LeaderboardEntry",
    "LeaderboardComparison",
    "VendingBenchConfig",
    "VendingBenchReport",
    "LEADERBOARD_SCORES",
    # Environment
    "EconomicModel",
    "VendingEnvironment",
    # Agent
    "LLMProvider",
    "VendingAgent",
    "MockLLMProvider",
    # Evaluation
    "CoherenceEvaluator",
    # Runner
    "VendingBenchRunner",
    # Reporting
    "VendingBenchReporter",
    # Plugin
    "get_plugin",
]
