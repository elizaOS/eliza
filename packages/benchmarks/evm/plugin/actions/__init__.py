"""EVM Benchmark Actions for ElizaOS."""

from .execute_code import execute_code_action

__all__ = [
    "execute_code_action",
    "EVM_ACTIONS",
]

EVM_ACTIONS = [
    execute_code_action,
]
