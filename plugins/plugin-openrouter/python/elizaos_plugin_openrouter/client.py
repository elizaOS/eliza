from __future__ import annotations

import json
import re
from typing import Any

import httpx

from elizaos_plugin_openrouter.config import OpenRouterConfig
from elizaos_plugin_openrouter.errors import (
    NetworkError,
    RateLimitError,
)
from elizaos_plugin_openrouter.types import (
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatMessage,
    EmbeddingParams,
    EmbeddingResponse,
    EmbeddingsRequest,
    EmbeddingsResponse,
    ModelInfo,
    ObjectGenerationParams,
    ObjectGenerationResponse,
    TextGenerationParams,
    TextGenerationResponse,
)


class OpenRouterClient:
    _config: OpenRouterConfig
    _http_client: httpx.AsyncClient

    def __init__(self, config: OpenRouterConfig) -> None:
        self._config = config
        self._http_client = httpx.AsyncClient(
            timeout=config.timeout_seconds,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {config.api_key}",
                "HTTP-Referer": "https://elizaos.ai",
                "X-Title": "ElizaOS",
            },
        )

    @property
    def config(self) -> OpenRouterConfig:
        return self._config

    async def close(self) -> None:
        await self._http_client.aclose()

    async def __aenter__(self) -> OpenRouterClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def list_models(self) -> list[ModelInfo]:
        response = await self._http_client.get(self._config.models_url)
        if response.is_success:
            data = response.json()
            models_data = data.get("data", [])
            return [ModelInfo.model_validate(m) for m in models_data]
        raise NetworkError(f"Failed to list models: {response.text}", response.status_code)

    async def generate_text_small(
        self, params: TextGenerationParams | str
    ) -> TextGenerationResponse:
        if isinstance(params, str):
            params = TextGenerationParams(prompt=params)
        return await self._generate_text_with_model(params, self._config.small_model)

    async def generate_text_large(
        self, params: TextGenerationParams | str
    ) -> TextGenerationResponse:
        if isinstance(params, str):
            params = TextGenerationParams(prompt=params)
        return await self._generate_text_with_model(params, self._config.large_model)

    async def _generate_text_with_model(
        self, params: TextGenerationParams, model: str
    ) -> TextGenerationResponse:
        messages: list[ChatMessage] = []
        if params.system:
            messages.append(ChatMessage(role="system", content=params.system))
        messages.append(ChatMessage(role="user", content=params.prompt))

        request = ChatCompletionRequest(
            model=model,
            messages=messages,
            temperature=params.temperature,
            max_tokens=params.max_tokens,
            top_p=params.top_p,
            frequency_penalty=params.frequency_penalty,
            presence_penalty=params.presence_penalty,
            stop=params.stop,
        )

        response = await self._send_chat_request(request)

        text = ""
        if response.choices:
            text = response.choices[0].message.content

        return TextGenerationResponse(
            text=text,
            model=response.model,
            usage=response.usage,
        )

    async def generate_object_small(
        self, params: ObjectGenerationParams | str
    ) -> ObjectGenerationResponse:
        if isinstance(params, str):
            params = ObjectGenerationParams(prompt=params)
        return await self._generate_object_with_model(params, self._config.small_model)

    async def generate_object_large(
        self, params: ObjectGenerationParams | str
    ) -> ObjectGenerationResponse:
        if isinstance(params, str):
            params = ObjectGenerationParams(prompt=params)
        return await self._generate_object_with_model(params, self._config.large_model)

    async def _generate_object_with_model(
        self, params: ObjectGenerationParams, model: str
    ) -> ObjectGenerationResponse:
        if "```json" in params.prompt or "respond with valid JSON" in params.prompt:
            json_prompt = params.prompt
        else:
            json_prompt = (
                f"{params.prompt}\n"
                "Please respond with valid JSON only, without any explanations, "
                "markdown formatting, or additional text."
            )

        if params.system:
            system = f"{params.system}\nYou must respond with valid JSON only."
        else:
            system = "You must respond with valid JSON only. No markdown, no code blocks."

        messages: list[ChatMessage] = [
            ChatMessage(role="system", content=system),
            ChatMessage(role="user", content=json_prompt),
        ]

        request = ChatCompletionRequest(
            model=model,
            messages=messages,
            temperature=params.temperature,
            max_tokens=params.max_tokens,
            response_format={"type": "json_object"},
        )

        response = await self._send_chat_request(request)

        text = ""
        if response.choices:
            text = response.choices[0].message.content

        parsed_object = self._extract_json(text)

        return ObjectGenerationResponse(
            object=parsed_object,
            model=response.model,
            usage=response.usage,
        )

    async def generate_embedding(self, params: EmbeddingParams | str) -> EmbeddingResponse:
        if isinstance(params, str):
            params = EmbeddingParams(text=params)

        request = EmbeddingsRequest(
            model=self._config.embedding_model,
            input=params.text,
        )

        try:
            response = await self._http_client.post(
                self._config.embeddings_url,
                json=request.model_dump(exclude_none=True),
            )
        except httpx.RequestError as e:
            raise NetworkError(f"Request failed: {e}") from e

        if response.is_success:
            data = EmbeddingsResponse.model_validate(response.json())
            if data.data:
                return EmbeddingResponse(
                    embedding=data.data[0].embedding,
                    model=data.model,
                )
            raise NetworkError("API returned no embedding data")

        raise NetworkError(
            f"Failed to generate embedding: {response.text}",
            response.status_code,
        )

    async def _send_chat_request(self, request: ChatCompletionRequest) -> ChatCompletionResponse:
        try:
            response = await self._http_client.post(
                self._config.chat_completions_url,
                json=request.model_dump(exclude_none=True),
            )
        except httpx.TimeoutException as e:
            raise NetworkError(f"Request timed out: {e}") from e
        except httpx.RequestError as e:
            raise NetworkError(f"Request failed: {e}") from e

        if response.is_success:
            return ChatCompletionResponse.model_validate(response.json())

        status_code = response.status_code
        if status_code == 429:
            raise RateLimitError(retry_after_seconds=60)

        raise NetworkError(f"API request failed: {response.text}", status_code)

    def _extract_json(self, text: str) -> dict[str, Any]:
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

        json_str = self._extract_from_code_block(text)
        if json_str:
            try:
                parsed = json.loads(json_str)
                if isinstance(parsed, dict):
                    return parsed
            except json.JSONDecodeError:
                pass

        json_str = self._find_json_object(text)
        if json_str:
            try:
                parsed = json.loads(json_str)
                if isinstance(parsed, dict):
                    return parsed
            except json.JSONDecodeError:
                pass

        return {}

    def _extract_from_code_block(self, text: str) -> str | None:
        json_block_match = re.search(r"```json\s*([\s\S]*?)\s*```", text)
        if json_block_match:
            return json_block_match.group(1).strip()

        for match in re.finditer(r"```(?:\w*)\s*([\s\S]*?)\s*```", text):
            content = match.group(1).strip()
            if content.startswith("{") and content.endswith("}"):
                return content

        return None

    def _find_json_object(self, text: str) -> str | None:
        trimmed = text.strip()
        if trimmed.startswith("{") and trimmed.endswith("}"):
            return trimmed

        best: str | None = None
        depth = 0
        start: int | None = None

        for i, char in enumerate(text):
            if char == "{":
                if depth == 0:
                    start = i
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0 and start is not None:
                    candidate = text[start : i + 1]
                    if best is None or len(candidate) > len(best):
                        best = candidate

        return best
