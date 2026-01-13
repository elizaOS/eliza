from __future__ import annotations

import base64
import json
import re
from typing import Any

import httpx

from elizaos_plugin_google_genai.config import GoogleGenAIConfig
from elizaos_plugin_google_genai.errors import (
    ApiError,
    JsonGenerationError,
    NetworkError,
    RateLimitError,
    ServerError,
)
from elizaos_plugin_google_genai.models import Model
from elizaos_plugin_google_genai.types import (
    EmbedContentResponse,
    EmbeddingParams,
    EmbeddingResponse,
    ErrorResponse,
    GenerateContentResponse,
    ImageDescriptionParams,
    ImageDescriptionResponse,
    ObjectGenerationParams,
    ObjectGenerationResponse,
    TextGenerationParams,
    TextGenerationResponse,
    TokenUsage,
)


class GoogleGenAIClient:
    _config: GoogleGenAIConfig
    _http_client: httpx.AsyncClient

    def __init__(self, config: GoogleGenAIConfig) -> None:
        self._config = config
        self._http_client = httpx.AsyncClient(
            timeout=config.timeout_seconds,
            headers={"Content-Type": "application/json"},
        )

    @property
    def config(self) -> GoogleGenAIConfig:
        return self._config

    async def close(self) -> None:
        await self._http_client.aclose()

    async def __aenter__(self) -> GoogleGenAIClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

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
        self, params: TextGenerationParams, model: Model
    ) -> TextGenerationResponse:
        url = self._config.generate_content_url(model)

        request_body: dict[str, Any] = {
            "contents": [{"parts": [{"text": params.prompt}]}],
            "generationConfig": {
                "temperature": params.temperature,
                "topK": params.top_k,
                "topP": params.top_p,
                "maxOutputTokens": params.max_tokens or model.default_max_tokens,
            },
        }

        if params.stop_sequences:
            request_body["generationConfig"]["stopSequences"] = params.stop_sequences

        if params.system:
            request_body["systemInstruction"] = {"parts": [{"text": params.system}]}

        response = await self._send_request(url, request_body)
        parsed = GenerateContentResponse.model_validate(response)
        text = parsed.get_text()
        usage = parsed.usage_metadata or TokenUsage(
            prompt_tokens=0, completion_tokens=0, total_tokens=0
        )

        return TextGenerationResponse(text=text, usage=usage, model=model.id)

    async def generate_embedding(self, params: EmbeddingParams | str) -> EmbeddingResponse:
        if isinstance(params, str):
            params = EmbeddingParams(text=params)

        model = self._config.embedding_model
        url = self._config.embed_content_url(model)

        request_body: dict[str, Any] = {
            "content": {"parts": [{"text": params.text}]},
        }

        response = await self._send_request(url, request_body)
        parsed = EmbedContentResponse.model_validate(response)
        embedding = parsed.get_values()

        return EmbeddingResponse(embedding=embedding, model=model.id)

    async def describe_image(
        self, params: ImageDescriptionParams | str
    ) -> ImageDescriptionResponse:
        if isinstance(params, str):
            params = ImageDescriptionParams(image_url=params)

        model = self._config.image_model
        url = self._config.generate_content_url(model)

        image_data = await self._fetch_image(params.image_url)

        prompt = (
            params.prompt
            or "Please analyze this image and provide a title and detailed description."
        )

        request_body: dict[str, Any] = {
            "contents": [
                {
                    "parts": [
                        {"text": prompt},
                        {
                            "inlineData": {
                                "mimeType": image_data["mime_type"],
                                "data": image_data["base64"],
                            }
                        },
                    ]
                }
            ],
            "generationConfig": {
                "temperature": 0.7,
                "maxOutputTokens": 8192,
            },
        }

        response = await self._send_request(url, request_body)
        parsed = GenerateContentResponse.model_validate(response)
        text = parsed.get_text()

        try:
            json_response = json.loads(text)
            if isinstance(json_response, dict):
                title = json_response.get("title", "Image Analysis")
                description = json_response.get("description", text)
                if isinstance(title, str) and isinstance(description, str):
                    return ImageDescriptionResponse(title=title, description=description)
        except json.JSONDecodeError:
            pass

        title_match = re.search(r"title[:\s]+(.+?)(?:\n|$)", text, re.IGNORECASE)
        title = title_match.group(1).strip() if title_match else "Image Analysis"
        description = re.sub(r"title[:\s]+.+?(?:\n|$)", "", text, flags=re.IGNORECASE).strip()

        return ImageDescriptionResponse(title=title, description=description or text)

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
        self, params: ObjectGenerationParams, model: Model
    ) -> ObjectGenerationResponse:
        url = self._config.generate_content_url(model)

        prompt = params.prompt
        if params.json_schema:
            prompt += (
                f"\n\nPlease respond with a JSON object that follows this schema:\n"
                f"{json.dumps(params.json_schema, indent=2)}"
            )

        system = f"{params.system or ''}\nYou must respond with valid JSON only. No markdown, no code blocks, no explanation text.".strip()

        request_body: dict[str, Any] = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": params.temperature,
                "maxOutputTokens": params.max_tokens or model.default_max_tokens,
                "responseMimeType": "application/json",
            },
            "systemInstruction": {"parts": [{"text": system}]},
        }

        response = await self._send_request(url, request_body)
        parsed = GenerateContentResponse.model_validate(response)
        text = parsed.get_text()
        usage = parsed.usage_metadata or TokenUsage(
            prompt_tokens=0, completion_tokens=0, total_tokens=0
        )

        parsed_object = self._extract_json(text)

        return ObjectGenerationResponse(object=parsed_object, usage=usage, model=model.id)

    async def _send_request(self, url: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            response = await self._http_client.post(url, json=body)
        except httpx.TimeoutException as e:
            raise NetworkError(f"Request timed out: {e}") from e
        except httpx.RequestError as e:
            raise NetworkError(f"Request failed: {e}") from e

        if response.is_success:
            result = response.json()
            if isinstance(result, dict):
                return result
            return {}

        status_code = response.status_code
        try:
            error_data = response.json()
            error_response = ErrorResponse.model_validate(error_data)
            error_type = error_response.error.status
            error_message = error_response.error.message
        except (ValueError, KeyError):
            error_type = "unknown"
            error_message = response.text

        if status_code == 429:
            raise RateLimitError(retry_after_seconds=60)

        if status_code >= 500:
            raise ServerError(status_code, error_message)

        raise ApiError(error_type, error_message, status_code)

    async def _fetch_image(self, url: str) -> dict[str, str]:
        try:
            response = await self._http_client.get(url)
            response.raise_for_status()
        except httpx.RequestError as e:
            raise NetworkError(f"Failed to fetch image: {e}") from e

        content_type = response.headers.get("content-type", "image/jpeg")
        image_base64 = base64.b64encode(response.content).decode("utf-8")

        return {"mime_type": content_type, "base64": image_base64}

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

        raise JsonGenerationError(
            "Could not extract valid JSON from model response",
            raw_response=text,
        )

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
