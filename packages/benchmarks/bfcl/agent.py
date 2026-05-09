"""Agents used by the BFCL benchmark runner."""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Optional

from benchmarks.bfcl.models import (
    BenchmarkModelConfig,
    get_default_model_config,
    get_model_config,
)
from benchmarks.bfcl.parser import FunctionCallParser
from benchmarks.bfcl.plugin import generate_openai_tools_format
from benchmarks.bfcl.types import BFCLConfig, BFCLTestCase, FunctionCall

logger = logging.getLogger(__name__)

ELIZAOS_AVAILABLE = False


@dataclass
class _ProviderPlugin:
    name: str
    config: BenchmarkModelConfig


def get_model_provider_plugin() -> tuple[_ProviderPlugin | None, str | None]:
    """Compatibility helper for the integration script."""
    config = get_default_model_config()
    if config is None:
        return None, None
    return _ProviderPlugin(name=config.provider.value, config=config), config.full_model_name


class MockBFCLAgent:
    """Deterministic agent for infrastructure tests."""

    def __init__(self, config: BFCLConfig, model_name: str = "mock") -> None:
        self.config = config
        self._model_name = model_name

    @property
    def model_name(self) -> str:
        return self._model_name

    async def initialize(self) -> None:
        return None

    async def setup_test_case(self, test_case: BFCLTestCase) -> None:
        return None

    async def query(
        self,
        test_case: BFCLTestCase,
        timeout_ms: Optional[int] = None,
    ) -> tuple[list[FunctionCall], str, float]:
        _ = timeout_ms
        start = time.time()
        calls = list(test_case.expected_calls) if test_case.is_relevant else []
        response = json.dumps(
            [{"name": call.name, "arguments": call.arguments} for call in calls]
        )
        if not calls:
            response = "MOCK: no relevant function call"
        else:
            response = f"MOCK: {response}"
        latency_ms = max((time.time() - start) * 1000, 0.001)
        return calls, response, latency_ms

    async def close(self) -> None:
        return None


class BFCLAgent:
    """Lightweight LLM-backed BFCL agent with a mock fallback.

    OpenAI-compatible providers are called through their chat completions API.
    If no provider configuration is available, the agent falls back to the
    deterministic mock path so local smoke tests still exercise the runner.
    """

    def __init__(
        self,
        config: BFCLConfig,
        model_plugin: Any | None = None,
        provider: str | None = None,
        model: str | None = None,
    ) -> None:
        self.config = config
        self.parser = FunctionCallParser()
        self._model_config = self._resolve_model_config(model_plugin, provider, model)
        self._mock = self._model_config is None
        self._model_name = self._model_config.full_model_name if self._model_config else "mock"

    @property
    def model_name(self) -> str:
        return self._model_name

    def _resolve_model_config(
        self,
        model_plugin: Any | None,
        provider: str | None,
        model: str | None,
    ) -> BenchmarkModelConfig | None:
        plugin_config = getattr(model_plugin, "config", None)
        if isinstance(plugin_config, BenchmarkModelConfig):
            return plugin_config
        if model:
            resolved = get_model_config(model)
            if resolved is not None:
                return resolved
        if provider:
            from benchmarks.bfcl.models import ModelProvider, PROVIDER_CONFIGS
            import os

            try:
                provider_enum = ModelProvider(provider)
            except ValueError:
                logger.warning("Unknown BFCL provider: %s", provider)
                return None
            provider_config = PROVIDER_CONFIGS[provider_enum]
            api_key = os.environ.get(provider_config.api_key_env, "")
            if not api_key and not provider_config.is_local:
                return None
            if model:
                return BenchmarkModelConfig(
                    provider=provider_enum,
                    model_id=model,
                    display_name=f"{model} ({provider_enum.value})",
                    api_key=api_key or None,
                    base_url=os.environ.get(
                        provider_config.base_url_env or "",
                        provider_config.default_base_url,
                    ),
                    temperature=self.config.temperature,
                )
            return BenchmarkModelConfig(
                provider=provider_enum,
                model_id=provider_config.small_model,
                display_name=f"{provider_config.small_model} ({provider_enum.value})",
                api_key=api_key or None,
                base_url=os.environ.get(
                    provider_config.base_url_env or "",
                    provider_config.default_base_url,
                ),
                temperature=self.config.temperature,
            )
        return get_default_model_config()

    async def initialize(self) -> None:
        return None

    async def setup_test_case(self, test_case: BFCLTestCase) -> None:
        return None

    async def query(
        self,
        test_case: BFCLTestCase,
        timeout_ms: Optional[int] = None,
    ) -> tuple[list[FunctionCall], str, float]:
        if self._mock:
            return await MockBFCLAgent(self.config).query(test_case, timeout_ms)

        start = time.time()
        raw_response = self._call_chat_completion(test_case, timeout_ms)
        latency_ms = (time.time() - start) * 1000
        return self.parser.parse(raw_response), raw_response, latency_ms

    def _call_chat_completion(
        self,
        test_case: BFCLTestCase,
        timeout_ms: Optional[int],
    ) -> str:
        if self._model_config is None:
            return ""

        base_url = (self._model_config.base_url or "").rstrip("/")
        if not base_url:
            raise RuntimeError(f"No base URL configured for {self._model_name}")

        url = f"{base_url}/chat/completions"
        prompt = (
            "Return only JSON function calls for this BFCL task. Use an array of "
            '{"name": string, "arguments": object}. Return [] if no function is relevant.\n\n'
            f"Question: {test_case.question}"
        )
        tools = generate_openai_tools_format(test_case.functions)
        body = {
            "model": self._model_config.model_id,
            "messages": [{"role": "user", "content": prompt}],
            "tools": tools,
            "temperature": self.config.temperature,
        }
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "eliza-bfcl-benchmark/1.0",
        }
        if self._model_config.api_key:
            headers["Authorization"] = f"Bearer {self._model_config.api_key}"

        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        timeout_s = (timeout_ms or self.config.timeout_per_test_ms) / 1000
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as response:
                data = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            error_body = exc.read().decode("utf-8", errors="replace")
            if exc.code == 400 and (
                "wrong_api_format" in error_body
                or "response_format" in error_body
                or "schema grammar" in error_body
            ):
                data = self._call_prompt_only(url, headers, timeout_s, test_case, tools)
            else:
                raise RuntimeError(f"BFCL provider HTTP {exc.code}: {error_body}") from exc

        return self._extract_response_text(data)

    def _call_prompt_only(
        self,
        url: str,
        headers: dict[str, str],
        timeout_s: float,
        test_case: BFCLTestCase,
        tools: list[dict[str, Any]],
    ) -> dict[str, Any]:
        if self._model_config is None:
            return {}
        prompt = (
            "You are solving a BFCL function-calling task, but the API endpoint "
            "does not accept native tool schemas. Return only a JSON array of "
            '{"name": string, "arguments": object} calls. Return [] if no function '
            "is relevant.\n\n"
            f"Available tools:\n{json.dumps(tools, indent=2)}\n\n"
            f"Question: {test_case.question}"
        )
        body = {
            "model": self._model_config.model_id,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": self.config.temperature,
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            error_body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"BFCL provider HTTP {exc.code}: {error_body}") from exc

    def _extract_response_text(self, data: dict[str, Any]) -> str:
        choices = data.get("choices")
        if not isinstance(choices, list) or not choices:
            return json.dumps(data)
        first = choices[0]
        if not isinstance(first, dict):
            return json.dumps(first)
        message = first.get("message")
        if not isinstance(message, dict):
            return json.dumps(first)
        tool_calls = message.get("tool_calls")
        if isinstance(tool_calls, list) and tool_calls:
            calls: list[dict[str, Any]] = []
            for tool_call in tool_calls:
                if not isinstance(tool_call, dict):
                    continue
                function = tool_call.get("function")
                if not isinstance(function, dict):
                    continue
                arguments = function.get("arguments", {})
                if isinstance(arguments, str):
                    try:
                        arguments = json.loads(arguments)
                    except json.JSONDecodeError:
                        arguments = {}
                calls.append({"name": function.get("name", ""), "arguments": arguments})
            return json.dumps(calls)
        content = message.get("content", "")
        return content if isinstance(content, str) else json.dumps(content)

    async def close(self) -> None:
        return None
