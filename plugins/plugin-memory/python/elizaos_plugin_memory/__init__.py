"""
Memory plugin for conversation summarization and long-term fact extraction.
"""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos import AgentRuntime

from elizaos_plugin_memory.evaluators.long_term_extraction import LongTermExtractionEvaluator
from elizaos_plugin_memory.evaluators.summarization import SummarizationEvaluator
from elizaos_plugin_memory.providers.context_summary import ContextSummaryProvider
from elizaos_plugin_memory.providers.long_term_memory import LongTermMemoryProvider
from elizaos_plugin_memory.services.memory_service import MemoryService
from elizaos_plugin_memory.types import (
    LongTermMemory,
    LongTermMemoryCategory,
    MemoryConfig,
    MemoryExtraction,
    SessionSummary,
    SummaryResult,
)

__version__ = "1.0.0"


class MemoryPlugin:
    name = "memory"
    description = (
        "Memory management with conversation summarization and long-term persistent memory"
    )
    version = __version__

    def __init__(self, config: MemoryConfig | None = None) -> None:
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
        self.actions: list[object] = []

    async def initialize(self, runtime: "AgentRuntime") -> None:
        await self.service.start(runtime)

    async def shutdown(self) -> None:
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
