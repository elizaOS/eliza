"""
xAI Grok Client

Async HTTP client for xAI's Grok API.
Provides text generation and embedding capabilities.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator

import httpx
from pydantic import BaseModel, Field


class GrokError(Exception):
    """Grok API error."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class GrokConfig(BaseModel):
    """Grok API configuration."""

    api_key: str
    base_url: str = Field(default="https://api.x.ai/v1")
    small_model: str = Field(default="grok-3-mini")
    large_model: str = Field(default="grok-3")
    embedding_model: str = Field(default="grok-embedding")
    timeout: float = Field(default=60.0)

    @classmethod
    def from_env(cls) -> GrokConfig:
        """Create configuration from environment variables."""
        api_key = os.getenv("XAI_API_KEY")
        if not api_key:
            raise ValueError("XAI_API_KEY is required")

        return cls(
            api_key=api_key,
            base_url=os.getenv("XAI_BASE_URL", "https://api.x.ai/v1"),
            small_model=os.getenv("XAI_SMALL_MODEL", "grok-3-mini"),
            large_model=os.getenv("XAI_MODEL") or os.getenv("XAI_LARGE_MODEL", "grok-3"),
            embedding_model=os.getenv("XAI_EMBEDDING_MODEL", "grok-embedding"),
        )


class TextGenerationParams(BaseModel):
    """Parameters for text generation."""

    prompt: str
    system: str | None = None
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int | None = None
    stop_sequences: list[str] | None = None
    stream: bool = False


class EmbeddingParams(BaseModel):
    """Parameters for embedding generation."""

    text: str
    model: str | None = None


class TokenUsage(BaseModel):
    """Token usage information."""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class TextGenerationResult(BaseModel):
    """Result of text generation."""

    text: str
    usage: TokenUsage = Field(default_factory=TokenUsage)


class GrokClient:
    """
    Async Grok API client.

    Provides access to xAI's Grok models for text generation and embeddings.
    """

    def __init__(self, config: GrokConfig) -> None:
        """Initialize the Grok client."""
        self._config = config
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create the HTTP client."""
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self._config.base_url,
                headers={
                    "Authorization": f"Bearer {self._config.api_key}",
                    "Content-Type": "application/json",
                },
                timeout=httpx.Timeout(self._config.timeout),
            )
        return self._client

    async def close(self) -> None:
        """Close the HTTP client."""
        if self._client:
            await self._client.aclose()
            self._client = None

    async def __aenter__(self) -> GrokClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    def _raise_for_status(self, response: httpx.Response) -> None:
        """Raise an exception if the response indicates an error."""
        if response.is_success:
            return

        error_data = response.json()
        error_message = error_data.get("error", {}).get("message") or response.text

        raise GrokError(
            f"Grok API error ({response.status_code}): {error_message}",
            status_code=response.status_code,
        )

    # =========================================================================
    # Text Generation
    # =========================================================================

    async def generate_text(
        self,
        params: TextGenerationParams,
        *,
        use_large_model: bool = False,
    ) -> TextGenerationResult:
        """Generate text using Grok."""
        client = await self._get_client()
        model = self._config.large_model if use_large_model else self._config.small_model

        messages: list[dict[str, str]] = []
        if params.system:
            messages.append({"role": "system", "content": params.system})
        messages.append({"role": "user", "content": params.prompt})

        body: dict = {
            "model": model,
            "messages": messages,
            "temperature": params.temperature,
        }

        if params.max_tokens:
            body["max_tokens"] = params.max_tokens
        if params.stop_sequences:
            body["stop"] = params.stop_sequences

        response = await client.post("/chat/completions", json=body)
        self._raise_for_status(response)

        data = response.json()
        usage = data["usage"]

        return TextGenerationResult(
            text=data["choices"][0]["message"]["content"],
            usage=TokenUsage(
                prompt_tokens=usage["prompt_tokens"],
                completion_tokens=usage["completion_tokens"],
                total_tokens=usage["total_tokens"],
            ),
        )

    async def stream_text(
        self,
        params: TextGenerationParams,
        *,
        use_large_model: bool = False,
    ) -> AsyncIterator[str]:
        """Stream text generation using Grok."""
        client = await self._get_client()
        model = self._config.large_model if use_large_model else self._config.small_model

        messages: list[dict[str, str]] = []
        if params.system:
            messages.append({"role": "system", "content": params.system})
        messages.append({"role": "user", "content": params.prompt})

        body: dict = {
            "model": model,
            "messages": messages,
            "temperature": params.temperature,
            "stream": True,
        }

        if params.max_tokens:
            body["max_tokens"] = params.max_tokens
        if params.stop_sequences:
            body["stop"] = params.stop_sequences

        import json

        async with client.stream("POST", "/chat/completions", json=body) as response:
            self._raise_for_status(response)
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data = line[6:]
                if data == "[DONE]":
                    break

                chunk = json.loads(data)
                delta = chunk["choices"][0]["delta"]
                if "content" in delta:
                    yield delta["content"]

    # =========================================================================
    # Embeddings
    # =========================================================================

    async def create_embedding(self, params: EmbeddingParams) -> list[float]:
        """Create an embedding for text."""
        client = await self._get_client()
        model = params.model or self._config.embedding_model

        response = await client.post(
            "/embeddings",
            json={"model": model, "input": params.text},
        )
        self._raise_for_status(response)

        return response.json()["data"][0]["embedding"]

    # =========================================================================
    # Model Information
    # =========================================================================

    async def list_models(self) -> list[dict]:
        """List available models."""
        client = await self._get_client()
        response = await client.get("/models")
        self._raise_for_status(response)
        return response.json()["data"]
