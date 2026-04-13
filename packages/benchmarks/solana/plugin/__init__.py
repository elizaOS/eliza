"""
ElizaOS Plugin for the Solana benchmark.

Provides EXECUTE_CODE action and SOLANA_CONTEXT provider for
Solana program interaction discovery.
"""

from elizaos.types import Plugin

from .actions import SOLANA_ACTIONS
from .providers import SOLANA_PROVIDERS

__all__ = ["solana_bench_plugin", "create_solana_bench_plugin"]


def create_solana_bench_plugin() -> Plugin:
    """Create the Solana benchmark plugin with actions and providers."""
    return Plugin(
        name="solana-bench",
        description=(
            "Solana benchmark plugin for ElizaOS — provides EXECUTE_CODE action "
            "for running TypeScript skills against a Solana validator, and "
            "SOLANA_CONTEXT provider for injecting discovery state."
        ),
        config={},
        actions=SOLANA_ACTIONS,
        providers=SOLANA_PROVIDERS,
        evaluators=[],
        services=[],
    )


solana_bench_plugin = create_solana_bench_plugin()
