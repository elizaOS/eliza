"""Shared types and helpers for standard public LLM benchmark adapters.

Centralizes:

* The OpenAI-compatible chat-completion call wrapper used by every adapter.
* The result-shape dataclass that each adapter writes to disk and that the
  registry's ``ScoreExtraction`` reads back.
* The ``BenchmarkRunner`` protocol every adapter implements.

Strong typing is enforced — no ``Any`` for the public surface.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Mapping, Protocol, Sequence

log = logging.getLogger("benchmarks.standard")

# Map common provider names to OpenAI-compatible base URLs. Adapters
# accept ``--model-endpoint`` directly, but ``--provider`` can pick from
# this map as a shortcut.
PROVIDER_BASE_URLS: Mapping[str, str] = {
    "openai": "https://api.openai.com/v1",
    "groq": "https://api.groq.com/openai/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "cerebras": "https://api.cerebras.ai/v1",
    "vllm": "http://127.0.0.1:8001/v1",
    "ollama": "http://127.0.0.1:11434/v1",
    "elizacloud": "https://api.eliza.cloud/v1",
}


@dataclass(frozen=True)
class ChatMessage:
    role: str
    content: str


@dataclass(frozen=True)
class GenerationConfig:
    model: str
    max_tokens: int = 512
    temperature: float = 0.0
    top_p: float = 1.0
    stop: tuple[str, ...] = ()


@dataclass(frozen=True)
class GenerationResult:
    text: str
    prompt_tokens: int
    completion_tokens: int
    raw: dict[str, object]


@dataclass
class BenchmarkResult:
    """Canonical on-disk shape for every standard benchmark adapter.

    The registry's ``ScoreExtraction`` callbacks read the ``metrics``
    dict; ``raw_json`` is preserved so post-hoc analysis can recover the
    full evaluator output.
    """

    benchmark: str
    model: str
    endpoint: str
    dataset_version: str
    n: int
    metrics: dict[str, float]
    raw_json: dict[str, object] = field(default_factory=dict)
    failures: list[dict[str, object]] = field(default_factory=list)
    elapsed_s: float = 0.0

    def to_json(self) -> dict[str, object]:
        return asdict(self)

    def write(self, output_path: Path) -> Path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(self.to_json(), indent=2), encoding="utf-8")
        return output_path


class OpenAICompatibleClient(Protocol):
    """Minimal protocol — exists so tests can pass a mock client."""

    def generate(
        self,
        messages: Sequence[ChatMessage],
        config: GenerationConfig,
    ) -> GenerationResult: ...


class HTTPOpenAICompatibleClient:
    """Real OpenAI-compatible HTTP client backed by ``openai`` SDK.

    Imports the SDK lazily so smoke tests against a mock client never
    need the dependency installed.
    """

    def __init__(self, *, endpoint: str, api_key: str) -> None:
        self._endpoint = endpoint
        self._api_key = api_key
        self._client_obj: object | None = None

    def _client(self) -> object:
        if self._client_obj is None:
            from openai import OpenAI

            self._client_obj = OpenAI(base_url=self._endpoint, api_key=self._api_key)
        return self._client_obj

    def generate(
        self,
        messages: Sequence[ChatMessage],
        config: GenerationConfig,
    ) -> GenerationResult:
        client = self._client()
        chat_messages = [{"role": m.role, "content": m.content} for m in messages]
        kwargs: dict[str, object] = {
            "model": config.model,
            "messages": chat_messages,
            "max_tokens": config.max_tokens,
            "temperature": config.temperature,
        }
        if config.top_p != 1.0:
            kwargs["top_p"] = config.top_p
        if config.stop:
            kwargs["stop"] = list(config.stop)
        # Mypy can't see SDK types — narrow via getattr.
        completions = getattr(getattr(client, "chat"), "completions")
        resp = completions.create(**kwargs)
        text = resp.choices[0].message.content or ""
        usage = getattr(resp, "usage", None)
        prompt_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
        completion_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
        raw_dump: dict[str, object]
        if hasattr(resp, "model_dump"):
            raw_dump = resp.model_dump()
        else:
            raw_dump = {"raw": str(resp)}
        return GenerationResult(
            text=text,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            raw=raw_dump,
        )


class MockClient:
    """Deterministic client for smoke tests.

    Returns ``responses[i]`` for the i-th call; loops if exhausted.
    """

    def __init__(self, responses: Sequence[str]) -> None:
        if not responses:
            raise ValueError("MockClient needs at least one response")
        self._responses = list(responses)
        self._idx = 0

    def generate(
        self,
        messages: Sequence[ChatMessage],
        config: GenerationConfig,
    ) -> GenerationResult:
        text = self._responses[self._idx % len(self._responses)]
        self._idx += 1
        return GenerationResult(
            text=text,
            prompt_tokens=0,
            completion_tokens=0,
            raw={"mock": True},
        )


def resolve_endpoint(
    *,
    model_endpoint: str | None,
    provider: str | None,
) -> str:
    """Resolve the endpoint URL from either an explicit ``--model-endpoint``
    or a known provider name. Raises ``ValueError`` when neither resolves.
    """

    if model_endpoint and model_endpoint.strip():
        return model_endpoint.strip()
    if provider:
        url = PROVIDER_BASE_URLS.get(provider.strip().lower())
        if url:
            return url
    raise ValueError(
        "Either --model-endpoint <url> or a known --provider must be supplied"
    )


def resolve_api_key(api_key_env: str) -> str:
    """Read the API key from the named env var.

    Returns ``"EMPTY"`` if the env var is unset — many OpenAI-compatible
    local servers (vLLM, Ollama, llama.cpp) accept any non-empty key.
    """

    return os.environ.get(api_key_env, "") or "EMPTY"


def make_client(
    *,
    endpoint: str,
    api_key: str,
    mock_responses: Sequence[str] | None = None,
) -> OpenAICompatibleClient:
    if mock_responses is not None:
        return MockClient(mock_responses)
    return HTTPOpenAICompatibleClient(endpoint=endpoint, api_key=api_key)


class BenchmarkRunner(Protocol):
    """Every adapter's runner conforms to this interface."""

    benchmark_id: str
    dataset_version: str

    def run(
        self,
        *,
        client: OpenAICompatibleClient,
        model: str,
        endpoint: str,
        output_dir: Path,
        limit: int | None,
    ) -> BenchmarkResult: ...


@dataclass
class RunStats:
    """Lightweight stopwatch so adapters don't reimplement timing."""

    started_at: float = field(default_factory=time.perf_counter)

    def elapsed(self) -> float:
        return round(time.perf_counter() - self.started_at, 3)
