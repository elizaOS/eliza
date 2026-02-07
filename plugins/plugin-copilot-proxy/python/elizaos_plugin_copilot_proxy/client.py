"""HTTP client for the Copilot Proxy server."""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING

import httpx

from elizaos_plugin_copilot_proxy.config import CopilotProxyConfig
from elizaos_plugin_copilot_proxy.types import (
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatMessage,
    ModelsResponse,
    TextGenerationParams,
    TextGenerationResult,
)

if TYPE_CHECKING:
    pass


class CopilotProxyClientError(Exception):
    """Error from the Copilot Proxy client."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class CopilotProxyClient:
    """HTTP client for interacting with the Copilot Proxy server."""

    def __init__(self, config: CopilotProxyConfig) -> None:
        self._config = config
        self._client = httpx.AsyncClient(
            base_url=config.base_url,
            headers={"Content-Type": "application/json"},
            timeout=httpx.Timeout(float(config.timeout_seconds)),
        )

    async def close(self) -> None:
        """Close the client."""
        await self._client.aclose()

    async def __aenter__(self) -> CopilotProxyClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    def _raise_for_status(self, response: httpx.Response) -> None:
        """Check response for errors."""
        if response.is_success:
            return

        try:
            error_data = response.json()
            error_message = error_data.get("error", {}).get("message", response.text)
        except json.JSONDecodeError:
            error_message = response.text

        raise CopilotProxyClientError(
            f"Copilot Proxy API error ({response.status_code}): {error_message}",
            status_code=response.status_code,
        )

    async def list_models(self) -> ModelsResponse:
        """List available models."""
        response = await self._client.get("/models")
        self._raise_for_status(response)
        return ModelsResponse.model_validate(response.json())

    async def health_check(self) -> bool:
        """Check if the proxy server is available."""
        try:
            await self.list_models()
            return True
        except Exception:
            return False

    async def create_chat_completion(
        self, request: ChatCompletionRequest
    ) -> ChatCompletionResponse:
        """Create a chat completion."""
        response = await self._client.post(
            "/chat/completions",
            json=request.model_dump(exclude_none=True),
        )
        self._raise_for_status(response)
        return ChatCompletionResponse.model_validate(response.json())

    async def generate_text(self, params: TextGenerationParams) -> TextGenerationResult:
        """Generate text using the chat completion API."""
        model = params.model or self._config.large_model

        messages: list[ChatMessage] = []
        if params.system:
            messages.append(ChatMessage.system(params.system))
        messages.append(ChatMessage.user(params.prompt))

        request = ChatCompletionRequest(
            model=model,
            messages=messages,
            max_tokens=params.max_tokens or self._config.max_tokens,
            temperature=params.temperature,
            frequency_penalty=params.frequency_penalty,
            presence_penalty=params.presence_penalty,
            stop=params.stop,
        )

        response = await self.create_chat_completion(request)

        if not response.choices:
            raise CopilotProxyClientError("API returned no choices")

        content = response.choices[0].message.content
        if content is None:
            raise CopilotProxyClientError("API returned empty content")

        return TextGenerationResult(text=content, usage=response.usage)

    async def generate_text_small(self, prompt: str) -> str:
        """Generate text using the small model."""
        params = TextGenerationParams(prompt=prompt, model=self._config.small_model)
        result = await self.generate_text(params)
        return result.text

    async def generate_text_large(self, prompt: str) -> str:
        """Generate text using the large model."""
        params = TextGenerationParams(prompt=prompt, model=self._config.large_model)
        result = await self.generate_text(params)
        return result.text

    async def generate_object(
        self, prompt: str, model: str | None = None
    ) -> dict[str, object]:
        """Generate a JSON object."""
        json_prompt = (
            f"{prompt}\n"
            "Please respond with valid JSON only, without any explanations, "
            "markdown formatting, or additional text."
        )

        params = TextGenerationParams(
            prompt=json_prompt,
            model=model or self._config.small_model,
            system="You must respond with valid JSON only. No markdown, no code blocks, no explanation text.",
            temperature=0.2,
        )

        result = await self.generate_text(params)
        return _extract_json(result.text)


def _extract_json(text: str) -> dict[str, object]:
    """Extract JSON from a text response."""
    # Try direct parse first
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    # Try extracting from JSON code block
    json_block_match = re.search(r"```json\s*([\s\S]*?)\s*```", text)
    if json_block_match:
        try:
            content = json_block_match.group(1).strip()
            parsed = json.loads(content)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

    # Try extracting from any code block
    any_block_match = re.search(r"```(?:\w*)\s*([\s\S]*?)\s*```", text)
    if any_block_match:
        content = any_block_match.group(1).strip()
        if content.startswith("{") and content.endswith("}"):
            try:
                parsed = json.loads(content)
                if isinstance(parsed, dict):
                    return parsed
            except json.JSONDecodeError:
                pass

    # Try finding JSON object in text
    json_obj = _find_json_object(text)
    if json_obj:
        try:
            parsed = json.loads(json_obj)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

    raise CopilotProxyClientError("Could not extract valid JSON from response")


def _find_json_object(text: str) -> str | None:
    """Find a JSON object in text."""
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
