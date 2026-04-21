from __future__ import annotations

from elizaos.types import Plugin

from .evaluators import long_term_extraction_evaluator, summarization_evaluator
from .memory_service import MemoryService
from .providers import context_summary_provider, long_term_memory_provider


def create_advanced_memory_plugin() -> Plugin:
    async def init_plugin(_config, runtime) -> None:
        runtime.logger.info(
            "Advanced memory enabled",
            src="plugin:advanced-memory",
            agentId=str(runtime.agent_id),
        )

    return Plugin(
        name="memory",
        description="Built-in advanced memory (summaries + long-term facts)",
        init=init_plugin,
        config={},
        services=[MemoryService],
        actions=[],
        providers=[long_term_memory_provider, context_summary_provider],
        evaluators=[summarization_evaluator, long_term_extraction_evaluator],
    )


advanced_memory_plugin = create_advanced_memory_plugin()
