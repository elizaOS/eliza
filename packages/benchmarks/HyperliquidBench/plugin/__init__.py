"""
ElizaOS Plugin for HyperliquidBench.

Provides actions (GENERATE_PLAN, EXECUTE_PLAN) and providers (HL_CONTEXT)
that let an Eliza agent interact with the HyperliquidBench Rust toolchain.
"""

from elizaos.types import Plugin

from .actions import HL_ACTIONS
from .providers import HL_PROVIDERS

__all__ = ["hl_bench_plugin", "create_hl_bench_plugin"]


def create_hl_bench_plugin() -> Plugin:
    """Create the HyperliquidBench plugin with all actions and providers."""
    return Plugin(
        name="hyperliquid-bench",
        description=(
            "HyperliquidBench plugin for ElizaOS – provides GENERATE_PLAN and "
            "EXECUTE_PLAN actions plus the HL_CONTEXT provider for trading-plan "
            "generation, Rust runner execution, and evaluator scoring."
        ),
        config={},
        actions=HL_ACTIONS,
        providers=HL_PROVIDERS,
        evaluators=[],
        services=[],
    )


hl_bench_plugin = create_hl_bench_plugin()
