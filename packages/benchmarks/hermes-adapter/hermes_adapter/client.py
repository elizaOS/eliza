"""Native Hermes benchmark client with a process-isolated runtime profile.

Each turn uses the pinned Hermes interpreter to instantiate
``run_agent.AIAgent`` against a loopback OpenAI-compatible gateway. A generated
user plugin exposes only benchmark-provided tools and records their execution;
legacy in-process/direct-provider paths fail closed as nonpublishable.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence
from urllib.parse import urlparse

from .native_runtime import (
    HEALTH_TOOL_NAME,
    NATIVE_RUNTIME_API,
    NATIVE_RUNTIME_CLASS,
    NATIVE_TRANSPORT,
    PLUGIN_API,
    PLUGIN_ID,
    PLUGIN_TOOLSET,
    NativeRuntimeError,
    is_loopback_base_url,
    prepare_scoped_benchmark_plugin,
)


logger = logging.getLogger(__name__)

DEFAULT_REPO_PATH = Path.home() / ".eliza" / "agents" / "hermes-agent-src"
DEFAULT_VENV_PYTHON = DEFAULT_REPO_PATH / ".venv" / "bin" / "python"
_NATIVE_RUNNER_PATH = Path(__file__).with_name("native_runtime.py").resolve()
_OPENAI_COMPAT_DEFAULT_BASE_URLS = {
    "cerebras": "https://api.cerebras.ai/v1",
    "openai": "https://api.openai.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "groq": "https://api.groq.com/openai/v1",
}
_PROVIDER_API_KEY_ENVS = {
    "cerebras": ("CEREBRAS_API_KEY", "OPENAI_API_KEY"),
    "openai": ("OPENAI_API_KEY",),
    "openrouter": ("OPENROUTER_API_KEY", "OPENAI_API_KEY"),
    "groq": ("GROQ_API_KEY", "OPENAI_API_KEY"),
    "vllm": ("OPENAI_API_KEY",),
    "claude-subscription": ("CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN",),
}
_PROVIDER_BASE_URL_ENVS = {
    "cerebras": ("CEREBRAS_BASE_URL", "OPENAI_BASE_URL"),
    "openai": ("OPENAI_BASE_URL",),
    "openrouter": ("OPENROUTER_BASE_URL", "OPENAI_BASE_URL"),
    "groq": ("GROQ_BASE_URL", "OPENAI_BASE_URL"),
    "vllm": ("VLLM_BASE_URL", "OPENAI_BASE_URL"),
    "claude-subscription": ("CLAUDE_SUBSCRIPTION_GATEWAY_URL",),
}


@dataclass
class MessageResponse:
    """Parsed response from one native Hermes benchmark turn."""

    text: str
    thought: str | None
    actions: list[str]
    params: dict[str, object]


_CONTROL_CONTEXT_KEYS = {
    "benchmark_messages",
    "messages",
    "system_prompt",
    "system_hint",
    "temperature",
    "reasoning_effort",
    "max_tokens",
    "model_name",
    "benchmark",
    "task_id",
    "session_id",
    "agent_id",
    "tools",
    "tool_choice",
    "capture_stop",
    "benchmark_workspace_path",
}


def _jsonable(value: object) -> object:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Mapping):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_jsonable(item) for item in value]
    return str(value)


def context_to_prompt(context: Mapping[str, object] | None) -> str:
    """Render non-control benchmark context for the native system message."""

    if not context:
        return ""
    parts: list[str] = []
    hint_keys = (
        ("instructions",)
        if isinstance(context.get("system_prompt"), str)
        else ("system_hint", "instructions")
    )
    for key in hint_keys:
        value = context.get(key)
        if isinstance(value, str) and value.strip():
            parts.append(f"{key}:\n{value.strip()}")
    history = context.get("history")
    if isinstance(history, Sequence) and not isinstance(history, (str, bytes)):
        history_lines: list[str] = []
        for item in history:
            if not isinstance(item, Mapping):
                continue
            role = str(item.get("role") or "turn")
            content = item.get("content")
            if content is not None:
                history_lines.append(f"{role}: {content}")
        if history_lines:
            parts.append("history:\n" + "\n".join(history_lines))
    for key in sorted(str(item) for item in context):
        if key in _CONTROL_CONTEXT_KEYS or key == "history":
            continue
        value = context.get(key)
        if value in (None, "", [], {}):
            continue
        parts.append(
            f"{key}:\n{json.dumps(_jsonable(value), ensure_ascii=True, indent=2)}"
        )
    return "\n\n".join(parts)


def _prompt_text(text: str, context: Mapping[str, object] | None) -> str:
    if not context:
        return text
    parts: list[str] = []
    system_prompt = context.get("system_prompt")
    if isinstance(system_prompt, str) and system_prompt.strip():
        parts.append(system_prompt.strip())
    context_prompt = context_to_prompt(context)
    if context_prompt:
        parts.append(f"Benchmark context:\n{context_prompt}")
    messages = context.get("benchmark_messages")
    if not isinstance(messages, Sequence) or isinstance(messages, (str, bytes)):
        messages = context.get("messages")
    if isinstance(messages, Sequence) and not isinstance(messages, (str, bytes)):
        for item in messages:
            if not isinstance(item, Mapping):
                continue
            role = item.get("role")
            content = item.get("content")
            if isinstance(role, str) and content is not None:
                parts.append(f"{role}: {content}")
    if text:
        parts.append(f"user: {text}")
    return "\n".join(parts) if parts else text


def _coerce_optional_float(value: object, *, fallback: float | None) -> float | None:
    if isinstance(value, bool):
        return fallback
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value)
        except ValueError:
            return fallback
    return fallback


def _coerce_optional_int(value: object, *, fallback: int | None) -> int | None:
    if isinstance(value, bool):
        return fallback
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(value)
        except ValueError:
            return fallback
    return fallback


def _coerce_optional_str(value: object, *, fallback: str | None) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return fallback


def _env_optional_float(*names: str) -> float | None:
    for name in names:
        value = _coerce_optional_float(os.environ.get(name), fallback=None)
        if value is not None:
            return value
    return None


def _env_optional_int(*names: str) -> int | None:
    for name in names:
        value = _coerce_optional_int(os.environ.get(name), fallback=None)
        if value is not None:
            return value
    return None


def _env_optional_str(*names: str) -> str | None:
    for name in names:
        value = _coerce_optional_str(os.environ.get(name), fallback=None)
        if value is not None:
            return value
    return None


def _is_gpt_oss_model(model: str) -> bool:
    return model.rsplit("/", 1)[-1].startswith("gpt-oss")


def _default_api_key(provider: str) -> str:
    provider_key = provider.strip().lower()
    for env_name in _PROVIDER_API_KEY_ENVS.get(provider_key, ("OPENAI_API_KEY",)):
        value = os.environ.get(env_name, "").strip()
        if value:
            return value
    return ""


def _default_base_url(provider: str) -> str:
    provider_key = provider.strip().lower()
    for env_name in _PROVIDER_BASE_URL_ENVS.get(provider_key, ("OPENAI_BASE_URL",)):
        value = os.environ.get(env_name, "").strip()
        if value:
            return _normalized_base_url(provider_key, value)
    if provider_key == "claude-subscription":
        return ""
    return _OPENAI_COMPAT_DEFAULT_BASE_URLS.get(
        provider_key, "https://api.cerebras.ai/v1"
    )


def _normalized_base_url(provider: str, value: str) -> str:
    """Canonicalize the loopback OpenAI surface used by subscription runs."""

    normalized = value.strip().rstrip("/")
    if provider.strip().lower() != "claude-subscription":
        return normalized
    if not is_loopback_base_url(normalized):
        return normalized
    parsed = urlparse(normalized)
    path = parsed.path.rstrip("/")
    if (
        parsed.username is not None
        or parsed.password is not None
        or parsed.params
        or parsed.query
        or parsed.fragment
        or path not in {"", "/v1"}
    ):
        raise ValueError(
            "Claude-subscription Hermes runs require the loopback gateway "
            "origin or its /v1 OpenAI base URL"
        )
    return parsed._replace(path="/v1").geturl()


def _resolved_campaign_provider(provider: str | None) -> str:
    """Keep subscription provenance authoritative over CLI provider aliases."""

    campaign_provider = os.environ.get("BENCHMARK_MODEL_PROVIDER", "").strip()
    if campaign_provider.lower() == "claude-subscription":
        return campaign_provider
    return (provider or campaign_provider or "cerebras").strip() or "cerebras"


def _resolved_campaign_model(model: str | None, *, provider: str) -> str:
    """Resolve the model label recorded on every native Hermes turn."""

    campaign_model = os.environ.get("BENCHMARK_MODEL_NAME", "").strip()
    if provider.lower() == "claude-subscription" and campaign_model:
        return campaign_model
    return (
        model or campaign_model or os.environ.get("MODEL_NAME") or "gemma-4-31b"
    ).strip() or "gemma-4-31b"


def resolve_hermes_mode(
    mode: str | None = None,
    *,
    provider: str | None = None,
) -> str:
    """Resolve the native execution mode and fail closed on unsafe campaigns."""

    configured = {
        value
        for name in ("HERMES_MODE", "HERMES_ADAPTER_MODE")
        if (value := os.environ.get(name, "").strip())
    }
    if mode is None and len(configured) > 1:
        raise ValueError(
            "HERMES_MODE and HERMES_ADAPTER_MODE disagree; use one Hermes mode"
        )
    resolved = (
        mode or (next(iter(configured)) if configured else "subprocess")
    ).strip()
    if resolved not in {"subprocess", "in_process"}:
        raise ValueError(
            f"Unknown mode {resolved!r}; expected 'subprocess' or 'in_process'"
        )
    campaign_provider = _resolved_campaign_provider(provider).lower()
    if campaign_provider == "claude-subscription" and resolved != "subprocess":
        raise ValueError(
            "Claude-subscription Hermes runs require mode='subprocess' so "
            "run_agent.AIAgent provenance can be verified"
        )
    return resolved


def _usage_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    return None


def _extract_usage_tokens(usage: Mapping[str, object]) -> dict[str, int | None]:
    def pick(*keys: str) -> int | None:
        for key in keys:
            value = _usage_int(usage.get(key))
            if value is not None:
                return value
        return None

    def pick_detail(
        detail_keys: Sequence[str], field_keys: Sequence[str]
    ) -> int | None:
        for detail_key in detail_keys:
            detail = usage.get(detail_key)
            if not isinstance(detail, Mapping):
                continue
            for field_key in field_keys:
                value = _usage_int(detail.get(field_key))
                if value is not None:
                    return value
        return None

    cache_read = pick("cache_read_input_tokens", "cachedTokens", "cached_tokens")
    if cache_read is None:
        cache_read = pick_detail(
            ("prompt_tokens_details", "input_token_details"),
            ("cached_tokens", "cachedTokens", "cache_read_input_tokens"),
        )
    cache_write = pick("cache_creation_input_tokens", "cacheCreationInputTokens")
    if cache_write is None:
        cache_write = pick_detail(
            ("prompt_tokens_details", "input_token_details"),
            (
                "cache_creation_input_tokens",
                "cacheCreationInputTokens",
                "cache_write_tokens",
                "cacheWriteTokens",
            ),
        )
    return {
        "prompt_tokens": pick("prompt_tokens", "promptTokens", "input_tokens"),
        "completion_tokens": pick(
            "completion_tokens", "completionTokens", "output_tokens"
        ),
        "total_tokens": pick("total_tokens", "totalTokens"),
        "cache_read_input_tokens": cache_read,
        "cache_creation_input_tokens": cache_write,
    }


def _normalize_usage_payload(usage: Mapping[str, object]) -> dict[str, object]:
    normalized = dict(usage)
    for key, value in _extract_usage_tokens(normalized).items():
        if value is not None and key in {
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
        }:
            normalized[key] = value
    return normalized


def _assistant_text_and_thought(message: object) -> tuple[str, str | None]:
    """Normalize vendor reasoning fields for compatibility callers."""

    content = getattr(message, "content", None)
    thought = getattr(message, "reasoning_content", None) or getattr(
        message, "reasoning", None
    )
    if not isinstance(thought, str) or not thought.strip():
        thought = None
    if isinstance(content, str) and content.strip():
        text = content
    elif thought is not None:
        text = thought
    elif content is None:
        text = ""
    else:
        text = str(content)
    return text, thought


_TELEMETRY_TURN_COUNTER = 0
_TELEMETRY_FALLBACK_PATH: str | None = None


def _resolve_telemetry_path() -> str:
    explicit = os.environ.get("BENCHMARK_TELEMETRY_JSONL", "").strip()
    if explicit:
        return explicit
    run_dir = os.environ.get("BENCHMARK_RUN_DIR", "").strip()
    if run_dir:
        return str(Path(run_dir) / "telemetry.jsonl")
    global _TELEMETRY_FALLBACK_PATH
    if _TELEMETRY_FALLBACK_PATH is None:
        _TELEMETRY_FALLBACK_PATH = str(
            Path(tempfile.mkdtemp(prefix="hermes-adapter-telemetry-"))
            / "telemetry.jsonl"
        )
        logger.info(
            "BENCHMARK_RUN_DIR not set; writing per-turn telemetry to %s",
            _TELEMETRY_FALLBACK_PATH,
        )
    return _TELEMETRY_FALLBACK_PATH


def _write_telemetry(
    *,
    harness: str,
    provider: str,
    model: str,
    text: str,
    context: Mapping[str, object] | None,
    latency_ms: float,
    task_id: str | None,
    benchmark: str | None,
    response: MessageResponse | None = None,
    error: str | None = None,
) -> None:
    usage: dict[str, object] = {}
    meta: dict[str, object] = {}
    if response is not None:
        raw_usage = response.params.get("usage")
        if isinstance(raw_usage, Mapping):
            usage = _normalize_usage_payload(raw_usage)
        raw_meta = response.params.get("_meta")
        if isinstance(raw_meta, Mapping):
            meta = dict(raw_meta)
    tokens = (
        _extract_usage_tokens(usage)
        if usage
        else {
            "prompt_tokens": None,
            "completion_tokens": None,
            "total_tokens": None,
            "cache_read_input_tokens": None,
            "cache_creation_input_tokens": None,
        }
    )
    global _TELEMETRY_TURN_COUNTER
    turn_index = _TELEMETRY_TURN_COUNTER
    _TELEMETRY_TURN_COUNTER += 1
    record: dict[str, object] = {
        "harness": harness,
        "provider": provider,
        "model": model,
        "benchmark": benchmark,
        "task_id": task_id,
        "turn_index": turn_index,
        "prompt_text": _prompt_text(text, context),
        "prompt_chars": len(_prompt_text(text, context)),
        "latency_ms": latency_ms,
        "usage": _jsonable(usage),
        **tokens,
        "actions": list(response.actions) if response is not None else [],
        "params": _jsonable(response.params) if response is not None else {},
        "response_text": response.text if response is not None else "",
        "error_if_any": error,
        "runtime_provenance": _jsonable(meta),
        "agent_runtime": meta.get("agent_runtime", "hermes"),
        "native_runtime_class": meta.get("native_runtime_class"),
        "native_runtime_api": meta.get("native_runtime_api"),
        "native_agent_instantiated": meta.get("native_agent_instantiated", False),
        "tool_bridge_plugin": meta.get("tool_bridge_plugin"),
        "tool_bridge_api": meta.get("tool_bridge_api"),
        "tool_bridge_toolset": meta.get("tool_bridge_toolset"),
        "transport": meta.get("transport"),
        "publishable_native": meta.get("publishable_native", False),
        "legacy_raw_openai_bypass": meta.get("legacy_raw_openai_bypass", False),
    }
    try:
        path = Path(_resolve_telemetry_path())
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=True, sort_keys=True) + "\n")
    except OSError as exc:
        logger.debug("failed to write Hermes telemetry: %s", exc)


def _build_openai_messages(
    *,
    raw_messages: object,
    system_prompt: str | None,
    fallback_user_text: str,
) -> list[dict[str, object]]:
    """Normalize benchmark history while preserving tool-call/result pairing."""

    messages: list[dict[str, object]] = []
    had_raw = False
    tool_names_by_id: dict[str, str] = {}
    if isinstance(raw_messages, Sequence) and not isinstance(
        raw_messages, (str, bytes)
    ):
        for item in raw_messages:
            if not isinstance(item, Mapping):
                continue
            role = item.get("role")
            if role not in {"system", "user", "assistant", "tool"}:
                continue
            content = item.get("content")
            if isinstance(content, list) and role == "user":
                content_value: object = _jsonable(content)
                content_text = json.dumps(content_value, ensure_ascii=True)
            else:
                content_text = "" if content is None else str(content)
                content_value = content_text
            message: dict[str, object] = {"role": str(role), "content": content_value}
            if role == "assistant":
                raw_calls = item.get("tool_calls")
                if isinstance(raw_calls, Sequence) and not isinstance(
                    raw_calls, (str, bytes)
                ):
                    calls: list[dict[str, object]] = []
                    for raw_call in raw_calls:
                        if not isinstance(raw_call, Mapping):
                            continue
                        function = raw_call.get("function")
                        if not isinstance(function, Mapping):
                            continue
                        name = function.get("name")
                        if not isinstance(name, str) or not name:
                            continue
                        arguments = function.get("arguments")
                        if isinstance(arguments, Mapping):
                            argument_text = json.dumps(dict(arguments))
                        elif isinstance(arguments, str):
                            argument_text = arguments
                        else:
                            argument_text = "{}"
                        call_id = str(raw_call.get("id") or "")
                        if call_id:
                            tool_names_by_id[call_id] = name
                        calls.append(
                            {
                                "id": call_id,
                                "type": "function",
                                "function": {"name": name, "arguments": argument_text},
                            }
                        )
                    if calls:
                        message["tool_calls"] = calls
                        if not content_text:
                            message["content"] = None
            elif role == "tool":
                call_id = item.get("tool_call_id")
                if isinstance(call_id, str) and call_id:
                    message["tool_call_id"] = call_id
                name = item.get("name")
                if isinstance(name, str) and name:
                    message["name"] = name
                elif isinstance(call_id, str) and call_id in tool_names_by_id:
                    message["name"] = tool_names_by_id[call_id]
            messages.append(message)
            had_raw = True
    if isinstance(system_prompt, str) and system_prompt:
        system_indexes = [
            index
            for index, message in enumerate(messages)
            if message.get("role") == "system"
        ]
        if not any(
            messages[index].get("content") == system_prompt for index in system_indexes
        ):
            replaced = False
            for index in system_indexes:
                content = messages[index].get("content")
                if (
                    isinstance(content, str)
                    and content
                    and system_prompt.startswith(f"{content}\n\nBenchmark context:")
                ):
                    messages[index] = {"role": "system", "content": system_prompt}
                    replaced = True
                    break
            if not replaced:
                messages.insert(0, {"role": "system", "content": system_prompt})
    if not had_raw:
        messages.append({"role": "user", "content": fallback_user_text})
    return messages


def _openai_compatible_tools(raw_tools: object) -> list[object] | None:
    """Accept only complete OpenAI function schemas for the scoped plugin."""

    if not isinstance(raw_tools, list) or not raw_tools:
        return None
    for item in raw_tools:
        if not isinstance(item, Mapping) or item.get("type") != "function":
            return None
        function = item.get("function")
        if not isinstance(function, Mapping) or not isinstance(
            function.get("name"), str
        ):
            return None
    return list(raw_tools)


def _normalize_tool_calls(raw_tool_calls: object) -> list[dict[str, object]]:
    if not isinstance(raw_tool_calls, Sequence) or isinstance(
        raw_tool_calls, (str, bytes)
    ):
        return []
    normalized: list[dict[str, object]] = []
    for item in raw_tool_calls:
        if not isinstance(item, Mapping):
            continue
        function = item.get("function")
        if isinstance(function, Mapping):
            name = function.get("name")
            arguments = function.get("arguments", "{}")
        else:
            name = item.get("name") or item.get("tool")
            arguments = item.get("arguments", item.get("args", "{}"))
        if not isinstance(name, str) or not name:
            continue
        normalized.append(
            {
                "id": str(item.get("id") or f"call_{len(normalized)}"),
                "name": name,
                "arguments": arguments if arguments is not None else "{}",
            }
        )
    return normalized


class HermesClient:
    """One-shot client whose only publishable mode is native subprocess Hermes."""

    def __init__(
        self,
        *,
        repo_path: Path | None = None,
        venv_python: Path | None = None,
        provider: str | None = None,
        model: str | None = None,
        api_key: str | None = None,
        base_url: str | None = None,
        mode: str | None = None,
        timeout_s: float = 1200.0,
        temperature: float | None = None,
        reasoning_effort: str | None = None,
        max_tokens: int | None = None,
        hermes_home: Path | None = None,
        workspace_path: Path | None = None,
    ) -> None:
        resolved_provider = _resolved_campaign_provider(provider)
        resolved_model = _resolved_campaign_model(model, provider=resolved_provider)
        resolved_mode = resolve_hermes_mode(mode, provider=resolved_provider)
        self.repo_path = Path(repo_path) if repo_path else DEFAULT_REPO_PATH
        self.workspace_path = (
            Path(workspace_path).resolve()
            if workspace_path is not None
            else Path.cwd().resolve()
        )
        if not self.workspace_path.is_dir():
            raise ValueError(
                f"Hermes benchmark workspace is not a directory: {self.workspace_path}"
            )
        self.venv_python = (
            Path(venv_python)
            if venv_python is not None
            else self.repo_path / ".venv" / "bin" / "python"
        )
        self.provider = resolved_provider
        self.model = resolved_model
        default_api_key = _default_api_key(resolved_provider)
        if (
            resolved_provider == "claude-subscription"
            and api_key is not None
            and default_api_key
            and api_key != default_api_key
        ):
            raise ValueError(
                "Explicit Hermes API key does not match the active "
                "Claude-subscription gateway bearer"
            )
        self.api_key = (
            default_api_key
            if resolved_provider == "claude-subscription" and default_api_key
            else api_key
            if api_key is not None
            else default_api_key
        )
        self.base_url = (
            _normalized_base_url(resolved_provider, base_url)
            if isinstance(base_url, str) and base_url.strip()
            else _default_base_url(resolved_provider)
        )
        self.mode = resolved_mode
        self.timeout_s = float(timeout_s)
        self.temperature = (
            temperature
            if temperature is not None
            else _env_optional_float("BENCHMARK_TEMPERATURE", "TEMPERATURE")
        )
        self.reasoning_effort = (
            reasoning_effort
            if reasoning_effort is not None
            else _env_optional_str(
                "BENCHMARK_REASONING_EFFORT", "CEREBRAS_REASONING_EFFORT"
            )
        )
        self.max_tokens = (
            max_tokens
            if max_tokens is not None
            else _env_optional_int("BENCHMARK_MAX_TOKENS", "MAX_TOKENS")
        )
        self._owned_home: tempfile.TemporaryDirectory[str] | None = None
        if hermes_home is None:
            self._owned_home = tempfile.TemporaryDirectory(
                prefix="hermes-benchmark-profile-"
            )
            self.hermes_home = Path(self._owned_home.name).resolve()
        else:
            self.hermes_home = Path(hermes_home).resolve()
        self._native_lock = threading.Lock()
        self._task_id: str | None = None
        self._benchmark: str | None = None

    def health(self) -> dict[str, object]:
        """Prove AIAgent instantiation, pinned source, and scoped plugin loading."""

        if self.mode == "in_process":
            return self._nonpublishable_result(
                "in_process mode cannot isolate HERMES_HOME before run_agent import"
            )
        if not self.venv_python.exists():
            return self._nonpublishable_result(
                f"venv python not found at {self.venv_python}"
            )
        if not _NATIVE_RUNNER_PATH.is_file():
            return self._nonpublishable_result(
                f"native Hermes runner not found at {_NATIVE_RUNNER_PATH}"
            )
        if not is_loopback_base_url(self.base_url):
            return self._nonpublishable_result(
                "native Hermes benchmarks require a loopback OpenAI-compatible gateway"
            )
        health_tool = [
            {
                "type": "function",
                "function": {
                    "name": HEALTH_TOOL_NAME,
                    "description": "Native Hermes benchmark health probe.",
                    "parameters": {
                        "type": "object",
                        "properties": {},
                        "additionalProperties": False,
                    },
                },
            }
        ]
        try:
            with self._native_lock:
                bridge = prepare_scoped_benchmark_plugin(
                    self.hermes_home,
                    health_tool,
                    model=self.model,
                    base_url=self.base_url,
                )
                payload = {**self._native_payload_base(), "bridge": bridge.as_payload()}
                result = self._run_python_subprocess(
                    ["-u", str(_NATIVE_RUNNER_PATH), "--health"],
                    stdin=json.dumps(payload),
                    timeout_s=60.0,
                    cwd=str(self.workspace_path),
                )
        except (NativeRuntimeError, OSError, subprocess.TimeoutExpired) as exc:
            return self._nonpublishable_result(f"native health probe failed: {exc}")
        parsed = self._last_json_object(result.stdout)
        if result.returncode != 0:
            return {
                **self._nonpublishable_result(
                    f"native health probe exited {result.returncode}"
                ),
                "native_error": parsed,
                "stderr": (result.stderr or "")[-2000:],
            }
        expected = {
            "status": "ready",
            "agent_runtime": "hermes",
            "native_runtime_class": NATIVE_RUNTIME_CLASS,
            "native_runtime_api": NATIVE_RUNTIME_API,
            "native_agent_instantiated": True,
            "tool_bridge_plugin": PLUGIN_ID,
            "tool_bridge_api": PLUGIN_API,
            "tool_bridge_toolset": PLUGIN_TOOLSET,
            "tool_bridge_digest": bridge.digest,
            "tool_bridge_loaded_tools": [HEALTH_TOOL_NAME],
            "benchmark_workspace_path": str(self.workspace_path),
            "native_process_cwd": str(self.workspace_path),
            "transport": NATIVE_TRANSPORT,
            "legacy_raw_openai_bypass": False,
            "publishable_native": True,
        }
        if parsed is None or any(
            parsed.get(key) != value for key, value in expected.items()
        ):
            return {
                **self._nonpublishable_result(
                    "native health probe did not return verified AIAgent provenance"
                ),
                "native_error": parsed,
            }
        return parsed

    def is_ready(self) -> bool:
        return self.health().get("status") == "ready"

    def wait_until_ready(self, timeout: float = 60.0, poll: float = 1.0) -> None:
        deadline = time.monotonic() + float(timeout)
        last_error: object = "no probe attempted"
        while time.monotonic() < deadline:
            probe = self.health()
            if probe.get("status") == "ready":
                logger.info(
                    "native Hermes AIAgent ready (venv=%s, model=%s)",
                    self.venv_python,
                    self.model,
                )
                return
            last_error = probe.get("error") or probe
            time.sleep(poll)
        raise TimeoutError(
            f"hermes-agent venv not ready after {timeout}s: {last_error}"
        )

    def reset(
        self, task_id: str, benchmark: str, **kwargs: object
    ) -> dict[str, object]:
        del kwargs
        self._task_id = task_id
        self._benchmark = benchmark
        return {"task_id": task_id, "benchmark": benchmark, "status": "ready"}

    def send_message(
        self,
        text: str,
        context: Mapping[str, object] | None = None,
    ) -> MessageResponse:
        """Run one isolated native Hermes turn and return captured actions."""

        started = time.monotonic()
        try:
            if self.mode == "in_process":
                response = self._send_in_process(text, context)
            else:
                response = self._send_subprocess(text, context)
        except Exception as exc:
            _write_telemetry(
                harness="hermes",
                provider=self.provider,
                model=self.model,
                text=text,
                context=context,
                latency_ms=(time.monotonic() - started) * 1000.0,
                task_id=self._task_id,
                benchmark=self._benchmark,
                error=f"{type(exc).__name__}: {exc}",
            )
            raise
        _write_telemetry(
            harness="hermes",
            provider=self.provider,
            model=self.model,
            text=text,
            context=context,
            latency_ms=(time.monotonic() - started) * 1000.0,
            task_id=self._task_id,
            benchmark=self._benchmark,
            response=response,
        )
        return response

    def close(self) -> None:
        """Remove the temporary benchmark profile owned by this client."""

        owned_home = self._owned_home
        self._owned_home = None
        if owned_home is not None:
            owned_home.cleanup()

    def build_send_message_command(self) -> list[str]:
        """Return the exact native runner command for test inspection."""

        return [str(self.venv_python), "-u", str(_NATIVE_RUNNER_PATH)]

    def _native_payload_base(self) -> dict[str, object]:
        return {
            "repo_path": str(self.repo_path.resolve()),
            "workspace_path": str(self.workspace_path),
            "hermes_home": str(self.hermes_home),
            "model": self.model,
            "base_url": self.base_url,
            "api_key": self.api_key,
            "task_id": self._task_id,
            "benchmark": self._benchmark,
        }

    def build_send_message_payload(
        self,
        text: str,
        context: Mapping[str, object] | None,
    ) -> dict[str, object]:
        ctx = dict(context or {})
        raw_tools = ctx.get("tools")
        tools = _openai_compatible_tools(raw_tools)
        unsupported_tools = bool(raw_tools) and tools is None
        system_prompt = ctx.get("system_prompt")
        uses_system_hint = (
            not isinstance(system_prompt, str) or not system_prompt.strip()
        )
        if uses_system_hint:
            hint = ctx.get("system_hint")
            system_prompt = hint if isinstance(hint, str) else None
        context_for_prompt = (
            {**ctx, "system_prompt": system_prompt}
            if uses_system_hint and isinstance(system_prompt, str)
            else ctx
        )
        context_prompt = context_to_prompt(context_for_prompt)
        if context_prompt:
            prefix = system_prompt if isinstance(system_prompt, str) else ""
            system_prompt = f"{prefix}\n\nBenchmark context:\n{context_prompt}".strip()
        reasoning_effort = _coerce_optional_str(
            ctx.get("reasoning_effort"), fallback=self.reasoning_effort
        )
        if reasoning_effort is None and _is_gpt_oss_model(self.model):
            reasoning_effort = "low"
        if unsupported_tools:
            nonpublishable_reason: str | None = (
                "unsupported non-OpenAI benchmark tool schema"
            )
        elif self.mode == "in_process":
            nonpublishable_reason = "legacy in_process mode"
        elif not is_loopback_base_url(self.base_url):
            nonpublishable_reason = "gateway base URL is not loopback"
        else:
            nonpublishable_reason = None
        return {
            **self._native_payload_base(),
            "text": text,
            "context": ctx,
            "system_prompt": system_prompt if isinstance(system_prompt, str) else None,
            "tools": tools,
            "temperature": _coerce_optional_float(
                ctx.get("temperature"), fallback=self.temperature
            ),
            "reasoning_effort": reasoning_effort,
            "max_tokens": _coerce_optional_int(
                ctx.get("max_tokens"), fallback=self.max_tokens
            ),
            "tool_choice": _coerce_optional_str(ctx.get("tool_choice"), fallback=None),
            # Caller-declared env-owned tool contract: the native runner stops
            # the turn at the first captured tool batch instead of iterating
            # on bridge acknowledgements until max_iterations_reached.
            "capture_stop": ctx.get("capture_stop") is True,
            "request_publishable_native": nonpublishable_reason is None,
            "nonpublishable_reason": nonpublishable_reason,
        }

    def _send_subprocess(
        self,
        text: str,
        context: Mapping[str, object] | None,
    ) -> MessageResponse:
        payload = self.build_send_message_payload(text, context)
        if payload.get("request_publishable_native") is not True:
            raise RuntimeError(
                "Hermes benchmark request is nonpublishable: "
                f"{payload.get('nonpublishable_reason') or 'native provenance unavailable'}"
            )
        with self._native_lock:
            bridge = prepare_scoped_benchmark_plugin(
                self.hermes_home,
                payload.get("tools"),
                model=self.model,
                base_url=self.base_url,
            )
            payload["bridge"] = bridge.as_payload()
            command = self.build_send_message_command()
            result = self._run_python_subprocess(
                command[1:],
                stdin=json.dumps(payload),
                timeout_s=self.timeout_s,
                cwd=str(self.workspace_path),
            )
        parsed = self._last_json_object(result.stdout)
        if result.returncode != 0:
            raise RuntimeError(
                f"hermes-agent send_message failed (rc={result.returncode}):\n"
                f"NATIVE ERROR: {parsed}\n"
                f"STDERR (last 4000 chars):\n{(result.stderr or '')[-4000:]}"
            )
        if parsed is None:
            raise RuntimeError(
                "hermes-agent send_message produced no terminal JSON object. "
                f"STDERR (last 2000 chars):\n{(result.stderr or '')[-2000:]}"
            )
        response = self._parse_response(parsed)
        meta = response.params.get("_meta")
        expected_tool_names = list(bridge.tool_names)
        expected = {
            "agent_runtime": "hermes",
            "native_runtime_class": NATIVE_RUNTIME_CLASS,
            "native_runtime_api": NATIVE_RUNTIME_API,
            "native_agent_instantiated": True,
            "tool_bridge_plugin": PLUGIN_ID,
            "tool_bridge_api": PLUGIN_API,
            "tool_bridge_toolset": PLUGIN_TOOLSET,
            "tool_bridge_digest": bridge.digest,
            "tool_bridge_loaded_tools": expected_tool_names,
            "benchmark_workspace_path": str(self.workspace_path),
            "native_process_cwd": str(self.workspace_path),
            "transport": NATIVE_TRANSPORT,
            "legacy_raw_openai_bypass": False,
            "publishable_native": True,
        }
        if not isinstance(meta, Mapping) or any(
            meta.get(key) != value for key, value in expected.items()
        ):
            raise RuntimeError(
                "hermes-agent send_message returned unverified native provenance"
            )
        captured_count = meta.get("tool_bridge_captured_calls")
        returned_calls = response.params.get("tool_calls", [])
        if not isinstance(returned_calls, list):
            raise RuntimeError("Hermes native tool_calls payload is not a list")
        if captured_count != len(returned_calls):
            raise RuntimeError(
                "Hermes plugin capture count does not match returned native tool calls"
            )
        if any(call.get("name") not in bridge.tool_names for call in returned_calls):
            raise RuntimeError("Hermes returned a tool call outside the scoped plugin")
        adapter_error = response.params.get("error")
        if (
            isinstance(adapter_error, str)
            and adapter_error.strip()
            and not response.text.strip()
            and not response.actions
        ):
            raise RuntimeError(
                f"hermes-agent send_message returned adapter error: {adapter_error}"
            )
        return response

    def _send_in_process(
        self,
        text: str,
        context: Mapping[str, object] | None,
    ) -> MessageResponse:
        del text, context
        raise RuntimeError(
            "Hermes mode='in_process' is a nonpublishable legacy path: native "
            "benchmark execution requires a fresh subprocess so HERMES_HOME and "
            "plugin discovery are isolated before importing run_agent"
        )

    @staticmethod
    def _parse_response(raw: Mapping[str, object]) -> MessageResponse:
        actions_raw = raw.get("actions")
        actions = (
            [str(action) for action in actions_raw]
            if isinstance(actions_raw, Sequence)
            and not isinstance(actions_raw, (str, bytes))
            else []
        )
        params_raw = raw.get("params")
        params = dict(params_raw) if isinstance(params_raw, Mapping) else {}
        if "tool_calls" in params:
            params["tool_calls"] = _normalize_tool_calls(params.get("tool_calls"))
        thought_raw = raw.get("thought")
        thought = (
            thought_raw
            if isinstance(thought_raw, str) and thought_raw.strip()
            else None
        )
        text = str(raw.get("text") or "")
        if not text.strip() and thought is not None:
            text = thought
        usage = params.get("usage")
        if isinstance(usage, Mapping):
            params["usage"] = _normalize_usage_payload(usage)
        return MessageResponse(
            text=text, thought=thought, actions=actions, params=params
        )

    @staticmethod
    def _last_json_object(stdout: str | None) -> dict[str, object] | None:
        raw = (stdout or "").strip()
        if not raw:
            return None
        try:
            parsed = json.loads(raw.rsplit("\n", 1)[-1])
        except json.JSONDecodeError:
            return None
        return dict(parsed) if isinstance(parsed, Mapping) else None

    @staticmethod
    def _nonpublishable_result(reason: str) -> dict[str, object]:
        return {
            "status": "error",
            "error": reason,
            "agent_runtime": "hermes",
            "native_runtime_class": NATIVE_RUNTIME_CLASS,
            "native_runtime_api": NATIVE_RUNTIME_API,
            "tool_bridge_plugin": PLUGIN_ID,
            "tool_bridge_api": PLUGIN_API,
            "transport": "unsupported_legacy",
            "legacy_raw_openai_bypass": False,
            "publishable_native": False,
        }

    def _run_python_subprocess(
        self,
        args: list[str],
        *,
        stdin: str | None = None,
        timeout_s: float,
        cwd: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        command = [str(self.venv_python), *args]
        logger.debug("hermes-adapter spawn: %s (cwd=%s)", command, cwd)
        env = {**os.environ}
        env["HERMES_HOME"] = str(self.hermes_home)
        for key in (
            "HERMES_SAFE_MODE",
            "HERMES_KANBAN_TASK",
            "HERMES_ENABLE_PROJECT_PLUGINS",
        ):
            env.pop(key, None)
        env["OPENAI_API_KEY"] = self.api_key or "benchmark-loopback"
        env["OPENAI_BASE_URL"] = self.base_url
        env["OPENAI_MODEL"] = self.model
        env["TERMINAL_ENV"] = "local"
        # Hermes resolves its model-facing working directory from TERMINAL_CWD
        # before falling back to process cwd. Keep both carriers pinned to the
        # benchmark target rather than the separate source checkout imported
        # through ``repo_path``.
        env["TERMINAL_CWD"] = str(self.workspace_path)
        env["PYTHONUNBUFFERED"] = "1"
        return subprocess.run(  # noqa: S603 - fixed interpreter and argv, never a shell
            command,
            input=stdin,
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
