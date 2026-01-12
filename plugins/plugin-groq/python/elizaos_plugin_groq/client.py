import asyncio
import json
import logging
import re

import httpx

from elizaos_plugin_groq.error import GroqError, GroqErrorCode
from elizaos_plugin_groq.types import (
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatMessage,
    GenerateObjectParams,
    GenerateTextParams,
    GroqConfig,
    MessageRole,
    ModelInfo,
    ModelsResponse,
    TextToSpeechParams,
    TranscriptionParams,
    TranscriptionResponse,
)

logger = logging.getLogger(__name__)

JsonValue = str | int | float | bool | None | dict[str, "JsonValue"] | list["JsonValue"]
JsonObject = dict[str, JsonValue]


class GroqClient:
    def __init__(
        self,
        api_key: str,
        base_url: str | None = None,
        config: GroqConfig | None = None,
    ) -> None:
        if config:
            self.config = config
        else:
            if not api_key:
                raise GroqError("API key is required", code=GroqErrorCode.INVALID_API_KEY)
            self.config = GroqConfig(
                api_key=api_key,
                base_url=base_url or "https://api.groq.com/openai/v1",
            )

        self._client = httpx.AsyncClient(
            base_url=self.config.base_url,
            headers={
                "Authorization": f"Bearer {self.config.api_key}",
                "Content-Type": "application/json",
            },
            timeout=60.0,
        )

    async def __aenter__(self) -> "GroqClient":
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()

    async def close(self) -> None:
        await self._client.aclose()

    async def generate_text_small(self, params: GenerateTextParams) -> str:
        return await self._generate_text(self.config.small_model, params)

    async def generate_text_large(self, params: GenerateTextParams) -> str:
        return await self._generate_text(self.config.large_model, params)

    async def _generate_text(self, model: str, params: GenerateTextParams) -> str:
        messages: list[ChatMessage] = []
        if params.system:
            messages.append(ChatMessage(role=MessageRole.SYSTEM, content=params.system))
        messages.append(ChatMessage(role=MessageRole.USER, content=params.prompt))

        request = ChatCompletionRequest(
            model=model,
            messages=messages,
            temperature=params.temperature,
            max_tokens=params.max_tokens,
            frequency_penalty=params.frequency_penalty,
            presence_penalty=params.presence_penalty,
            stop=params.stop if params.stop else None,
        )

        data = await self._request(
            "POST", "/chat/completions", json=request.model_dump(exclude_none=True)
        )
        response = ChatCompletionResponse.model_validate(data)

        if not response.choices:
            raise GroqError("No choices returned", code=GroqErrorCode.INVALID_REQUEST)

        return response.choices[0].message.content

    async def generate_object_small(self, params: GenerateObjectParams) -> JsonObject:
        return await self._generate_object_with_model(self.config.small_model, params)

    async def generate_object_large(self, params: GenerateObjectParams) -> JsonObject:
        return await self._generate_object_with_model(self.config.large_model, params)

    async def generate_object(self, params: GenerateObjectParams) -> JsonObject:
        return await self.generate_object_large(params)

    async def _generate_object_with_model(
        self, model: str, params: GenerateObjectParams
    ) -> JsonObject:
        text = await self._generate_text(
            model,
            GenerateTextParams(prompt=params.prompt, temperature=params.temperature),
        )

        json_str = _extract_json(text)
        result: JsonObject = json.loads(json_str)
        return result

    async def transcribe(self, params: TranscriptionParams) -> str:
        async with httpx.AsyncClient(
            base_url=self.config.base_url,
            headers={"Authorization": f"Bearer {self.config.api_key}"},
            timeout=60.0,
        ) as client:
            response = await client.post(
                "/audio/transcriptions",
                files={"file": (f"audio.{params.format}", params.audio, f"audio/{params.format}")},
                data={"model": self.config.transcription_model},
            )

            if response.status_code != 200:
                raise GroqError.from_response(response.status_code, response.text)

            return TranscriptionResponse.model_validate(response.json()).text

    async def text_to_speech(self, params: TextToSpeechParams) -> bytes:
        voice = params.voice or self.config.tts_voice

        response = await self._client.post(
            "/audio/speech",
            json={"model": self.config.tts_model, "voice": voice, "input": params.text},
        )

        if response.status_code != 200:
            raise GroqError.from_response(response.status_code, response.text)

        return response.content

    async def list_models(self) -> list[ModelInfo]:
        data = await self._request("GET", "/models")
        return ModelsResponse.model_validate(data).data

    async def _request(self, method: str, path: str, **kwargs: object) -> JsonObject:
        for attempt in range(3):
            try:
                response = await self._client.request(method, path, **kwargs)

                if response.status_code == 200:
                    result: JsonObject = response.json()
                    return result

                error = GroqError.from_response(response.status_code, response.text)

                if error.is_retryable and attempt < 2:
                    delay_ms = error.retry_delay_ms or 10000
                    logger.warning("Rate limited, retrying in %dms", delay_ms)
                    await asyncio.sleep(delay_ms / 1000)
                    continue

                raise error

            except httpx.RequestError as e:
                if attempt < 2:
                    await asyncio.sleep(1)
                    continue
                raise GroqError(str(e), code=GroqErrorCode.SERVER_ERROR) from e

        raise GroqError("Request failed after retries")


def _extract_json(text: str) -> str:
    if match := re.search(r"```json\s*([\s\S]*?)\s*```", text):
        return match.group(1).strip()
    if match := re.search(r"```\w*\s*([\s\S]*?)\s*```", text):
        return match.group(1).strip()
    if match := re.search(r"\{[\s\S]*\}", text):
        return match.group(0)
    if match := re.search(r"\[[\s\S]*\]", text):
        return match.group(0)
    return text
