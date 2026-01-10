"""
Vercel AI Gateway API Client

Async HTTP client for Vercel AI Gateway API interactions using httpx.
All methods use strong typing and fail-fast error handling.
"""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING, AsyncIterator

import httpx

from elizaos_plugin_gateway.config import GatewayConfig, model_supports_temperature
from elizaos_plugin_gateway.types import (
    ChatCompletionResponse,
    EmbeddingParams,
    EmbeddingResponse,
    ImageDescriptionParams,
    ImageDescriptionResult,
    ImageGenerationParams,
    ImageGenerationResponse,
    ImageGenerationResult,
    TextGenerationParams,
)


class GatewayClientError(Exception):
    """Base exception for Gateway client errors."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class GatewayClient:
    """
    Async Vercel AI Gateway client.

    All methods are async and use httpx for HTTP requests.
    Errors are raised immediately - no silent failures.
    """

    def __init__(self, config: GatewayConfig) -> None:
        """
        Initialize the Gateway client.

        Args:
            config: Gateway configuration with API key and settings.
        """
        self._config = config
        self._client = httpx.AsyncClient(
            base_url=config.base_url,
            headers={
                "Authorization": f"Bearer {config.api_key}",
                "Content-Type": "application/json",
            },
            timeout=httpx.Timeout(config.timeout),
        )

    async def close(self) -> None:
        """Close the HTTP client."""
        await self._client.aclose()

    async def __aenter__(self) -> "GatewayClient":
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    def _raise_for_status(self, response: httpx.Response) -> None:
        """Raise an exception if the response indicates an error."""
        if response.is_success:
            return

        try:
            error_data = response.json()
            error_message = error_data.get("error", {}).get("message", response.text)
        except json.JSONDecodeError:
            error_message = response.text

        raise GatewayClientError(
            f"Gateway API error ({response.status_code}): {error_message}",
            status_code=response.status_code,
        )

    # =========================================================================
    # Text Generation
    # =========================================================================

    async def generate_text(self, params: TextGenerationParams) -> str:
        """
        Generate text using the chat completions API.

        Args:
            params: Text generation parameters.

        Returns:
            Generated text content.

        Raises:
            GatewayClientError: If the API request fails.
        """
        model = params.model or self._config.large_model

        messages: list[dict[str, str]] = []
        if params.system:
            messages.append({"role": "system", "content": params.system})
        messages.append({"role": "user", "content": params.prompt})

        request_body: dict[str, object] = {
            "model": model,
            "messages": messages,
        }

        # Only add temperature/sampling params for models that support them
        if model_supports_temperature(model):
            if params.temperature is not None:
                request_body["temperature"] = params.temperature
            if params.frequency_penalty is not None:
                request_body["frequency_penalty"] = params.frequency_penalty
            if params.presence_penalty is not None:
                request_body["presence_penalty"] = params.presence_penalty
            if params.stop_sequences is not None:
                request_body["stop"] = params.stop_sequences
            if params.max_tokens is not None:
                request_body["max_tokens"] = params.max_tokens
        else:
            # Reasoning models use max_completion_tokens instead of max_tokens
            if params.max_tokens is not None:
                request_body["max_completion_tokens"] = params.max_tokens

        response = await self._client.post("/chat/completions", json=request_body)
        self._raise_for_status(response)

        completion = ChatCompletionResponse.model_validate(response.json())
        if not completion.choices:
            raise GatewayClientError("API returned no choices")

        content = completion.choices[0].message.content
        if content is None:
            raise GatewayClientError("API returned empty content")

        return content

    async def stream_text(self, params: TextGenerationParams) -> AsyncIterator[str]:
        """
        Stream text generation using the chat completions API.

        Args:
            params: Text generation parameters.

        Yields:
            Text chunks as they are generated.

        Raises:
            GatewayClientError: If the API request fails.
        """
        model = params.model or self._config.large_model

        messages: list[dict[str, str]] = []
        if params.system:
            messages.append({"role": "system", "content": params.system})
        messages.append({"role": "user", "content": params.prompt})

        request_body: dict[str, object] = {
            "model": model,
            "messages": messages,
            "stream": True,
        }

        # Only add temperature for models that support it
        if model_supports_temperature(model):
            if params.temperature is not None:
                request_body["temperature"] = params.temperature
            if params.max_tokens is not None:
                request_body["max_tokens"] = params.max_tokens
        else:
            if params.max_tokens is not None:
                request_body["max_completion_tokens"] = params.max_tokens

        async with self._client.stream(
            "POST", "/chat/completions", json=request_body
        ) as response:
            self._raise_for_status(response)
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data = line[6:]
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                    delta = chunk.get("choices", [{}])[0].get("delta", {})
                    content = delta.get("content")
                    if content:
                        yield content
                except json.JSONDecodeError:
                    continue

    # =========================================================================
    # Embeddings
    # =========================================================================

    async def create_embedding(self, params: EmbeddingParams) -> list[float]:
        """
        Generate an embedding for the given text.

        Args:
            params: Embedding parameters.

        Returns:
            List of float values representing the embedding.

        Raises:
            GatewayClientError: If the API request fails.
        """
        model = params.model or self._config.embedding_model
        dimensions = params.dimensions or self._config.embedding_dimensions

        request_body: dict[str, str | int] = {
            "model": model,
            "input": params.text,
        }
        if dimensions:
            request_body["dimensions"] = dimensions

        response = await self._client.post("/embeddings", json=request_body)
        self._raise_for_status(response)

        embedding_response = EmbeddingResponse.model_validate(response.json())
        if not embedding_response.data:
            raise GatewayClientError("API returned empty embedding data")

        return embedding_response.data[0].embedding

    # =========================================================================
    # Image Generation
    # =========================================================================

    async def generate_image(
        self, params: ImageGenerationParams
    ) -> list[ImageGenerationResult]:
        """
        Generate images.

        Args:
            params: Image generation parameters.

        Returns:
            List of generated image results with URLs.

        Raises:
            GatewayClientError: If the API request fails.
        """
        model = params.model or self._config.image_model

        request_body: dict[str, object] = {
            "model": model,
            "prompt": params.prompt,
            "n": params.n,
            "size": params.size.value,
            "quality": params.quality.value,
            "style": params.style.value,
        }

        response = await self._client.post("/images/generations", json=request_body)
        self._raise_for_status(response)

        image_response = ImageGenerationResponse.model_validate(response.json())
        return [
            ImageGenerationResult(url=item.url, revised_prompt=item.revised_prompt)
            for item in image_response.data
        ]

    # =========================================================================
    # Image Description
    # =========================================================================

    async def describe_image(
        self, params: ImageDescriptionParams
    ) -> ImageDescriptionResult:
        """
        Describe/analyze an image using vision capabilities.

        Args:
            params: Image description parameters.

        Returns:
            ImageDescriptionResult with title and description.

        Raises:
            GatewayClientError: If the API request fails.
        """
        model = params.model or "gpt-5-mini"
        prompt = (
            params.prompt
            or "Please analyze this image and provide a title and detailed description."
        )

        request_body: dict[str, object] = {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": params.image_url}},
                    ],
                }
            ],
            "max_tokens": params.max_tokens,
        }

        response = await self._client.post("/chat/completions", json=request_body)
        self._raise_for_status(response)

        completion = ChatCompletionResponse.model_validate(response.json())
        if not completion.choices:
            raise GatewayClientError("API returned no choices for image description")

        content = completion.choices[0].message.content
        if content is None:
            raise GatewayClientError("API returned empty image description")

        # Parse title and description from response
        title = "Image Analysis"
        description = content

        title_match = re.search(r"title[:\s]+(.+?)(?:\n|$)", content, re.IGNORECASE)
        if title_match:
            title = title_match.group(1).strip()
            description = re.sub(
                r"title[:\s]+.+?(?:\n|$)", "", content, flags=re.IGNORECASE
            ).strip()

        return ImageDescriptionResult(title=title, description=description)

    # =========================================================================
    # Structured Output
    # =========================================================================

    async def generate_object(
        self,
        prompt: str,
        *,
        model: str | None = None,
        temperature: float | None = None,
    ) -> dict[str, object]:
        """
        Generate a structured JSON object.

        Args:
            prompt: Prompt describing the object to generate.
            model: Model to use (defaults to small model).
            temperature: Sampling temperature.

        Returns:
            Generated object as a dictionary.
        """
        params = TextGenerationParams(
            prompt=f"Respond with only valid JSON. {prompt}",
            model=model or self._config.small_model,
            temperature=temperature,
        )
        response = await self.generate_text(params)

        # Clean up markdown code blocks if present
        cleaned = response.strip()
        if cleaned.startswith("```json"):
            cleaned = cleaned[7:]
        if cleaned.startswith("```"):
            cleaned = cleaned[3:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]

        return json.loads(cleaned.strip())  # type: ignore[no-any-return]

