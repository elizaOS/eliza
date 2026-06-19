"""Live Cerebras smoke test. Skipped unless COMPACTBENCH_LIVE=1.

Run manually with::

    COMPACTBENCH_LIVE=1 CEREBRAS_API_KEY=... pytest tests/live_test_cerebras.py

This actually hits the Cerebras inference API, so it consumes credits and
requires network access. Keep it out of the default test run.
"""

from __future__ import annotations

import os

import pytest

from eliza_compactbench.cerebras_provider import CerebrasProvider

pytestmark = pytest.mark.skipif(
    os.environ.get("COMPACTBENCH_LIVE") != "1",
    reason="Set COMPACTBENCH_LIVE=1 to run live Cerebras tests",
)


async def test_cerebras_provider_round_trip() -> None:
    from compactbench.providers.base import CompletionRequest

    provider = CerebrasProvider()
    response = await provider.complete(
        CompletionRequest(
            model="gpt-oss-120b",
            prompt="Reply with exactly the word 'pong' and nothing else.",
            max_tokens=4,
        )
    )
    assert "pong" in response.text.lower()
    assert response.prompt_tokens > 0
