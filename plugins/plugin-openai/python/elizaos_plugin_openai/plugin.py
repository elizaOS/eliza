"""
OpenAI Plugin for elizaOS.

Provides a high-level interface to OpenAI APIs.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator

from elizaos_plugin_openai.client import OpenAIClient
from elizaos_plugin_openai.tokenization import (
    count_tokens,
    detokenize,
    tokenize,
    truncate_to_token_limit,
)
from elizaos_plugin_openai.types import (
    EmbeddingParams,
    ImageDescriptionParams,
    ImageDescriptionResult,
    ImageGenerationParams,
    ImageGenerationResult,
    ImageQuality,
    ImageSize,
    ImageStyle,
    OpenAIConfig,
    TextGenerationParams,
    TextToSpeechParams,
    TranscriptionParams,
    TTSOutputFormat,
    TTSVoice,
)


class OpenAIPlugin:
    """
    High-level OpenAI plugin for elizaOS.

    Provides convenient methods for all OpenAI API operations.
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = "https://api.openai.com/v1",
        small_model: str = "gpt-5-mini",
        large_model: str = "gpt-5",
        embedding_model: str = "text-embedding-3-small",
        embedding_dimensions: int = 1536,
    ) -> None:
        """
        Initialize the OpenAI plugin.

        Args:
            api_key: OpenAI API key (defaults to OPENAI_API_KEY env var).
            base_url: API base URL.
            small_model: Small model identifier.
            large_model: Large model identifier.
            embedding_model: Embedding model identifier.
            embedding_dimensions: Embedding dimensions.

        Raises:
            ValueError: If no API key is provided or found in environment.
        """
        key = api_key or os.environ.get("OPENAI_API_KEY")
        if not key:
            raise ValueError("OPENAI_API_KEY must be provided or set in environment variables")

        self._config = OpenAIConfig(
            api_key=key,
            base_url=base_url,
            small_model=small_model,
            large_model=large_model,
            embedding_model=embedding_model,
            embedding_dimensions=embedding_dimensions,
        )
        self._client = OpenAIClient(self._config)

    async def close(self) -> None:
        """Close the plugin and release resources."""
        await self._client.close()

    async def __aenter__(self) -> OpenAIPlugin:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    # =========================================================================
    # Text Generation
    # =========================================================================

    async def generate_text_small(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int | None = None,
    ) -> str:
        """
        Generate text using the small model (gpt-5-mini).

        Args:
            prompt: The prompt for generation.
            system: Optional system message.
            max_tokens: Maximum output tokens.

        Returns:
            Generated text.
        """
        params = TextGenerationParams(
            prompt=prompt,
            model=self._config.small_model,
            system=system,
            max_tokens=max_tokens,
        )
        return await self._client.generate_text(params)

    async def generate_text_large(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int | None = None,
    ) -> str:
        """
        Generate text using the large model (gpt-5).

        Args:
            prompt: The prompt for generation.
            system: Optional system message.
            max_tokens: Maximum output tokens.

        Returns:
            Generated text.
        """
        params = TextGenerationParams(
            prompt=prompt,
            model=self._config.large_model,
            system=system,
            max_tokens=max_tokens,
        )
        return await self._client.generate_text(params)

    async def stream_text(
        self,
        prompt: str,
        *,
        model: str | None = None,
        system: str | None = None,
    ) -> AsyncIterator[str]:
        """
        Stream text generation.

        Args:
            prompt: The prompt for generation.
            model: Model to use (defaults to large model).
            system: Optional system message.

        Yields:
            Text chunks as they are generated.
        """
        params = TextGenerationParams(
            prompt=prompt,
            model=model or self._config.large_model,
            system=system,
            stream=True,
        )
        async for chunk in self._client.stream_text(params):
            yield chunk

    # =========================================================================
    # Embeddings
    # =========================================================================

    async def create_embedding(self, text: str) -> list[float]:
        """
        Generate an embedding for text.

        Args:
            text: The text to embed.

        Returns:
            The embedding vector.
        """
        params = EmbeddingParams(
            text=text,
            model=self._config.embedding_model,
            dimensions=self._config.embedding_dimensions,
        )
        return await self._client.create_embedding(params)

    # =========================================================================
    # Images
    # =========================================================================

    async def generate_image(
        self,
        prompt: str,
        *,
        n: int = 1,
        size: ImageSize = ImageSize.SIZE_1024,
        quality: ImageQuality = ImageQuality.STANDARD,
        style: ImageStyle = ImageStyle.VIVID,
    ) -> list[ImageGenerationResult]:
        """
        Generate images using DALL-E.

        Args:
            prompt: The prompt describing the image.
            n: Number of images to generate.
            size: Image size.
            quality: Image quality.
            style: Image style.

        Returns:
            List of generated image results.
        """
        params = ImageGenerationParams(
            prompt=prompt,
            model=self._config.image_model,
            n=n,
            size=size,
            quality=quality,
            style=style,
        )
        return await self._client.generate_image(params)

    async def describe_image(
        self,
        image_url: str,
        *,
        prompt: str | None = None,
        max_tokens: int = 8192,
    ) -> ImageDescriptionResult:
        """
        Describe/analyze an image.

        Args:
            image_url: URL of the image.
            prompt: Custom analysis prompt.
            max_tokens: Maximum response tokens.

        Returns:
            Image description with title and description.
        """
        params = ImageDescriptionParams(
            image_url=image_url,
            max_tokens=max_tokens,
        )
        if prompt:
            params = ImageDescriptionParams(
                image_url=image_url,
                prompt=prompt,
                max_tokens=max_tokens,
            )
        return await self._client.describe_image(params)

    # =========================================================================
    # Audio
    # =========================================================================

    async def transcribe(
        self,
        audio_data: bytes,
        *,
        language: str | None = None,
        prompt: str | None = None,
        filename: str = "audio.webm",
    ) -> str:
        """
        Transcribe audio to text.

        Args:
            audio_data: Raw audio bytes.
            language: Language code (ISO-639-1).
            prompt: Optional prompt to guide transcription.
            filename: Filename hint for format detection.

        Returns:
            Transcribed text.
        """
        params = TranscriptionParams(
            model=self._config.transcription_model,
            language=language,
            prompt=prompt,
        )
        return await self._client.transcribe_audio(audio_data, params, filename)

    async def text_to_speech(
        self,
        text: str,
        *,
        voice: TTSVoice = TTSVoice.NOVA,
        format: TTSOutputFormat = TTSOutputFormat.MP3,
        speed: float = 1.0,
    ) -> bytes:
        """
        Convert text to speech.

        Args:
            text: Text to convert.
            voice: Voice to use.
            format: Output format.
            speed: Speech speed.

        Returns:
            Audio data as bytes.
        """
        params = TextToSpeechParams(
            text=text,
            model=self._config.tts_model,
            voice=voice,
            response_format=format,
            speed=speed,
        )
        return await self._client.text_to_speech(params)

    # =========================================================================
    # Tokenization
    # =========================================================================

    def tokenize(self, text: str, model: str | None = None) -> list[int]:
        """
        Tokenize text into token IDs.

        Args:
            text: Text to tokenize.
            model: Model to use (defaults to large model).

        Returns:
            List of token IDs.
        """
        return tokenize(text, model or self._config.large_model)

    def detokenize(self, tokens: list[int], model: str | None = None) -> str:
        """
        Decode token IDs to text.

        Args:
            tokens: Token IDs to decode.
            model: Model to use (defaults to large model).

        Returns:
            Decoded text.
        """
        return detokenize(tokens, model or self._config.large_model)

    def count_tokens(self, text: str, model: str | None = None) -> int:
        """
        Count tokens in text.

        Args:
            text: Text to count.
            model: Model to use (defaults to large model).

        Returns:
            Token count.
        """
        return count_tokens(text, model or self._config.large_model)

    def truncate_to_tokens(
        self,
        text: str,
        max_tokens: int,
        model: str | None = None,
    ) -> str:
        """
        Truncate text to fit within token limit.

        Args:
            text: Text to truncate.
            max_tokens: Maximum tokens.
            model: Model to use (defaults to large model).

        Returns:
            Truncated text.
        """
        return truncate_to_token_limit(text, max_tokens, model or self._config.large_model)

    # =========================================================================
    # Structured Output
    # =========================================================================

    async def generate_object(
        self,
        prompt: str,
        *,
        model: str | None = None,
        temperature: float = 0.0,
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
        import json

        params = TextGenerationParams(
            prompt=f"Respond with only valid JSON. {prompt}",
            model=model or self._config.small_model,
            temperature=temperature,
        )
        response = await self._client.generate_text(params)

        # Clean up markdown code blocks if present
        cleaned = response.strip()
        if cleaned.startswith("```json"):
            cleaned = cleaned[7:]
        if cleaned.startswith("```"):
            cleaned = cleaned[3:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]

        return json.loads(cleaned.strip())  # type: ignore[no-any-return]


# Convenience function to create plugin
def create_plugin(
    api_key: str | None = None,
    **kwargs: object,
) -> OpenAIPlugin:
    """
    Create an OpenAI plugin instance.

    Args:
        api_key: OpenAI API key (defaults to OPENAI_API_KEY env var).
        **kwargs: Additional configuration options.

    Returns:
        Configured OpenAIPlugin instance.
    """
    return OpenAIPlugin(api_key=api_key, **kwargs)  # type: ignore[arg-type]


# ============================================================================
# elizaOS Plugin (for use with AgentRuntime)
# ============================================================================


def create_openai_elizaos_plugin() -> ElizaOSPlugin:
    """
    Create an elizaOS-compatible plugin for OpenAI.

    This creates a proper elizaOS Plugin that can be passed to AgentRuntime.
    The plugin registers model handlers for TEXT_LARGE, TEXT_SMALL, and TEXT_EMBEDDING.

    Configuration is read from environment variables:
    - OPENAI_API_KEY (required)
    - OPENAI_BASE_URL (optional)
    - OPENAI_SMALL_MODEL (optional, default: gpt-5-mini)
    - OPENAI_LARGE_MODEL (optional, default: gpt-5)
    """
    from typing import Any

    from elizaos import Plugin
    from elizaos.types.model import ModelType
    from elizaos.types.runtime import IAgentRuntime

    # Client instance (created lazily on first use)
    _client: OpenAIPlugin | None = None

    def _get_client() -> OpenAIPlugin:
        nonlocal _client
        if _client is None:
            _client = OpenAIPlugin(
                api_key=os.environ.get("OPENAI_API_KEY"),
                base_url=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
                small_model=os.environ.get("OPENAI_SMALL_MODEL", "gpt-5-mini"),
                large_model=os.environ.get("OPENAI_LARGE_MODEL", "gpt-5"),
            )
        return _client

    async def text_large_handler(runtime: IAgentRuntime, params: dict[str, Any]) -> str:
        client = _get_client()
        # Note: gpt-5 models don't support temperature - use defaults
        return await client.generate_text_large(
            params.get("prompt", ""),
            system=params.get("system"),
            max_tokens=params.get("maxTokens"),
        )

    async def text_small_handler(runtime: IAgentRuntime, params: dict[str, Any]) -> str:
        client = _get_client()
        # Note: gpt-5-mini doesn't support temperature - use defaults
        return await client.generate_text_small(
            params.get("prompt", ""),
            system=params.get("system"),
            max_tokens=params.get("maxTokens"),
        )

    async def embedding_handler(runtime: IAgentRuntime, params: dict[str, Any]) -> list[float]:
        client = _get_client()
        return await client.create_embedding(params.get("text", ""))

    return Plugin(
        name="openai",
        description="OpenAI model provider for elizaOS",
        models={
            ModelType.TEXT_LARGE.value: text_large_handler,
            ModelType.TEXT_SMALL.value: text_small_handler,
            ModelType.TEXT_EMBEDDING.value: embedding_handler,
        },
    )


# Lazy plugin singleton
_openai_plugin_instance: Plugin | None = None


def get_openai_plugin() -> Plugin:
    """Get the singleton elizaOS OpenAI plugin instance."""
    global _openai_plugin_instance
    if _openai_plugin_instance is None:
        _openai_plugin_instance = create_openai_elizaos_plugin()
    return _openai_plugin_instance
