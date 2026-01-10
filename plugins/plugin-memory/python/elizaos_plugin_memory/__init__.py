"""
elizaOS Memory Plugin - Advanced memory management with summarization and long-term facts.

This package provides memory management capabilities for elizaOS agents,
including conversation summarization and persistent fact extraction.

Example:
    >>> from elizaos_plugin_memory import MemoryPlugin
    >>> plugin = MemoryPlugin()
    >>> await plugin.initialize(runtime)
"""

from typing import Any, Optional

from elizaos_plugin_memory.types import (
    LongTermMemory,
    LongTermMemoryCategory,
    MemoryConfig,
    MemoryExtraction,
    SessionSummary,
    SummaryResult,
)
from elizaos_plugin_memory.services.memory_service import MemoryService
from elizaos_plugin_memory.providers.long_term_memory import LongTermMemoryProvider
from elizaos_plugin_memory.providers.context_summary import ContextSummaryProvider
from elizaos_plugin_memory.evaluators.summarization import SummarizationEvaluator
from elizaos_plugin_memory.evaluators.long_term_extraction import LongTermExtractionEvaluator

__version__ = "1.0.0"


class MemoryPlugin:
    """Memory Plugin for elizaOS."""

    name = "memory"
    description = "Advanced memory management with conversation summarization and long-term persistent memory"
    version = __version__

    def __init__(self, config: Optional[MemoryConfig] = None) -> None:
        self.config = config or MemoryConfig()
        self.service = MemoryService(self.config)
        self.providers = [
            LongTermMemoryProvider(),
            ContextSummaryProvider(),
        ]
        self.evaluators = [
            SummarizationEvaluator(),
            LongTermExtractionEvaluator(),
        ]
        self.actions: list[Any] = []

    async def initialize(self, runtime: Any) -> None:
        """Initialize the plugin with runtime context."""
        await self.service.start(runtime)

    async def shutdown(self) -> None:
        """Cleanup plugin resources."""
        await self.service.stop()


__all__ = [
    # Plugin
    "MemoryPlugin",
    # Types
    "LongTermMemory",
    "LongTermMemoryCategory",
    "MemoryConfig",
    "MemoryExtraction",
    "SessionSummary",
    "SummaryResult",
    # Services
    "MemoryService",
    # Providers
    "LongTermMemoryProvider",
    "ContextSummaryProvider",
    # Evaluators
    "SummarizationEvaluator",
    "LongTermExtractionEvaluator",
]

