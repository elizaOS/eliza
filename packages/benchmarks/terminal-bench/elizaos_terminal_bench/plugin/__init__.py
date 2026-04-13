"""
ElizaOS Plugin for Terminal-Bench.

This plugin provides canonical ElizaOS actions and providers for terminal
operations during benchmarking. It enables the agent to interact with
terminal environments through the standard ElizaOS action system.
"""

from elizaos.types import Plugin

from .actions import TERMINAL_ACTIONS
from .providers import TERMINAL_PROVIDERS

__all__ = ["terminal_bench_plugin", "create_terminal_bench_plugin"]


def create_terminal_bench_plugin() -> Plugin:
    """Create the Terminal-Bench plugin with all actions and providers."""
    return Plugin(
        name="terminal-bench",
        description=(
            "Terminal-Bench plugin for ElizaOS - provides terminal operation "
            "actions (EXECUTE, READ_FILE, WRITE_FILE, LIST_DIR, TASK_COMPLETE) "
            "and context providers for benchmark task execution."
        ),
        config={},
        actions=TERMINAL_ACTIONS,
        providers=TERMINAL_PROVIDERS,
        evaluators=[],
        services=[],
    )


terminal_bench_plugin = create_terminal_bench_plugin()
