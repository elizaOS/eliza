"""Solana benchmark providers for ElizaOS."""

from .solana_context import solana_context_provider

__all__ = [
    "solana_context_provider",
    "SOLANA_PROVIDERS",
]

SOLANA_PROVIDERS = [solana_context_provider]
