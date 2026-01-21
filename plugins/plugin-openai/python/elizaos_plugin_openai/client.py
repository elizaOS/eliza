from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING

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
    ResearchAnnotation,
    ResearchParams,
    ResearchResult,
    TextGenerationParams,
    TextToSpeechParams,
    TranscriptionParams,
    TranscriptionResponse,
)

if TYPE_CHECKING:
    from pathlib import Path


class OpenAIClientError(Exception):
    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class OpenAIClient:
    def __init__(self, config: OpenAIConfig) -> None:
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
        await self._client.aclose()

    async def __aenter__(self) -> OpenAIClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    def _raise_for_status(self, response: httpx.Response) -> None:
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

    async def list_models(self) -> ModelsResponse:
        response = await self._client.get("/models")
        self._raise_for_status(response)
        return ModelsResponse.model_validate(response.json())

    async def create_embedding(self, params: EmbeddingParams) -> list[float]:
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

    _NO_TEMPERATURE_MODELS = frozenset(
        {"o1", "o1-preview", "o1-mini", "o3", "o3-mini", "gpt-5", "gpt-5-mini"}
    )

    @staticmethod
    def _model_supports_temperature(model: str) -> bool:
        model_lower = model.lower()
        for no_temp_model in OpenAIClient._NO_TEMPERATURE_MODELS:
            if no_temp_model in model_lower:
                return False
        return True

    async def generate_text(self, params: TextGenerationParams) -> str:
        messages: list[dict[str, str]] = []
        if params.system:
            messages.append({"role": "system", "content": params.system})
        messages.append({"role": "user", "content": params.prompt})

        request_body: dict[str, object] = {
            "model": params.model,
            "messages": messages,
        }

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

        response: httpx.Response | None = None
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                response = await self._client.post("/chat/completions", json=request_body)
                last_error = None
                break
            except httpx.TimeoutException as e:
                last_error = e
                # Exponential backoff: 1s, 2s, 4s
                await asyncio.sleep(2**attempt)

        if response is None:
            msg = "OpenAI request timed out after 3 attempts"
            if last_error:
                msg = f"{msg}: {last_error}"
            raise OpenAIClientError(msg)

        self._raise_for_status(response)

        completion = ChatCompletionResponse.model_validate(response.json())
        if not completion.choices:
            raise OpenAIClientError("API returned no choices")

        content = completion.choices[0].message.content
        if content is None:
            raise OpenAIClientError("API returned empty content")

        return content

    async def stream_text(self, params: TextGenerationParams) -> AsyncIterator[str]:
        messages: list[dict[str, str]] = []
        if params.system:
            messages.append({"role": "system", "content": params.system})
        messages.append({"role": "user", "content": params.prompt})

        request_body: dict[str, object] = {
            "model": params.model,
            "messages": messages,
            "stream": True,
        }

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

        async with self._client.stream("POST", "/chat/completions", json=request_body) as response:
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

    async def generate_image(self, params: ImageGenerationParams) -> list[ImageGenerationResult]:
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

    async def describe_image(self, params: ImageDescriptionParams) -> ImageDescriptionResult:
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

        title = "Image Analysis"
        description = content

        import re

        title_match = re.search(r"title[:\s]+(.+?)(?:\n|$)", content, re.IGNORECASE)
        if title_match:
            title = title_match.group(1).strip()
            description = re.sub(
                r"title[:\s]+.+?(?:\n|$)", "", content, flags=re.IGNORECASE
            ).strip()

        return ImageDescriptionResult(title=title, description=description)

    async def transcribe_audio(
        self,
        audio_data: bytes,
        params: TranscriptionParams,
        filename: str = "audio.webm",
    ) -> str:
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
        file_path: Path,
        params: TranscriptionParams,
    ) -> str:
        import aiofiles  # type: ignore[import-untyped]

        async with aiofiles.open(file_path, "rb") as f:
            audio_data = await f.read()

        return await self.transcribe_audio(audio_data, params, file_path.name)

    async def text_to_speech(self, params: TextToSpeechParams) -> bytes:
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
        output_path: Path,
    ) -> None:
        import aiofiles

        audio_data = await self.text_to_speech(params)
        async with aiofiles.open(output_path, "wb") as f:
            await f.write(audio_data)

    async def deep_research(self, params: ResearchParams) -> ResearchResult:
        """
        Perform deep research using OpenAI's Responses API.

        Deep research models can take tens of minutes to complete.
        Use background mode for long-running tasks.

        Args:
            params: Research parameters including input, tools, and options.

        Returns:
            ResearchResult with text, annotations, and output items.
        """
        model = params.model or self._config.research_model

        # Build request body for Responses API
        request_body: dict[str, object] = {
            "model": model,
            "input": params.input,
        }

        if params.instructions:
            request_body["instructions"] = params.instructions

        if params.background:
            request_body["background"] = params.background

        if params.tools:
            # Convert tool configs to API format
            api_tools = []
            for tool in params.tools:
                tool_type = tool.get("type", "")
                if tool_type == "web_search_preview":
                    api_tools.append({"type": "web_search_preview"})
                elif tool_type == "file_search":
                    api_tools.append(
                        {
                            "type": "file_search",
                            "vector_store_ids": tool.get(
                                "vectorStoreIds", tool.get("vector_store_ids", [])
                            ),
                        }
                    )
                elif tool_type == "code_interpreter":
                    api_tools.append(
                        {
                            "type": "code_interpreter",
                            "container": tool.get("container", {"type": "auto"}),
                        }
                    )
                elif tool_type == "mcp":
                    api_tools.append(
                        {
                            "type": "mcp",
                            "server_label": tool.get("serverLabel", tool.get("server_label", "")),
                            "server_url": tool.get("serverUrl", tool.get("server_url", "")),
                            "require_approval": tool.get(
                                "requireApproval", tool.get("require_approval", "never")
                            ),
                        }
                    )
            request_body["tools"] = api_tools
        else:
            # Default to web search if no tools specified
            request_body["tools"] = [{"type": "web_search_preview"}]

        if params.max_tool_calls is not None:
            request_body["max_tool_calls"] = params.max_tool_calls

        if params.reasoning_summary:
            request_body["reasoning"] = {"summary": params.reasoning_summary}

        # Use longer timeout for research requests
        async with httpx.AsyncClient(
            base_url=self._config.base_url,
            headers={
                "Authorization": f"Bearer {self._config.api_key}",
                "Content-Type": "application/json",
            },
            timeout=httpx.Timeout(self._config.research_timeout),
        ) as client:
            response = await client.post("/responses", json=request_body)

        self._raise_for_status(response)
        data = response.json()

        if "error" in data:
            raise OpenAIClientError(
                f"Research error: {data['error'].get('message', 'Unknown error')}"
            )

        # Extract text and annotations from response
        text = data.get("output_text", "")
        annotations: list[ResearchAnnotation] = []
        output_items: list[dict[str, object]] = []

        # Process output items
        for item in data.get("output", []):
            item_type = item.get("type", "")

            if item_type == "message":
                # Extract text and annotations from message
                for content in item.get("content", []):
                    if not text:
                        text = content.get("text", "")
                    for ann in content.get("annotations", []):
                        annotations.append(
                            ResearchAnnotation(
                                url=ann.get("url", ""),
                                title=ann.get("title", ""),
                                start_index=ann.get("start_index", 0),
                                end_index=ann.get("end_index", 0),
                            )
                        )

            # Add all items to output_items for transparency
            output_items.append(item)

        return ResearchResult(
            id=data.get("id", ""),
            text=text,
            annotations=annotations,
            output_items=output_items,
            status=data.get("status"),
        )
