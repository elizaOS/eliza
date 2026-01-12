"""
Terminal-Bench Benchmark for ElizaOS

A benchmark evaluating AI agents' proficiency in performing complex tasks
within terminal environments, including code compilation, system administration,
and machine learning model training.
"""

from elizaos_terminal_bench.types import (
    TaskCategory,
    TaskDifficulty,
    TerminalTask,
    TerminalCommand,
    TerminalSession,
    TerminalBenchResult,
    TerminalBenchReport,
    TerminalBenchConfig,
    LEADERBOARD_SCORES,
)
from elizaos_terminal_bench.dataset import TerminalBenchDataset
from elizaos_terminal_bench.environment import TerminalEnvironment
from elizaos_terminal_bench.agent import TerminalAgent
from elizaos_terminal_bench.evaluator import TerminalBenchEvaluator
from elizaos_terminal_bench.runner import TerminalBenchRunner

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
    "TerminalAgent",
    "TerminalBenchEvaluator",
    "TerminalBenchRunner",
]
