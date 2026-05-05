"""
Terminal-Bench Benchmark for elizaOS

A benchmark evaluating AI agents' proficiency in performing complex tasks
within terminal environments, including code compilation, system administration,
and machine learning model training.

All runs are routed through the elizaOS TypeScript benchmark bridge
(``packages/app-core/src/benchmark/server.ts``); the legacy Python
``AgentRuntime`` path has been removed.
"""

from elizaos_terminal_bench.dataset import TerminalBenchDataset
from elizaos_terminal_bench.environment import TerminalEnvironment
from elizaos_terminal_bench.evaluator import TerminalBenchEvaluator
from elizaos_terminal_bench.runner import TerminalBenchRunner, run_terminal_bench
from elizaos_terminal_bench.types import (
    LEADERBOARD_SCORES,
    TaskCategory,
    TaskDifficulty,
    TerminalBenchConfig,
    TerminalBenchReport,
    TerminalBenchResult,
    TerminalCommand,
    TerminalSession,
    TerminalTask,
)

__version__ = "0.1.0"

__all__ = [
    # Types
    "TaskCategory",
    "TaskDifficulty",
    "TerminalTask",
    "TerminalCommand",
    "TerminalSession",
    "TerminalBenchResult",
    "TerminalBenchReport",
    "TerminalBenchConfig",
    "LEADERBOARD_SCORES",
    # Core classes
    "TerminalBenchDataset",
    "TerminalEnvironment",
    "TerminalBenchEvaluator",
    "TerminalBenchRunner",
    # Convenience
    "run_terminal_bench",
]
