from __future__ import annotations

import json
import re
from typing import Any

import httpx

from elizaos_plugin_ollama.config import OllamaConfig
from elizaos_plugin_ollama.errors import (
    ConnectionError,
    ModelNotFoundError,
    NetworkError,
)
from elizaos_plugin_ollama.types import (
    EmbeddingParams,
    EmbeddingResponse,
    EmbeddingsRequest,
    EmbeddingsResponse,
    GenerateRequest,
    GenerateResponse,
    ModelInfo,
    ObjectGenerationParams,
    ObjectGenerationResponse,
    TextGenerationParams,
    TextGenerationResponse,
)


class OllamaClient:
    _config: OllamaConfig
    _http_client: httpx.AsyncClient

    def __init__(self, config: OllamaConfig) -> None:
        self._config = config
        self._http_client = httpx.AsyncClient(
            timeout=config.timeout_seconds,
            headers={"Content-Type": "application/json"},
        )

    @property
    def config(self) -> OllamaConfig:
        return self._config

    async def close(self) -> None:
        await self._http_client.aclose()

    async def __aenter__(self) -> OllamaClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def list_models(self) -> list[ModelInfo]:
        try:
            response = await self._http_client.get(self._config.tags_url)
            if response.is_success:
                data = response.json()
                models_data = data.get("models", [])
                return [ModelInfo.model_validate(m) for m in models_data]
            raise NetworkError(f"Failed to list models: {response.text}", response.status_code)
        except httpx.ConnectError as e:
            raise ConnectionError(self._config.base_url, str(e)) from e

    async def ensure_model_available(self, model: str) -> bool:
        try:
            response = await self._http_client.post(
                self._config.show_url,
                json={"model": model},
            )
            if response.is_success:
                return True

            response = await self._http_client.post(
                self._config.pull_url,
                json={"model": model, "stream": False},
            )
            return response.is_success
        except httpx.RequestError:
            return False

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
        await self.ensure_model_available(model)

        options: dict[str, Any] = {}
        if params.temperature is not None:
            options["temperature"] = params.temperature
        if params.top_p is not None:
            options["top_p"] = params.top_p
        if params.top_k is not None:
            options["top_k"] = params.top_k
        if params.max_tokens is not None:
            options["num_predict"] = params.max_tokens
        if params.stop is not None:
            options["stop"] = params.stop

        request = GenerateRequest(
            model=model,
            prompt=params.prompt,
            system=params.system,
            stream=False,
            options=options if options else None,
        )

        response = await self._send_generate_request(request)

        return TextGenerationResponse(
            text=response.response,
            model=response.model,
            done=response.done,
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
        await self.ensure_model_available(model)

        if "```json" in params.prompt or "respond with valid JSON" in params.prompt:
            json_prompt = params.prompt
        else:
            json_prompt = f"{params.prompt}\nPlease respond with valid JSON only, without any explanations, markdown formatting, or additional text."

        if params.system:
            system = f"{params.system}\nYou must respond with valid JSON only."
        else:
            system = "You must respond with valid JSON only. No markdown, no code blocks."

        options: dict[str, Any] = {}
        if params.temperature is not None:
            options["temperature"] = params.temperature
        if params.max_tokens is not None:
            options["num_predict"] = params.max_tokens

        request = GenerateRequest(
            model=model,
            prompt=json_prompt,
            system=system,
            stream=False,
            format="json",
            options=options if options else None,
        )

        response = await self._send_generate_request(request)

        parsed_object = self._extract_json(response.response)

        return ObjectGenerationResponse(
            object=parsed_object,
            model=response.model,
        )

    async def generate_embedding(self, params: EmbeddingParams | str) -> EmbeddingResponse:
        if isinstance(params, str):
            params = EmbeddingParams(text=params)

        model = self._config.embedding_model
        await self.ensure_model_available(model)

        request = EmbeddingsRequest(
            model=model,
            prompt=params.text,
        )

        try:
            response = await self._http_client.post(
                self._config.embeddings_url,
                json=request.model_dump(exclude_none=True),
            )
        except httpx.ConnectError as e:
            raise ConnectionError(self._config.base_url, str(e)) from e
        except httpx.RequestError as e:
            raise NetworkError(f"Request failed: {e}") from e

        if response.is_success:
            data = EmbeddingsResponse.model_validate(response.json())
            return EmbeddingResponse(
                embedding=data.embedding,
                model=model,
            )

        raise NetworkError(f"Failed to generate embedding: {response.text}", response.status_code)

    async def _send_generate_request(self, request: GenerateRequest) -> GenerateResponse:
        try:
            response = await self._http_client.post(
                self._config.generate_url,
                json=request.model_dump(exclude_none=True),
            )
        except httpx.ConnectError as e:
            raise ConnectionError(self._config.base_url, str(e)) from e
        except httpx.RequestError as e:
            raise NetworkError(f"Request failed: {e}") from e

        if response.is_success:
            return GenerateResponse.model_validate(response.json())

        status_code = response.status_code
        if status_code == 404:
            raise ModelNotFoundError(request.model)

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
