from __future__ import annotations

import os
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos import Plugin

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
    ResearchParams,
    ResearchResult,
    TextGenerationParams,
    TextToSpeechParams,
    TranscriptionParams,
    TTSOutputFormat,
    TTSVoice,
)


class OpenAIPlugin:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = "https://api.openai.com/v1",
        small_model: str = "gpt-5-mini",
        large_model: str = "gpt-5",
        embedding_model: str = "text-embedding-3-small",
        embedding_dimensions: int = 1536,
        research_model: str | None = None,
        research_timeout: float | None = None,
    ) -> None:
        key = api_key or os.environ.get("OPENAI_API_KEY")
        if not key:
            raise ValueError("OPENAI_API_KEY must be provided or set in environment variables")

        timeout_raw = (
            os.environ.get("OPENAI_TIMEOUT")
            or os.environ.get("OPENAI_REQUEST_TIMEOUT")
            or os.environ.get("OPENAI_HTTP_TIMEOUT")
        )
        timeout: float = 60.0
        if timeout_raw:
            try:
                timeout = float(timeout_raw)
            except ValueError:
                timeout = 60.0

        research_timeout_raw = os.environ.get("OPENAI_RESEARCH_TIMEOUT")
        research_timeout_value = research_timeout
        if research_timeout_value is None and research_timeout_raw:
            try:
                research_timeout_value = float(research_timeout_raw)
            except ValueError:
                research_timeout_value = None

        self._config = OpenAIConfig(
            api_key=key,
            base_url=base_url,
            small_model=small_model,
            large_model=large_model,
            embedding_model=embedding_model,
            embedding_dimensions=embedding_dimensions,
            research_model=research_model
            or os.environ.get("OPENAI_RESEARCH_MODEL")
            or "o3-deep-research",
            research_timeout=research_timeout_value or 3600.0,
            timeout=timeout,
        )
        self._client = OpenAIClient(self._config)

    async def close(self) -> None:
        await self._client.close()

    async def __aenter__(self) -> OpenAIPlugin:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def generate_text_small(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str:
        if temperature is None:
            params = TextGenerationParams(
                prompt=prompt,
                model=self._config.small_model,
                system=system,
                max_tokens=max_tokens,
            )
        else:
            params = TextGenerationParams(
                prompt=prompt,
                model=self._config.small_model,
                system=system,
                max_tokens=max_tokens,
                temperature=temperature,
            )
        return await self._client.generate_text(params)

    async def generate_text_large(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str:
        if temperature is None:
            params = TextGenerationParams(
                prompt=prompt,
                model=self._config.large_model,
                system=system,
                max_tokens=max_tokens,
            )
        else:
            params = TextGenerationParams(
                prompt=prompt,
                model=self._config.large_model,
                system=system,
                max_tokens=max_tokens,
                temperature=temperature,
            )
        return await self._client.generate_text(params)

    async def stream_text(
        self,
        prompt: str,
        *,
        model: str | None = None,
        system: str | None = None,
    ) -> AsyncIterator[str]:
        params = TextGenerationParams(
            prompt=prompt,
            model=model or self._config.large_model,
            system=system,
            stream=True,
        )
        async for chunk in self._client.stream_text(params):
            yield chunk

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

    async def generate_image(
        self,
        prompt: str,
        *,
        n: int = 1,
        size: ImageSize = ImageSize.SIZE_1024,
        quality: ImageQuality = ImageQuality.STANDARD,
        style: ImageStyle = ImageStyle.VIVID,
    ) -> list[ImageGenerationResult]:
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

    async def transcribe(
        self,
        audio_data: bytes,
        *,
        language: str | None = None,
        prompt: str | None = None,
        filename: str = "audio.webm",
    ) -> str:
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

    def tokenize(self, text: str, model: str | None = None) -> list[int]:
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

        cleaned = response.strip()
        if cleaned.startswith("```json"):
            cleaned = cleaned[7:]
        if cleaned.startswith("```"):
            cleaned = cleaned[3:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]

        return json.loads(cleaned.strip())  # type: ignore[no-any-return]

    async def deep_research(
        self,
        input_text: str,
        *,
        instructions: str | None = None,
        background: bool = False,
        tools: list[dict[str, object]] | None = None,
        max_tool_calls: int | None = None,
        model: str | None = None,
    ) -> ResearchResult:
        """
        Perform deep research using OpenAI's deep research models.

        Deep research models can find, analyze, and synthesize hundreds of sources
        to create comprehensive reports. They can take tens of minutes to complete.

        Args:
            input_text: The research question or topic.
            instructions: Optional instructions to guide the research.
            background: Run in background mode for long tasks.
            tools: List of tool configurations (web_search_preview, file_search, code_interpreter, mcp).
            max_tool_calls: Maximum number of tool calls to limit cost/latency.
            model: Model variant (o3-deep-research or o4-mini-deep-research).

        Returns:
            ResearchResult with text, annotations, and research process details.

        Example:
            >>> result = await plugin.deep_research(
            ...     "What is the economic impact of AI on global labor markets?",
            ...     tools=[{"type": "web_search_preview"}],
            ...     max_tool_calls=50,
            ... )
            >>> print(result.text)
        """
        params = ResearchParams(
            input=input_text,
            instructions=instructions,
            background=background,
            tools=tools or [{"type": "web_search_preview"}],
            max_tool_calls=max_tool_calls,
            model=model,
        )
        return await self._client.deep_research(params)


def create_plugin(
    api_key: str | None = None,
    **kwargs: object,
) -> OpenAIPlugin:
    return OpenAIPlugin(api_key=api_key, **kwargs)  # type: ignore[arg-type]


def create_openai_elizaos_plugin() -> Plugin:
    from typing import Any

    from elizaos import Plugin
    from elizaos.types.model import ModelType
    from elizaos.types.runtime import IAgentRuntime

    # Client instance (created lazily on first use)
    _client: OpenAIPlugin | None = None

    def _get_client() -> OpenAIPlugin:
        nonlocal _client
        if _client is None:
            research_timeout_env = os.environ.get("OPENAI_RESEARCH_TIMEOUT", "3600")
            try:
                research_timeout_value = float(research_timeout_env)
            except ValueError:
                research_timeout_value = 3600.0

            _client = OpenAIPlugin(
                api_key=os.environ.get("OPENAI_API_KEY"),
                base_url=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
                small_model=os.environ.get("OPENAI_SMALL_MODEL", "gpt-5-mini"),
                large_model=os.environ.get("OPENAI_LARGE_MODEL", "gpt-5"),
                research_model=os.environ.get("OPENAI_RESEARCH_MODEL"),
                research_timeout=research_timeout_value,
            )
        return _client

    async def text_large_handler(runtime: IAgentRuntime, params: dict[str, Any]) -> str:
        client = _get_client()
        temperature_raw = params.get("temperature")
        temperature = float(temperature_raw) if isinstance(temperature_raw, (int, float)) else None
        return await client.generate_text_large(
            params.get("prompt", ""),
            system=params.get("system"),
            max_tokens=params.get("maxTokens"),
            temperature=temperature,
        )

    async def text_small_handler(runtime: IAgentRuntime, params: dict[str, Any]) -> str:
        client = _get_client()
        temperature_raw = params.get("temperature")
        temperature = float(temperature_raw) if isinstance(temperature_raw, (int, float)) else None
        # Note: gpt-5-mini has limited temperature support - use defaults
        return await client.generate_text_small(
            params.get("prompt", ""),
            system=params.get("system"),
            max_tokens=params.get("maxTokens"),
            temperature=temperature,
        )

    async def embedding_handler(runtime: IAgentRuntime, params: dict[str, Any]) -> list[float]:
        client = _get_client()
        return await client.create_embedding(params.get("text", ""))

    async def text_large_stream_handler(
        runtime: IAgentRuntime, params: dict[str, Any]
    ) -> AsyncIterator[str]:
        """Streaming handler for large text generation."""
        client = _get_client()
        async for chunk in client.stream_text(
            params.get("prompt", ""),
            system=params.get("system"),
        ):
            yield chunk

    async def text_small_stream_handler(
        runtime: IAgentRuntime, params: dict[str, Any]
    ) -> AsyncIterator[str]:
        """Streaming handler for small text generation."""
        client = _get_client()
        # Use small model for streaming
        async for chunk in client.stream_text(
            params.get("prompt", ""),
            model=os.environ.get("OPENAI_SMALL_MODEL", "gpt-5-mini"),
            system=params.get("system"),
        ):
            yield chunk

    async def research_handler(runtime: IAgentRuntime, params: dict[str, Any]) -> dict[str, Any]:
        client = _get_client()
        result = await client.deep_research(
            params.get("input", ""),
            instructions=params.get("instructions"),
            background=params.get("background", False),
            tools=params.get("tools"),
            max_tool_calls=params.get("maxToolCalls"),
            model=params.get("model"),
        )
        return {
            "id": result.id,
            "text": result.text,
            "annotations": [
                {
                    "url": ann.url,
                    "title": ann.title,
                    "startIndex": ann.start_index,
                    "endIndex": ann.end_index,
                }
                for ann in result.annotations
            ],
            "outputItems": result.output_items,
            "status": result.status,
        }

    return Plugin(
        name="openai",
        description="OpenAI model provider for elizaOS",
        models={
            ModelType.TEXT_LARGE.value: text_large_handler,
            ModelType.TEXT_SMALL.value: text_small_handler,
            ModelType.TEXT_EMBEDDING.value: embedding_handler,
            ModelType.RESEARCH.value: research_handler,
        },
        streaming_models={
            ModelType.TEXT_LARGE_STREAM.value: text_large_stream_handler,
            ModelType.TEXT_SMALL_STREAM.value: text_small_stream_handler,
        },
    )


_openai_plugin_instance: Plugin | None = None


def get_openai_plugin() -> Plugin:
    global _openai_plugin_instance
    if _openai_plugin_instance is None:
        _openai_plugin_instance = create_openai_elizaos_plugin()
    return _openai_plugin_instance
