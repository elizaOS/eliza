"""Tests for the local fallback path in the experience benchmark CLI."""

import pytest

import run_benchmark
from elizaos_experience_bench.types import BenchmarkConfig


@pytest.mark.asyncio
async def test_local_fallback_recall_requires_model_response_keywords() -> None:
    async def call_model(system: str, prompt: str) -> str:
        if "save" in system.lower():
            return "RECORD_EXPERIENCE saved"
        return "I can help, but I will not mention the retrieved lesson."

    result = await run_benchmark._run_local_agent_fallback(
        BenchmarkConfig(
            num_experiences=20,
            num_learning_cycles=2,
            num_retrieval_queries=3,
            seed=7,
        ),
        call_model,
    )

    assert result.total_queries == 3
    assert result.eliza_agent is not None
    assert result.eliza_agent.total_experiences_recorded == 2
    assert result.eliza_agent.direct_recall_rate > 0
    assert result.eliza_agent.agent_recall_rate == 0
    assert result.eliza_agent.agent_keyword_incorporation_rate == 0
