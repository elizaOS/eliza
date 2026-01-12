"""
Anthropic LLM Provider for Vending-Bench.

Provides a simple interface to Anthropic's Messages API.
"""

import os

import aiohttp

from elizaos_vending_bench.agent import LLMProvider


class AnthropicProvider(LLMProvider):
    """Anthropic Claude-based LLM provider."""

    def __init__(
        self,
        api_key: str | None = None,
        model: str = "claude-3-5-sonnet-20241022",
    ) -> None:
        """
        Initialize the Anthropic provider.

        Args:
            api_key: Anthropic API key (defaults to ANTHROPIC_API_KEY env var)
            model: Model to use
        """
        api_key_value = api_key or os.getenv("ANTHROPIC_API_KEY")
        if not api_key_value:
            raise ValueError(
                "Anthropic API key required. Set ANTHROPIC_API_KEY environment variable "
                "or pass api_key parameter."
            )
        self.api_key: str = api_key_value
        self.model = model

    async def generate(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
    ) -> tuple[str, int]:
        """
        Generate a response from Anthropic Claude.

        Returns:
            Tuple of (response_text, tokens_used)
        """
        async with aiohttp.ClientSession() as session:
            async with session.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": self.api_key,
                    "anthropic-version": "2023-06-01",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.model,
                    "max_tokens": 2048,
                    "system": system_prompt,
                    "messages": [{"role": "user", "content": user_prompt}],
                    "temperature": temperature,
                },
            ) as response:
                if response.status != 200:
                    error_text = await response.text()
                    raise RuntimeError(f"Anthropic API error ({response.status}): {error_text}")

                data = await response.json()

        # Extract response
        content_blocks = data.get("content", [])
        if not content_blocks:
            raise ValueError("No content in Anthropic response")

        content = content_blocks[0].get("text", "")

        # Token usage
        usage = data.get("usage", {})
        total_tokens = usage.get("input_tokens", 0) + usage.get("output_tokens", 0)

        return content, total_tokens
