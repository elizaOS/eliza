"""
OpenAI API Client

Async HTTP client for OpenAI API interactions using httpx.
All methods use strong typing and fail-fast error handling.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, AsyncIterator

import httpx

from elizaos_plugin_openai.types import (
    ChatCompletionResponse,
    EmbeddingParams,
    EmbeddingResponse,
    ImageDescriptionParams,
    ImageDescriptionResult,
    ImageGenerationParams,
    ImageGenerationResponse,
    ImageGenerationResult,
    ModelsResponse,
    OpenAIConfig,
    TextGenerationParams,
    TextToSpeechParams,
    TranscriptionParams,
    TranscriptionResponse,
)

if TYPE_CHECKING:
    from pathlib import Path


class OpenAIClientError(Exception):
    """Base exception for OpenAI client errors."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class OpenAIClient:
    """
    Async OpenAI API client.

    All methods are async and use httpx for HTTP requests.
    Errors are raised immediately - no silent failures.
    """

    def __init__(self, config: OpenAIConfig) -> None:
        """
        Initialize the OpenAI client.

        Args:
            config: OpenAI configuration with API key and settings.
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

    async def __aenter__(self) -> "OpenAIClient":
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

        raise OpenAIClientError(
            f"OpenAI API error ({response.status_code}): {error_message}",
            status_code=response.status_code,
        )

    @staticmethod
    def _get_audio_mime_type(filename: str) -> str:
        """Get the MIME type for an audio file based on its extension."""
        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
        mime_types = {
            "mp3": "audio/mpeg",
            "mpga": "audio/mpeg",
            "mpeg": "audio/mpeg",
            "wav": "audio/wav",
            "flac": "audio/flac",
            "m4a": "audio/mp4",
            "mp4": "audio/mp4",
            "ogg": "audio/ogg",
            "oga": "audio/ogg",
            "webm": "audio/webm",
        }
        return mime_types.get(ext, "audio/webm")

    # =========================================================================
    # Models
    # =========================================================================

    async def list_models(self) -> ModelsResponse:
        """
        List available models.

        Returns:
            ModelsResponse with list of available models.

        Raises:
            OpenAIClientError: If the API request fails.
        """
        response = await self._client.get("/models")
        self._raise_for_status(response)
        return ModelsResponse.model_validate(response.json())

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
            OpenAIClientError: If the API request fails.
        """
        request_body: dict[str, str | int] = {
            "model": params.model,
            "input": params.text,
        }
        if params.dimensions is not None:
            request_body["dimensions"] = params.dimensions

        response = await self._client.post("/embeddings", json=request_body)
        self._raise_for_status(response)

        embedding_response = EmbeddingResponse.model_validate(response.json())
        if not embedding_response.data:
            raise OpenAIClientError("API returned empty embedding data")

        return embedding_response.data[0].embedding

    # =========================================================================
    # Text Generation
    # =========================================================================

    # Models that don't support temperature/sampling parameters (reasoning models)
    _NO_TEMPERATURE_MODELS = frozenset({"o1", "o1-preview", "o1-mini", "o3", "o3-mini", "gpt-5", "gpt-5-mini"})

    @staticmethod
    def _model_supports_temperature(model: str) -> bool:
        """Check if a model supports temperature parameter."""
        model_lower = model.lower()
        for no_temp_model in OpenAIClient._NO_TEMPERATURE_MODELS:
            if no_temp_model in model_lower:
                return False
        return True

    async def generate_text(self, params: TextGenerationParams) -> str:
        """
        Generate text using the chat completions API.

        Args:
            params: Text generation parameters.

        Returns:
            Generated text content.

        Raises:
            OpenAIClientError: If the API request fails.
        """
        messages: list[dict[str, str]] = []
        if params.system:
            messages.append({"role": "system", "content": params.system})
        messages.append({"role": "user", "content": params.prompt})

        request_body: dict[str, object] = {
            "model": params.model,
            "messages": messages,
        }

        # Only add temperature/sampling params for models that support them
        # gpt-5 models use max_completion_tokens instead of max_tokens
        if self._model_supports_temperature(params.model):
            request_body["temperature"] = params.temperature
            request_body["frequency_penalty"] = params.frequency_penalty
            request_body["presence_penalty"] = params.presence_penalty
            if params.max_tokens is not None:
                request_body["max_tokens"] = params.max_tokens
            if params.stop is not None:
                request_body["stop"] = params.stop
        else:
            # Reasoning models (gpt-5, o1, o3) use max_completion_tokens
            if params.max_tokens is not None:
                request_body["max_completion_tokens"] = params.max_tokens

        response = await self._client.post("/chat/completions", json=request_body)
        self._raise_for_status(response)

        completion = ChatCompletionResponse.model_validate(response.json())
        if not completion.choices:
            raise OpenAIClientError("API returned no choices")

        content = completion.choices[0].message.content
        if content is None:
            raise OpenAIClientError("API returned empty content")

        return content

    async def stream_text(
        self, params: TextGenerationParams
    ) -> AsyncIterator[str]:
        """
        Stream text generation using the chat completions API.

        Args:
            params: Text generation parameters.

        Yields:
            Text chunks as they are generated.

        Raises:
            OpenAIClientError: If the API request fails.
        """
        messages: list[dict[str, str]] = []
        if params.system:
            messages.append({"role": "system", "content": params.system})
        messages.append({"role": "user", "content": params.prompt})

        request_body: dict[str, object] = {
            "model": params.model,
            "messages": messages,
            "stream": True,
        }

        # Only add temperature/sampling params for models that support them
        # gpt-5 models use max_completion_tokens instead of max_tokens
        if self._model_supports_temperature(params.model):
            request_body["temperature"] = params.temperature
            request_body["frequency_penalty"] = params.frequency_penalty
            request_body["presence_penalty"] = params.presence_penalty
            if params.max_tokens is not None:
                request_body["max_tokens"] = params.max_tokens
            if params.stop is not None:
                request_body["stop"] = params.stop
        else:
            # Reasoning models (gpt-5, o1, o3) use max_completion_tokens
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
    # Image Generation
    # =========================================================================

    async def generate_image(
        self, params: ImageGenerationParams
    ) -> list[ImageGenerationResult]:
        """
        Generate images using DALL-E.

        Args:
            params: Image generation parameters.

        Returns:
            List of generated image results with URLs.

        Raises:
            OpenAIClientError: If the API request fails.
        """
        request_body: dict[str, object] = {
            "model": params.model,
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

    async def describe_image(self, params: ImageDescriptionParams) -> ImageDescriptionResult:
        """
        Describe/analyze an image using GPT-4 Vision.

        Args:
            params: Image description parameters.

        Returns:
            ImageDescriptionResult with title and description.

        Raises:
            OpenAIClientError: If the API request fails.
        """
        request_body: dict[str, object] = {
            "model": params.model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": params.prompt},
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
            raise OpenAIClientError("API returned no choices for image description")

        content = completion.choices[0].message.content
        if content is None:
            raise OpenAIClientError("API returned empty image description")

        # Parse title and description from response
        title = "Image Analysis"
        description = content

        import re

        title_match = re.search(r"title[:\s]+(.+?)(?:\n|$)", content, re.IGNORECASE)
        if title_match:
            title = title_match.group(1).strip()
            description = re.sub(r"title[:\s]+.+?(?:\n|$)", "", content, flags=re.IGNORECASE).strip()

        return ImageDescriptionResult(title=title, description=description)

    # =========================================================================
    # Audio Transcription
    # =========================================================================

    async def transcribe_audio(
        self,
        audio_data: bytes,
        params: TranscriptionParams,
        filename: str = "audio.webm",
    ) -> str:
        """
        Transcribe audio using Whisper.

        Args:
            audio_data: Raw audio bytes.
            params: Transcription parameters.
            filename: Name of the audio file.

        Returns:
            Transcribed text.

        Raises:
            OpenAIClientError: If the API request fails.
        """
        files = {"file": (filename, audio_data, self._get_audio_mime_type(filename))}
        data: dict[str, str] = {"model": params.model}

        if params.language:
            data["language"] = params.language
        if params.prompt:
            data["prompt"] = params.prompt
        data["temperature"] = str(params.temperature)
        data["response_format"] = params.response_format.value

        if params.timestamp_granularities:
            for granularity in params.timestamp_granularities:
                data["timestamp_granularities[]"] = granularity.value

        # Use a fresh client for multipart form to avoid Content-Type conflicts
        async with httpx.AsyncClient(
            base_url=self._config.base_url,
            headers={"Authorization": f"Bearer {self._config.api_key}"},
            timeout=httpx.Timeout(self._config.timeout),
        ) as client:
            response = await client.post("/audio/transcriptions", files=files, data=data)

        self._raise_for_status(response)

        transcription = TranscriptionResponse.model_validate(response.json())
        return transcription.text

    async def transcribe_audio_file(
        self,
        file_path: "Path",
        params: TranscriptionParams,
    ) -> str:
        """
        Transcribe an audio file using Whisper.

        Args:
            file_path: Path to the audio file.
            params: Transcription parameters.

        Returns:
            Transcribed text.

        Raises:
            OpenAIClientError: If the API request fails.
            FileNotFoundError: If the file doesn't exist.
        """
        import aiofiles

        async with aiofiles.open(file_path, "rb") as f:
            audio_data = await f.read()

        return await self.transcribe_audio(audio_data, params, file_path.name)

    # =========================================================================
    # Text-to-Speech
    # =========================================================================

    async def text_to_speech(self, params: TextToSpeechParams) -> bytes:
        """
        Convert text to speech.

        Args:
            params: TTS parameters.

        Returns:
            Audio data as bytes.

        Raises:
            OpenAIClientError: If the API request fails.
        """
        request_body: dict[str, object] = {
            "model": params.model,
            "input": params.text,
            "voice": params.voice.value,
            "response_format": params.response_format.value,
            "speed": params.speed,
        }

        response = await self._client.post("/audio/speech", json=request_body)
        self._raise_for_status(response)

        return response.content

    async def text_to_speech_file(
        self,
        params: TextToSpeechParams,
        output_path: "Path",
    ) -> None:
        """
        Convert text to speech and save to file.

        Args:
            params: TTS parameters.
            output_path: Path to save the audio file.

        Raises:
            OpenAIClientError: If the API request fails.
        """
        import aiofiles

        audio_data = await self.text_to_speech(params)
        async with aiofiles.open(output_path, "wb") as f:
            await f.write(audio_data)

