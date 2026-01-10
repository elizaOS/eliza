"""
Classic ELIZA Pattern Matching Plugin for elizaOS.

Provides a testable chat response interface for agents without requiring an LLM.
"""

from elizaos_plugin_eliza_classic.plugin import (
    ElizaClassicPlugin,
    generate_response,
    get_greeting,
    reflect,
)
from elizaos_plugin_eliza_classic.types import (
    ElizaConfig,
    ElizaMatchResult,
    ElizaPattern,
    ElizaRule,
)

__all__ = [
    "ElizaClassicPlugin",
    "generate_response",
    "get_greeting",
    "reflect",
    "ElizaConfig",
    "ElizaMatchResult",
    "ElizaPattern",
    "ElizaRule",
]

__version__ = "1.0.0"

