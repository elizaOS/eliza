"""
Anthropic API client implementation.

The client handles HTTP communication with the Anthropic API,
including authentication, request/response handling, and error processing.
"""

from __future__ import annotations

import json
import re
from typing import Any

import httpx

from elizaos_plugin_anthropic.config import AnthropicConfig
from elizaos_plugin_anthropic.errors import (
    ApiError,
    InvalidParameterError,
    JsonGenerationError,
    NetworkError,
    RateLimitError,
    ServerError,
)
from elizaos_plugin_anthropic.models import Model
from elizaos_plugin_anthropic.types import (
    ErrorResponse,
    Message,
    MessagesRequest,
    MessagesResponse,
    ObjectGenerationParams,
    ObjectGenerationResponse,
    Role,
    StopReason,
    TextGenerationParams,
    TextGenerationResponse,
    TokenUsage,
)


class AnthropicClient:
    """
    Anthropic API client.

    Provides methods for text and object generation using Claude models.
    """

    _config: AnthropicConfig
    _http_client: httpx.AsyncClient

    def __init__(self, config: AnthropicConfig) -> None:
        """
        Create a new Anthropic client with the given configuration.

        Args:
            config: Client configuration including API key and settings.
        """
        self._config = config
        self._http_client = httpx.AsyncClient(
            timeout=config.timeout_seconds,
            headers={
                "Content-Type": "application/json",
                "x-api-key": config.api_key,
                "anthropic-version": config.api_version,
            },
        )

    @property
    def config(self) -> AnthropicConfig:
        """Get the client configuration."""
        return self._config

    async def close(self) -> None:
        """Close the HTTP client."""
        await self._http_client.aclose()

    async def __aenter__(self) -> "AnthropicClient":
        """Context manager entry."""
        return self

    async def __aexit__(self, *_: object) -> None:
        """Context manager exit."""
        await self.close()

    async def generate_text_small(
        self, params: TextGenerationParams | str
    ) -> TextGenerationResponse:
        """
        Generate text using the small model.

        Args:
            params: Generation parameters or a prompt string.

        Returns:
            Text generation response.

        Raises:
            AnthropicError: If the API request fails.
        """
        if isinstance(params, str):
            params = TextGenerationParams(prompt=params)
        return await self._generate_text_with_model(params, self._config.small_model)

    async def generate_text_large(
        self, params: TextGenerationParams | str
    ) -> TextGenerationResponse:
        """
        Generate text using the large model.

        Args:
            params: Generation parameters or a prompt string.

        Returns:
            Text generation response.

        Raises:
            AnthropicError: If the API request fails.
        """
        if isinstance(params, str):
            params = TextGenerationParams(prompt=params)
        return await self._generate_text_with_model(params, self._config.large_model)

    async def _generate_text_with_model(
        self, params: TextGenerationParams, model: Model
    ) -> TextGenerationResponse:
        """Generate text using a specific model."""
        # Validate params - can't use both temperature and top_p
        if params.temperature is not None and params.top_p is not None:
            raise InvalidParameterError(
                "temperature/top_p",
                "Cannot specify both temperature and top_p. Use only one.",
            )

        # Build messages
        if params.messages:
            messages = params.messages
        else:
            messages = [Message.user(params.prompt)]

        max_tokens = params.max_tokens or model.default_max_tokens

        request = MessagesRequest(
            model=model.id,
            max_tokens=max_tokens,
            messages=messages,
            system=params.system,
            temperature=params.temperature,
            top_p=params.top_p,
            stop_sequences=params.stop_sequences,
        )

        response = await self._send_request(request)

        # Extract text and thinking from content blocks
        text_parts = response.get_text_blocks()
        thinking_parts = response.get_thinking_blocks()

        text = "".join(text_parts)
        thinking = "".join(thinking_parts) if thinking_parts else None

        return TextGenerationResponse(
            text=text,
            thinking=thinking,
            usage=response.usage,
            stop_reason=response.stop_reason or StopReason.END_TURN,
            model=response.model,
        )

    async def generate_object_small(
        self, params: ObjectGenerationParams | str
    ) -> ObjectGenerationResponse:
        """
        Generate a JSON object using the small model.

        Args:
            params: Generation parameters or a prompt string.

        Returns:
            Object generation response.

        Raises:
            JsonGenerationError: If JSON cannot be extracted from the response.
        """
        if isinstance(params, str):
            params = ObjectGenerationParams(prompt=params)
        return await self._generate_object_with_model(params, self._config.small_model)

    async def generate_object_large(
        self, params: ObjectGenerationParams | str
    ) -> ObjectGenerationResponse:
        """
        Generate a JSON object using the large model.

        Args:
            params: Generation parameters or a prompt string.

        Returns:
            Object generation response.

        Raises:
            JsonGenerationError: If JSON cannot be extracted from the response.
        """
        if isinstance(params, str):
            params = ObjectGenerationParams(prompt=params)
        return await self._generate_object_with_model(params, self._config.large_model)

    async def _generate_object_with_model(
        self, params: ObjectGenerationParams, model: Model
    ) -> ObjectGenerationResponse:
        """Generate a JSON object using a specific model."""
        # Build a JSON-focused prompt
        if "```json" in params.prompt or "respond with valid JSON" in params.prompt:
            json_prompt = params.prompt
        else:
            json_prompt = (
                f"{params.prompt}\n"
                "Please respond with valid JSON only, without any explanations, "
                "markdown formatting, or additional text."
            )

        # Build system prompt
        if params.system:
            system = f"{params.system}\nYou must respond with valid JSON only."
        else:
            system = "You must respond with valid JSON only. No markdown, no code blocks, no explanation text."

        messages = [Message.user(json_prompt)]
        max_tokens = params.max_tokens or model.default_max_tokens

        request = MessagesRequest(
            model=model.id,
            max_tokens=max_tokens,
            messages=messages,
            system=system,
            temperature=params.temperature,
        )

        response = await self._send_request(request)

        # Extract text from response
        text = "".join(response.get_text_blocks())

        # Parse JSON from response
        parsed_object = self._extract_json(text)

        return ObjectGenerationResponse(
            object=parsed_object,
            usage=response.usage,
            model=response.model,
        )

    async def _send_request(self, request: MessagesRequest) -> MessagesResponse:
        """Send a request to the messages API."""
        url = self._config.messages_url

        try:
            response = await self._http_client.post(
                url,
                json=request.model_dump(exclude_none=True),
            )
        except httpx.TimeoutException as e:
            raise NetworkError(f"Request timed out: {e}") from e
        except httpx.RequestError as e:
            raise NetworkError(f"Request failed: {e}") from e

        if response.is_success:
            return MessagesResponse.model_validate(response.json())

        # Handle error responses
        status_code = response.status_code
        try:
            error_data = response.json()
            error_response = ErrorResponse.model_validate(error_data)
            error_type = error_response.error.type
            error_message = error_response.error.message
        except Exception:
            error_type = "unknown"
            error_message = response.text

        if status_code == 429:
            raise RateLimitError(retry_after_seconds=60)

        if status_code >= 500:
            raise ServerError(status_code, error_message)

        raise ApiError(error_type, error_message, status_code)

    def _extract_json(self, text: str) -> dict[str, Any]:
        """Extract JSON from text response."""
        # Try direct parsing first
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

        # Try extracting from code blocks
        json_str = self._extract_from_code_block(text)
        if json_str:
            try:
                parsed = json.loads(json_str)
                if isinstance(parsed, dict):
                    return parsed
            except json.JSONDecodeError:
                pass

        # Try finding JSON object in text
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
        """Extract JSON from a code block."""
        # Try ```json block first
        json_block_match = re.search(r"```json\s*([\s\S]*?)\s*```", text)
        if json_block_match:
            return json_block_match.group(1).strip()

        # Try any code block with JSON-like content
        for match in re.finditer(r"```(?:\w*)\s*([\s\S]*?)\s*```", text):
            content = match.group(1).strip()
            if content.startswith("{") and content.endswith("}"):
                return content

        return None

    def _find_json_object(self, text: str) -> str | None:
        """Find a JSON object in text."""
        trimmed = text.strip()
        if trimmed.startswith("{") and trimmed.endswith("}"):
            return trimmed

        # Find the largest {...} pattern using brace counting
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


