"""
OpenAI LLM Provider for Vending-Bench.

Provides a simple interface to OpenAI's chat completion API.
"""

import os

import aiohttp

from elizaos_vending_bench.agent import LLMProvider


class OpenAIProvider(LLMProvider):
    """OpenAI-based LLM provider."""

    def __init__(
        self,
        api_key: str | None = None,
        model: str = "gpt-4",
        base_url: str = "https://api.openai.com/v1",
    ) -> None:
        """
        Initialize the OpenAI provider.

        Args:
            api_key: OpenAI API key (defaults to OPENAI_API_KEY env var)
            model: Model to use (default: gpt-4)
            base_url: API base URL
        """
        self.api_key = api_key or os.getenv("OPENAI_API_KEY")
        if not self.api_key:
            raise ValueError(
                "OpenAI API key required. Set OPENAI_API_KEY environment variable "
                "or pass api_key parameter."
            )
        self.model = model
        self.base_url = base_url

    async def generate(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
    ) -> tuple[str, int]:
        """
        Generate a response from OpenAI.

        Args:
            system_prompt: System message for context
            user_prompt: User message/query
            temperature: Sampling temperature

        Returns:
            Tuple of (response_text, tokens_used)
        """
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                    # Avoid brotli ("br") responses unless brotli libs are installed.
                    "Accept-Encoding": "gzip, deflate",
                },
                json={
                    "model": self.model,
                    "messages": messages,
                    "temperature": temperature,
                    "max_completion_tokens": 2048,
                },
            ) as response:
                if response.status != 200:
                    error_text = await response.text()
                    raise RuntimeError(f"OpenAI API error ({response.status}): {error_text}")

                data = await response.json()

        # Extract response
        choices = data.get("choices", [])
        if not choices:
            raise ValueError("No choices in OpenAI response")

        message = choices[0].get("message", {})
        content = message.get("content", "")

        # Get token usage
        usage = data.get("usage", {})
        total_tokens = usage.get("total_tokens", 0)

        return content, total_tokens
