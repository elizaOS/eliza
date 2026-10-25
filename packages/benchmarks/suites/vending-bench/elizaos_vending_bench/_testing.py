"""
Testing utilities for Vending-Bench.

This module is intentionally NOT re-exported from the package's public
``__init__`` so production code stays free of mock providers. Import directly:

    from elizaos_vending_bench._testing import MockLLMProvider
"""

from __future__ import annotations


class MockLLMProvider:
    """Mock LLM provider for unit tests.

    Returns scripted responses in order; defaults to ``{"action": "ADVANCE_DAY"}``
    once the script is exhausted. The token count returned is deterministic
    (100 per scripted response, 50 for the default) so tests can assert on it.
    """

    def __init__(self, responses: list[str] | None = None) -> None:
        self.responses = responses or []
        self.call_count = 0

    async def generate(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
    ) -> tuple[str, int]:
        if self.responses and self.call_count < len(self.responses):
            response = self.responses[self.call_count]
            self.call_count += 1
            return response, 100
        return '{"action": "ADVANCE_DAY"}', 50
