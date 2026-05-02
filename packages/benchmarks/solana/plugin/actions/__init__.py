"""Solana benchmark actions for ElizaOS."""

from .execute_code import execute_code_action

__all__ = [
    "execute_code_action",
    "SOLANA_ACTIONS",
]

SOLANA_ACTIONS = [execute_code_action]
