"""HyperliquidBench Providers for ElizaOS."""

from .hl_context import hl_context_provider

__all__ = [
    "hl_context_provider",
    "HL_PROVIDERS",
]

HL_PROVIDERS = [
    hl_context_provider,
]
