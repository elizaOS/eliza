"""Runs benchmark turns through an isolated OpenClaw embedded-agent loop.

Each turn receives a generated key-free provider config and native plugin that
exposes only its benchmark tools. Actual plugin executions are captured and
normalized into the shared ``MessageResponse`` surface; direct provider calls
remain test-only and are explicitly non-publishable.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from ._retry import (
    MAX_ATTEMPTS,
    RetryExhaustedError,
    backoff_seconds,
    is_retryable_status,
    parse_retry_after,
)
from .native_runtime import (
    AGENT_ID,
    NativeRuntimePaths,
    PROVIDER_ID,
    benchmark_runtime_env,
    inspect_native_session,
    normalize_benchmark_tools,
    prepare_native_runtime,
    read_captured_tool_executions,
)

logger = logging.getLogger(__name__)


DEFAULT_AGENTS_ROOT = Path.home() / ".eliza" / "agents" / "openclaw"
DEFAULT_REPO_PATH = Path.home() / ".eliza" / "agents" / "openclaw-src"
DEFAULT_BINARY_FALLBACK = (
    DEFAULT_AGENTS_ROOT / "v2026.5.7" / "node_modules" / ".bin" / "openclaw"
)
DEFAULT_MANIFEST_PATH = DEFAULT_AGENTS_ROOT / "manifest.json"
DEFAULT_PROVIDER = "cerebras"
DEFAULT_MODEL = "gemma-4-31b"
DEFAULT_API_KEY_ENV = "CEREBRAS_API_KEY"
DEFAULT_BASE_URL_ENV = "CEREBRAS_BASE_URL"
DEFAULT_BASE_URL = "https://api.cerebras.ai/v1"
DEFAULT_THINKING_LEVEL = "medium"
DEFAULT_TIMEOUT_S = 600.0
_ALLOWED_TOOL_CHOICES = {"auto", "required", "none"}
_ALLOWED_THINKING_LEVELS = {
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "adaptive",
    "xhigh",
    "max",
}
_REASONING_EFFORT_TO_THINKING = {
    "none": "off",
    "off": "off",
    "minimal": "minimal",
    "low": "low",
    "medium": "medium",
    "high": "high",
    "adaptive": "adaptive",
    "xhigh": "xhigh",
    "max": "max",
}


_JSON_BLOB_RE = re.compile(r"\{.*\}", re.DOTALL)


@dataclass
class MessageResponse:
    """Parsed response from a single OpenClaw turn."""

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


def context_to_prompt(context: Mapping[str, object] | None) -> str:
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
    for key in sorted(str(k) for k in context.keys()):
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
    else:
        system_hint = context.get("system_hint")
        if isinstance(system_hint, str) and system_hint.strip():
            parts.append(system_hint.strip())
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


def _jsonable(value: object) -> object:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Mapping):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_jsonable(v) for v in value]
    return str(value)


def _canonical_sha256(value: object) -> str:
    canonical = json.dumps(
        _jsonable(value), ensure_ascii=True, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


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


def _usage_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    return None


_TELEMETRY_TURN_COUNTER = 0
_TELEMETRY_FALLBACK_PATH: str | None = None


def _resolve_telemetry_path() -> str | None:
    """Resolve the per-turn telemetry JSONL path.

    Precedence: ``BENCHMARK_TELEMETRY_JSONL`` -> ``BENCHMARK_RUN_DIR/telemetry.jsonl``
    -> a process-local ``tempfile.mkdtemp`` fallback (logged once). Always returns a
    path so per-turn usage records are never silently dropped.
    """
    explicit = os.environ.get("BENCHMARK_TELEMETRY_JSONL", "").strip()
    if explicit:
        return explicit
    run_dir = os.environ.get("BENCHMARK_RUN_DIR", "").strip()
    if run_dir:
        return str(Path(run_dir) / "telemetry.jsonl")
    global _TELEMETRY_FALLBACK_PATH
    if _TELEMETRY_FALLBACK_PATH is None:
        import tempfile

        _TELEMETRY_FALLBACK_PATH = str(
            Path(tempfile.mkdtemp(prefix="openclaw-adapter-telemetry-"))
            / "telemetry.jsonl"
        )
        logger.info(
            "BENCHMARK_RUN_DIR not set; writing per-turn telemetry to %s",
            _TELEMETRY_FALLBACK_PATH,
        )
    return _TELEMETRY_FALLBACK_PATH


def _extract_usage_tokens(usage: Mapping[str, object]) -> dict[str, int | None]:
    def pick(*keys: str) -> int | None:
        for key in keys:
            value = _usage_int(usage.get(key))
            if value is not None:
                return value
        return None

    def pick_from_details(
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

    cache_read_input_tokens = pick(
        "cache_read_input_tokens",
        "cachedTokens",
        "cached_tokens",
    )
    if cache_read_input_tokens is None:
        cache_read_input_tokens = pick_from_details(
            ("prompt_tokens_details", "input_token_details"),
            ("cached_tokens", "cachedTokens", "cache_read_input_tokens"),
        )

    cache_creation_input_tokens = pick(
        "cache_creation_input_tokens",
        "cacheCreationInputTokens",
    )
    if cache_creation_input_tokens is None:
        cache_creation_input_tokens = pick_from_details(
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
        "cache_read_input_tokens": cache_read_input_tokens,
        "cache_creation_input_tokens": cache_creation_input_tokens,
    }


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
    prompt_text: str | None = None,
) -> None:
    telemetry_path = _resolve_telemetry_path()
    if not telemetry_path:
        return
    usage: dict[str, object] = {}
    if response is not None:
        usage_raw = response.params.get("usage")
        if isinstance(usage_raw, Mapping):
            usage = dict(usage_raw)
        else:
            meta_raw = response.params.get("_meta")
            if isinstance(meta_raw, Mapping) and isinstance(
                meta_raw.get("usage"), Mapping
            ):
                usage = dict(meta_raw["usage"])  # type: ignore[index]
    prompt = prompt_text if prompt_text is not None else _prompt_text(text, context)
    global _TELEMETRY_TURN_COUNTER
    turn_index = _TELEMETRY_TURN_COUNTER
    _TELEMETRY_TURN_COUNTER += 1
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
    runtime_provenance: dict[str, object] = {}
    if response is not None:
        meta = response.params.get("_meta")
        if isinstance(meta, Mapping):
            adapter_meta = meta.get("openclaw_adapter")
            if isinstance(adapter_meta, Mapping):
                runtime_provenance = dict(adapter_meta)
    record: dict[str, Any] = {
        "harness": harness,
        "provider": provider,
        "model": model,
        "benchmark": benchmark,
        "task_id": task_id,
        "turn_index": turn_index,
        "prompt_text": prompt,
        "prompt_chars": len(prompt),
        "latency_ms": latency_ms,
        "usage": _jsonable(usage),
        "prompt_tokens": tokens["prompt_tokens"],
        "completion_tokens": tokens["completion_tokens"],
        "total_tokens": tokens["total_tokens"],
        "cache_read_input_tokens": tokens["cache_read_input_tokens"],
        "cache_creation_input_tokens": tokens["cache_creation_input_tokens"],
        "actions": list(response.actions) if response is not None else [],
        "params": _jsonable(response.params) if response is not None else {},
        "runtime_provenance": _jsonable(runtime_provenance),
        "response_text": response.text if response is not None else "",
        "error_if_any": error,
    }
    try:
        path = Path(telemetry_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=True, sort_keys=True) + "\n")
    except OSError as exc:
        logger.debug("failed to write openclaw telemetry: %s", exc)


class OpenClawClient:
    """Run each benchmark turn through OpenClaw's embedded agent runtime.

    Every turn gets an isolated OpenClaw state directory and a generated
    native plugin containing only that turn's benchmark tools. This prevents
    developer configuration, memories, and unrelated tools from affecting a
    score while retaining OpenClaw's real planning and tool-execution loop.
    """

    def __init__(
        self,
        *,
        repo_path: Path | None = None,
        binary_path: Path | None = None,
        provider: str = DEFAULT_PROVIDER,
        model: str = DEFAULT_MODEL,
        api_key: str | None = None,
        api_key_env: str = DEFAULT_API_KEY_ENV,
        base_url: str | None = None,
        base_url_env: str = DEFAULT_BASE_URL_ENV,
        thinking_level: str = DEFAULT_THINKING_LEVEL,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        temperature: float | None = None,
        reasoning_effort: str | None = None,
        max_tokens: int | None = None,
        direct_openai_compatible: bool = False,
        allow_text_tool_calls: bool = False,
        native_state_root: Path | None = None,
    ) -> None:
        del allow_text_tool_calls
        campaign_provider = os.environ.get("BENCHMARK_MODEL_PROVIDER", "").strip()
        if provider == DEFAULT_PROVIDER and campaign_provider:
            provider = campaign_provider
        campaign_model = os.environ.get("BENCHMARK_MODEL_NAME", "").strip()
        if model == DEFAULT_MODEL and campaign_model:
            model = campaign_model
        self.repo_path = Path(repo_path) if repo_path else _default_repo_path()
        self.binary_path = (
            Path(binary_path) if binary_path else _resolve_default_binary()
        )
        self.provider = provider
        self.model = model
        if provider == "claude-subscription" and api_key_env == DEFAULT_API_KEY_ENV:
            api_key_env = "CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN"
        if provider == "claude-subscription" and base_url_env == DEFAULT_BASE_URL_ENV:
            base_url_env = "CLAUDE_SUBSCRIPTION_GATEWAY_URL"
        self.api_key_env = api_key_env
        self.base_url = (
            base_url.rstrip("/") if isinstance(base_url, str) and base_url else None
        )
        self.base_url_env = base_url_env
        default_api_key = _default_api_key(provider, api_key_env)
        if (
            provider == "claude-subscription"
            and api_key is not None
            and default_api_key
            and api_key != default_api_key
        ):
            raise ValueError(
                "Explicit OpenClaw API key does not match the active "
                "Claude-subscription gateway bearer"
            )
        self.api_key = (
            default_api_key
            if provider == "claude-subscription" and default_api_key
            else api_key
            if api_key is not None
            else default_api_key
        )
        self.thinking_level = thinking_level
        env_timeout_s = _env_optional_float("OPENCLAW_TIMEOUT_S")
        self.timeout_s = float(
            env_timeout_s
            if timeout_s == DEFAULT_TIMEOUT_S and env_timeout_s is not None
            else timeout_s
        )
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
        self.direct_openai_compatible = bool(direct_openai_compatible)
        configured_state_root = os.environ.get(
            "OPENCLAW_BENCHMARK_STATE_DIR", ""
        ).strip()
        self.native_state_root = (
            Path(native_state_root)
            if native_state_root is not None
            else Path(configured_state_root).expanduser()
            if configured_state_root
            else None
        )
        self._task_id: str | None = None
        self._benchmark: str | None = None
        self._turn_index = 0
        self._active_native_runtime: NativeRuntimePaths | None = None
        self._native_runtime_version: str | None = None
        self._native_runtime_build: str | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def health(self) -> dict[str, object]:
        """Probe the OpenClaw binary by running ``<binary> --version``.

        Invoking the executable validates both availability and a parseable
        runtime version/build identity before a benchmark turn consumes quota.
        """
        direct_requested = (
            self.direct_openai_compatible
            or os.environ.get("OPENCLAW_DIRECT_OPENAI_COMPAT", "").strip() == "1"
        )
        if direct_requested and os.environ.get("OPENCLAW_USE_CLI") != "1":
            return {
                "status": "ready",
                "transport": "direct_openai_compatible",
                "publishable_native": False,
                "model": self.model,
                "provider": self.provider,
            }
        if not self.binary_path.exists():
            return {
                "status": "error",
                "error": f"OpenClaw binary not found at {self.binary_path}",
            }
        try:
            result = subprocess.run(
                [str(self.binary_path), "--version"],
                env=self._base_child_env(),
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            return {"status": "error", "error": f"{type(exc).__name__}: {exc}"}
        if result.returncode != 0:
            tail = (result.stderr or result.stdout or "").strip()[-2000:]
            return {"status": "error", "error": tail or f"exit {result.returncode}"}

        version, build = _parse_version_line(result.stdout or "")
        if (
            version is None
            or _VALID_VERSION_RE.fullmatch(version) is None
            or build is None
            or _VALID_BUILD_RE.fullmatch(build) is None
        ):
            self._native_runtime_version = None
            self._native_runtime_build = None
            return {
                "status": "error",
                "error": "OpenClaw --version omitted a parseable version or build",
            }
        info: dict[str, object] = {
            "status": "ready",
            "transport": "openclaw_embedded_runtime",
            "agent_runtime": "openclaw",
            "publishable_native": True,
        }
        info["version"] = version
        info["build"] = build
        self._native_runtime_version = version
        self._native_runtime_build = build
        return info

    def is_ready(self) -> bool:
        """Cheap synchronous readiness check."""
        return self.health().get("status") == "ready"

    def wait_until_ready(self, timeout: float = 60.0, poll: float = 1.0) -> None:
        """Block until the binary becomes available or *timeout* elapses."""
        deadline = time.monotonic() + float(timeout)
        last_err: object = f"binary missing at {self.binary_path}"
        while time.monotonic() < deadline:
            if self.is_ready():
                probe = self.health()
                if probe.get("status") == "ready":
                    return
                last_err = probe.get("error") or probe
            time.sleep(poll)
        raise TimeoutError(f"OpenClaw harness not ready after {timeout}s: {last_err}")

    def reset(
        self,
        task_id: str,
        benchmark: str,
        **kwargs: object,
    ) -> dict[str, object]:
        """Record ``(task_id, benchmark)`` for log correlation.

        Extra kwargs are accepted for parity with other adapters and ignored.
        """
        del kwargs
        self._task_id = task_id
        self._benchmark = benchmark
        self._turn_index = 0
        self._active_native_runtime = None
        return {"task_id": task_id, "benchmark": benchmark, "ready": True}

    def send_message(
        self,
        text: str,
        context: Mapping[str, object] | None = None,
    ) -> MessageResponse:
        """Run one native OpenClaw turn and return its normalized result.

        The direct completion transport remains only for parser/retry tests and
        is always marked non-publishable. Benchmark factories use this native
        path so an OpenClaw result can never silently bypass OpenClaw itself.
        """
        direct_requested = (
            self.direct_openai_compatible
            or os.environ.get("OPENCLAW_DIRECT_OPENAI_COMPAT", "").strip() == "1"
        )
        if direct_requested and os.environ.get("OPENCLAW_USE_CLI") != "1":
            return self._send_openai_compatible(text, context)
        return self._send_cli(text, context)

    def _send_cli(
        self,
        text: str,
        context: Mapping[str, object] | None,
    ) -> MessageResponse:
        """Spawn one isolated embedded OpenClaw turn and parse it."""
        ctx = context or {}
        requested_tool_choice = _coerce_optional_str(
            ctx.get("tool_choice"), fallback="auto"
        )
        if requested_tool_choice not in _ALLOWED_TOOL_CHOICES:
            raise ValueError(
                f"unsupported OpenClaw tool_choice: {requested_tool_choice!r}"
            )
        tools = normalize_benchmark_tools(ctx.get("tools"))
        if requested_tool_choice == "required" and not tools:
            raise ValueError("OpenClaw tool_choice='required' needs at least one tool")
        runtime_tools = () if requested_tool_choice == "none" else tools
        max_tokens = _coerce_optional_int(
            ctx.get("max_tokens"), fallback=self.max_tokens
        )
        if max_tokens is not None and max_tokens <= 0:
            raise ValueError("OpenClaw max_tokens must be positive")
        temperature = _coerce_optional_float(
            ctx.get("temperature"), fallback=self.temperature
        )
        reasoning_effort = _coerce_optional_str(
            ctx.get("reasoning_effort"), fallback=self.reasoning_effort
        )
        thinking_level = _thinking_level_for_request(
            reasoning_effort=reasoning_effort,
            configured_thinking_level=self.thinking_level,
        )
        requested_system_prompt = _requested_native_system_prompt(text, ctx)
        native_system_prompt = _native_system_prompt(text, ctx)
        native_message = _cli_prompt_text(text, context)
        telemetry_prompt = _native_prompt_text(native_system_prompt, native_message)
        benchmark_workspace = _benchmark_workspace_path(ctx)
        benchmark_workspace_git_sha = _workspace_git_sha(benchmark_workspace)
        base_url = self.base_url or os.environ.get(self.base_url_env, "").strip()
        if not base_url:
            raise RuntimeError(
                "OpenClaw native benchmark runs require the loopback completion gateway URL"
            )
        gateway_token = self.api_key or os.environ.get(self.api_key_env, "").strip()
        if not gateway_token:
            gateway_token = os.environ.get(
                "CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN", ""
            ).strip()
        state_dir = self._turn_state_dir()
        # ``capture_stop`` is the caller-declared env-owned tool contract: the
        # benchmark env executes captured calls itself and replays real results
        # on the next send_message, so the embedded loop must end after the
        # first tool batch. Without it, OpenClaw iterates on the bridge's
        # placeholder acknowledgements — one billed completion per fake round
        # (~90 observed per tblite turn) ending in a non-deliverable
        # length-stop. Default off: ack-loop benchmarks (orchestrator
        # lifecycle) score reply text the model writes after seeing the ack.
        capture_stop = bool(ctx.get("capture_stop")) and bool(runtime_tools)
        runtime = prepare_native_runtime(
            tools=runtime_tools,
            model=self.model,
            base_url=base_url,
            timeout_s=self.timeout_s,
            max_tokens=max_tokens,
            temperature=temperature,
            thinking_level=thinking_level,
            system_prompt=native_system_prompt,
            state_dir=state_dir,
            capture_stop=capture_stop,
        )
        self._active_native_runtime = runtime
        argv = self.build_argv(text, context)
        env = benchmark_runtime_env(
            paths=runtime,
            gateway_token=gateway_token,
            parent=self._base_child_env(),
        )
        # OpenClaw otherwise resolves trajectory gitSha from the isolated
        # workspace's enclosing repository, which identifies elizaOS rather
        # than the OpenClaw executable. CLI health is the independent native
        # runtime identity boundary, so give that build precedence explicitly.
        env.pop("GIT_SHA", None)
        if self._native_runtime_build is not None:
            env["GIT_COMMIT"] = self._native_runtime_build
        else:
            env.pop("GIT_COMMIT", None)
        started = time.monotonic()
        try:
            result = subprocess.run(
                argv,
                env=env,
                capture_output=True,
                text=True,
                timeout=self.timeout_s,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            _write_telemetry(
                harness="openclaw",
                provider=self.provider,
                model=self.model,
                text=text,
                context=context,
                latency_ms=(time.monotonic() - started) * 1000.0,
                task_id=self._task_id,
                benchmark=self._benchmark,
                error=f"TimeoutExpired: {exc}",
                prompt_text=telemetry_prompt,
            )
            raise RuntimeError(
                f"openclaw CLI timed out after {self.timeout_s}s\n"
                f"argv: {argv}\n"
                f"stdout so far: {(exc.stdout or '')[-2000:]}\n"
                f"stderr so far: {(exc.stderr or '')[-2000:]}"
            ) from exc

        if result.returncode != 0:
            _write_telemetry(
                harness="openclaw",
                provider=self.provider,
                model=self.model,
                text=text,
                context=context,
                latency_ms=(time.monotonic() - started) * 1000.0,
                task_id=self._task_id,
                benchmark=self._benchmark,
                error=f"openclaw CLI failed rc={result.returncode}",
                prompt_text=telemetry_prompt,
            )
            raise RuntimeError(
                f"openclaw CLI failed rc={result.returncode}\n"
                f"argv: {argv}\n"
                f"stdout:\n{(result.stdout or '')[-4000:]}\n"
                f"stderr:\n{(result.stderr or '')[-4000:]}"
            )

        payload = _extract_json_blob(result.stdout or "", result.stderr or "")
        try:
            session_evidence = inspect_native_session(
                runtime,
                expected_thinking_level=thinking_level,
                expected_runtime_version=self._native_runtime_version,
                expected_runtime_git_sha=self._native_runtime_build,
            )
        except RuntimeError as exc:
            _write_telemetry(
                harness="openclaw",
                provider=self.provider,
                model=self.model,
                text=text,
                context=context,
                latency_ms=(time.monotonic() - started) * 1000.0,
                task_id=self._task_id,
                benchmark=self._benchmark,
                error=f"{type(exc).__name__}: {exc}",
                prompt_text=telemetry_prompt,
            )
            # error-policy:J2 name the adapter evidence boundary while keeping
            # the native transcript validation failure as the cause.
            raise RuntimeError(
                f"OpenClaw native transcript validation failed: {exc}"
            ) from exc
        response = _response_from_payload(payload)
        payload_usage = response.params.get("usage")
        response.params.pop("usage", None)
        response_meta = response.params.get("_meta")
        if isinstance(response_meta, dict):
            response_meta.pop("usage", None)
        if session_evidence.usage is not None:
            response.params["usage"] = dict(session_evidence.usage)
            if not isinstance(response_meta, dict):
                response_meta = {}
                response.params["_meta"] = response_meta
            response_meta["usage"] = dict(session_evidence.usage)
        captured_executions = read_captured_tool_executions(runtime.capture_path)
        captured_calls = [
            {
                "id": execution["id"],
                "name": execution["name"],
                "arguments": execution["arguments"],
            }
            for execution in captured_executions
        ]
        if captured_calls:
            response.actions = [str(call["name"]) for call in captured_calls]
            response.params["tool_calls"] = captured_calls
            response.params["lifecycle_results"] = [
                {
                    "name": execution["name"],
                    "arguments": execution["arguments"],
                    "result": execution["result"],
                }
                for execution in captured_executions
                if execution["result"].get("effect") == "not_executed"
            ]
            for call in captured_calls:
                response.params[str(call["name"])] = call["arguments"]
        if runtime_tools and requested_tool_choice == "required" and not captured_calls:
            raise RuntimeError(
                "OpenClaw completed a required-tool turn without executing a benchmark tool"
            )
        native_identity_attested = (
            self._native_runtime_version is not None
            and self._native_runtime_build is not None
            and session_evidence.trajectory_runtime_version
            == self._native_runtime_version
            and session_evidence.trajectory_runtime_git_sha
            == self._native_runtime_build
        )
        native_thinking_attested = (
            session_evidence.effective_thinking_level == thinking_level
            and session_evidence.trajectory_thinking_level == thinking_level
        )
        publishable_native = (
            session_evidence.status == "succeeded"
            and session_evidence.trajectory_status == "succeeded"
            and session_evidence.usage is not None
            and native_identity_attested
            and native_thinking_attested
        )
        _annotate_response(
            response,
            transport="openclaw_embedded_runtime",
            path_label="openclaw-native-plugin-loop",
            preserves_full_messages=False,
            passes_benchmark_tools=bool(runtime_tools),
            publishable_native=publishable_native,
            extra={
                "agent_runtime": "openclaw",
                "native_runtime_class": "openclaw.agent.embedded",
                "native_runtime_api": "openclaw agent --local --json",
                "tool_bridge": "native_plugin",
                "canonicalizes_full_history": True,
                "config_sha256": runtime.config_sha256,
                "tool_names": list(runtime.tool_names),
                "requested_max_tokens": max_tokens,
                "requested_temperature": temperature,
                "reasoning_effort_requested": reasoning_effort,
                "thinking_level_requested": thinking_level,
                "thinking_level_effective": (session_evidence.effective_thinking_level),
                "thinking_level_trajectory": (
                    session_evidence.trajectory_thinking_level
                ),
                "thinking_level_attested": native_thinking_attested,
                "reasoning_visibility_effective": (
                    session_evidence.trajectory_reasoning_level
                ),
                "requested_tool_choice": requested_tool_choice,
                "tool_choice_native_policy": (
                    "native_default_auto"
                    if requested_tool_choice == "auto"
                    else "tools_denied"
                    if requested_tool_choice == "none"
                    else "required_postcondition"
                ),
                "benchmark_messages_sha256": _canonical_sha256(
                    _messages_from_context(text, ctx)
                ),
                "tool_schema_sha256": _canonical_sha256(ctx.get("tools") or []),
                "native_system_prompt_surface": (
                    "workspace/AGENTS.md"
                    if runtime.system_prompt_sha256 is not None
                    else "none"
                ),
                "native_system_prompt_sha256": runtime.system_prompt_sha256,
                "native_prompt_sha256": hashlib.sha256(
                    telemetry_prompt.encode("utf-8")
                ).hexdigest(),
                "native_requested_system_prompt_sha256": (
                    hashlib.sha256(requested_system_prompt.encode("utf-8")).hexdigest()
                    if requested_system_prompt is not None
                    else None
                ),
                "native_system_prompt_matches_requested": (
                    runtime.system_prompt_sha256
                    == (
                        hashlib.sha256(
                            requested_system_prompt.encode("utf-8")
                        ).hexdigest()
                        if requested_system_prompt is not None
                        else None
                    )
                ),
                "native_system_prompt_in_cli_message": False,
                "benchmark_workspace_path": (
                    str(benchmark_workspace)
                    if benchmark_workspace is not None
                    else None
                ),
                "benchmark_workspace_git_sha": benchmark_workspace_git_sha,
                "runtime_workspace_path": str(runtime.workspace_dir),
                "runtime_workspace_isolated": (
                    benchmark_workspace is not None
                    and runtime.workspace_dir.resolve() != benchmark_workspace
                ),
                "capture_stop_after_scored_action": capture_stop,
                "native_session_evidence": session_evidence.status,
                "native_session_sha256": session_evidence.session_sha256,
                "native_session_terminal_stop_reason": (
                    session_evidence.terminal_stop_reason
                ),
                "native_session_assistant_model_call_count": (
                    session_evidence.assistant_model_call_count
                ),
                "native_usage_scope": "full_native_turn_aggregate",
                "native_usage_sha256": (
                    _canonical_sha256(session_evidence.usage)
                    if session_evidence.usage is not None
                    else None
                ),
                "native_payload_last_call_usage_sha256": (
                    _canonical_sha256(payload_usage)
                    if isinstance(payload_usage, Mapping)
                    else None
                ),
                "native_trajectory_evidence": session_evidence.trajectory_status,
                "native_trajectory_sha256": session_evidence.trajectory_sha256,
                "native_cli_health_version": self._native_runtime_version,
                "native_cli_health_build": self._native_runtime_build,
                "native_trajectory_runtime_version": (
                    session_evidence.trajectory_runtime_version
                ),
                "native_trajectory_runtime_git_sha": (
                    session_evidence.trajectory_runtime_git_sha
                ),
                "native_runtime_identity_attested": native_identity_attested,
            },
        )
        _write_telemetry(
            harness="openclaw",
            provider=self.provider,
            model=self.model,
            text=text,
            context=context,
            latency_ms=(time.monotonic() - started) * 1000.0,
            task_id=self._task_id,
            benchmark=self._benchmark,
            response=response,
            prompt_text=telemetry_prompt,
        )
        return response

    def _turn_state_dir(self) -> Path | None:
        turn_index = self._turn_index
        self._turn_index += 1
        if self.native_state_root is None:
            return None
        task = re.sub(r"[^A-Za-z0-9_-]", "-", self._task_id or "turn").strip("-")
        benchmark = re.sub(
            r"[^A-Za-z0-9_-]", "-", self._benchmark or "benchmark"
        ).strip("-")
        return self.native_state_root / benchmark / task / f"turn-{turn_index:04d}"

    def _send_openai_compatible(
        self,
        text: str,
        context: Mapping[str, object] | None,
    ) -> MessageResponse:
        """Call an OpenAI-compatible endpoint directly with retry.

        This keeps the adapter's smoke tests hermetic while sharing the same
        ``MessageResponse`` parser and telemetry shape as the CLI path.
        """
        started = time.monotonic()
        try:
            payload = _post_with_retry(
                url=f"{self.base_url or DEFAULT_BASE_URL}/chat/completions",
                body=self.build_openai_compatible_body(text, context),
                api_key=self.api_key
                or _default_api_key(self.provider, self.api_key_env),
                timeout_s=self.timeout_s,
            )
            response = _response_from_openai_completion(payload)
            _annotate_response(
                response,
                transport="direct_openai_compatible",
                path_label="openclaw-direct-openai-compatible-provider",
                preserves_full_messages=True,
                passes_benchmark_tools=bool(
                    context and _openai_compatible_tools(context.get("tools"))
                ),
                publishable_native=False,
            )
        except Exception as exc:
            _write_telemetry(
                harness="openclaw",
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
            harness="openclaw",
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

    # ------------------------------------------------------------------
    # Command construction (separated for unit-test inspection)
    # ------------------------------------------------------------------

    def build_argv(
        self,
        text: str,
        context: Mapping[str, object] | None,
    ) -> list[str]:
        """The exact argv used by :meth:`send_message`."""
        model_id = f"{PROVIDER_ID}/{self.model.rsplit('/', 1)[-1]}"
        message_text = _cli_prompt_text(text, context)
        reasoning_effort = _coerce_optional_str(
            (context or {}).get("reasoning_effort"), fallback=self.reasoning_effort
        )
        thinking_level = _thinking_level_for_request(
            reasoning_effort=reasoning_effort,
            configured_thinking_level=self.thinking_level,
        )
        argv: list[str] = [
            str(self.binary_path),
            "agent",
            "--local",
            "--json",
            "--model",
            model_id,
            "--thinking",
            thinking_level,
            "--timeout",
            str(int(self.timeout_s)),
            "--message",
            message_text,
        ]
        session_id: str | None = None
        agent_id: str | None = AGENT_ID
        if context:
            ctx_session = context.get("session_id")
            if isinstance(ctx_session, str) and ctx_session:
                session_id = ctx_session
            ctx_agent = context.get("agent_id")
            if isinstance(ctx_agent, str) and ctx_agent:
                agent_id = ctx_agent
        if session_id is not None:
            argv.extend(["--session-id", session_id])
        if agent_id is not None:
            argv.extend(["--agent", agent_id])
        return argv

    def build_env(self) -> dict[str, str]:
        """The env vars passed to the spawned CLI.

        The parent environment is inherited, then the configured API key /
        base URL env vars are mirrored into the canonical OpenAI-compatible
        names so OpenClaw's provider routing picks them up regardless of
        which key the operator set.
        """
        env = self._base_child_env()
        api_key = self.api_key or env.get(self.api_key_env, "")
        if api_key:
            env[self.api_key_env] = api_key
            env["OPENAI_API_KEY"] = api_key
        base_url = self.base_url or env.get(self.base_url_env, "")
        if base_url:
            env.setdefault("OPENAI_BASE_URL", base_url)
        return env

    def _base_child_env(self) -> dict[str, str]:
        env = dict(os.environ)
        node_bin = _resolve_compatible_node_bin(self.binary_path)
        if node_bin is not None:
            current_path = env.get("PATH", "")
            env["PATH"] = f"{node_bin.parent}{os.pathsep}{current_path}"
        return env

    def build_openai_compatible_body(
        self,
        text: str,
        context: Mapping[str, object] | None,
    ) -> dict[str, object]:
        """Build the direct OpenAI-compatible request body."""
        ctx = context or {}
        body: dict[str, object] = {
            "model": self.model,
            "messages": _direct_messages_from_context(text, ctx),
        }
        if ctx:
            tools = _openai_compatible_tools(ctx.get("tools"))
            if tools:
                body["tools"] = tools
                tool_choice = ctx.get("tool_choice")
                if (
                    isinstance(tool_choice, str)
                    and tool_choice in _ALLOWED_TOOL_CHOICES
                ):
                    body["tool_choice"] = tool_choice
            temperature = _coerce_optional_float(
                ctx.get("temperature"), fallback=self.temperature
            )
            if temperature is not None:
                body["temperature"] = temperature
            max_tokens = _coerce_optional_int(
                ctx.get("max_tokens"), fallback=self.max_tokens
            )
            if max_tokens is not None and max_tokens > 0:
                body["max_completion_tokens"] = max_tokens
            reasoning_effort = _coerce_optional_str(
                ctx.get("reasoning_effort"), fallback=self.reasoning_effort
            )
            if reasoning_effort and _is_gpt_oss_model(self.model):
                body["reasoning_effort"] = reasoning_effort
        else:
            if self.temperature is not None:
                body["temperature"] = self.temperature
            if self.max_tokens is not None and self.max_tokens > 0:
                body["max_completion_tokens"] = self.max_tokens
            if self.reasoning_effort and _is_gpt_oss_model(self.model):
                body["reasoning_effort"] = self.reasoning_effort
        return body


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------


def _post_with_retry(
    *,
    url: str,
    body: dict[str, Any],
    api_key: str,
    timeout_s: float,
) -> dict[str, Any]:
    """POST ``body`` as JSON, retrying on 429/5xx/network errors.

    On 4xx other than 429 the underlying ``HTTPError`` is re-wrapped as a
    ``RuntimeError`` immediately. After ``MAX_ATTEMPTS`` exhausted retries a
    :class:`RetryExhaustedError` is raised.
    """
    last_status: int | None = None
    last_error_str = "no attempt completed"
    for attempt in range(MAX_ATTEMPTS):
        request = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Accept-Encoding": "identity",
                "User-Agent": "eliza-openclaw-benchmark/1.0",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout_s) as response:  # nosec B310
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            status = int(exc.code) if isinstance(exc.code, int) else None
            detail = exc.read().decode("utf-8", errors="replace")
            last_status = status
            last_error_str = detail[:500]
            if status is None or not is_retryable_status(status):
                raise RuntimeError(
                    f"OpenClaw-compatible completion failed (status={status}): {detail}"
                ) from exc
            retry_after_raw: str | None = None
            try:
                retry_after_raw = (
                    exc.headers.get("Retry-After") if exc.headers else None
                )
            except AttributeError:
                retry_after_raw = None
            delay = parse_retry_after(retry_after_raw) or backoff_seconds(attempt)
        except urllib.error.URLError as exc:
            last_status = None
            last_error_str = f"{type(exc).__name__}: {exc.reason!r}"
            delay = backoff_seconds(attempt)
        except (TimeoutError, ConnectionError, OSError) as exc:
            last_status = None
            last_error_str = f"{type(exc).__name__}: {exc}"
            delay = backoff_seconds(attempt)
        if attempt == MAX_ATTEMPTS - 1:
            raise RetryExhaustedError(
                attempts=MAX_ATTEMPTS,
                last_status=last_status,
                last_error=last_error_str,
            )
        logger.warning(
            "openclaw-adapter retrying POST (attempt %d/%d, status=%s) after %.2fs: %s",
            attempt + 1,
            MAX_ATTEMPTS,
            "net" if last_status is None else last_status,
            delay,
            last_error_str[:200],
        )
        time.sleep(delay)
    # Unreachable — the loop always either returns or raises.
    raise RetryExhaustedError(  # pragma: no cover
        attempts=MAX_ATTEMPTS,
        last_status=last_status,
        last_error=last_error_str,
    )


def _resolve_default_binary() -> Path:
    """Resolve the default OpenClaw binary path.

    Order:
      1. ``OPENCLAW_BIN`` env override.
      2. ``binary_path`` field of ``~/.eliza/agents/openclaw/manifest.json``.
      3. an ``openclaw`` on ``PATH`` (a global ``npm i -g openclaw`` install).
      4. ``~/.eliza/agents/openclaw/v2026.5.7/node_modules/.bin/openclaw`` fallback.

    The PATH lookup (3) comes before the pinned fallback (4) so a plain global
    install resolves without an ``OPENCLAW_BIN`` export — the pinned path is a
    version-specific artifact that is absent on a fresh machine, and stale
    whenever the installed CLI version differs.
    """
    override = os.environ.get("OPENCLAW_BIN", "").strip()
    if override:
        return Path(override).expanduser()
    if DEFAULT_MANIFEST_PATH.exists():
        with DEFAULT_MANIFEST_PATH.open("r", encoding="utf-8") as fh:
            manifest = json.load(fh)
        if not isinstance(manifest, Mapping):
            raise ValueError("OpenClaw install manifest must be a JSON object")
        binary = manifest.get("binary_path")
        if not isinstance(binary, str) or not binary.strip():
            raise ValueError("OpenClaw install manifest requires binary_path")
        return Path(binary).expanduser()
    on_path = shutil.which("openclaw")
    if on_path:
        return Path(on_path)
    return DEFAULT_BINARY_FALLBACK


def _resolve_compatible_node_bin(binary_path: Path) -> Path | None:
    """Find the Node runtime shipped beside an isolated OpenClaw install."""

    override = os.environ.get("OPENCLAW_NODE_BIN", "").strip()
    if override:
        candidate = Path(override).expanduser()
        if not candidate.is_file():
            raise FileNotFoundError(f"OPENCLAW_NODE_BIN does not exist: {candidate}")
        return candidate
    for parent in binary_path.expanduser().resolve().parents:
        candidate = parent / "node" / "bin" / "node"
        if candidate.is_file():
            return candidate
        if parent.name == "node_modules":
            break
    return None


_VERSION_RE = re.compile(r"OpenClaw\s+(\S+)(?:\s+\(([^)]+)\))?")
_VALID_VERSION_RE = re.compile(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?")
_VALID_BUILD_RE = re.compile(r"[0-9a-fA-F]{7,40}")


def _parse_version_line(stdout: str) -> tuple[str | None, str | None]:
    """Parse ``OpenClaw 2026.5.7 (eeef486)`` → (version, build)."""
    for line in stdout.splitlines():
        match = _VERSION_RE.search(line)
        if match:
            version = match.group(1)
            build = match.group(2)
            return version, build
    return None, None


def _extract_json_blob(stdout: str, stderr: str) -> dict[str, object]:
    """Pull the first ``{...}`` JSON object out of the CLI's stdout.

    OpenClaw prefixes its JSON output with config warnings on stderr/stdout
    when stale plugin entries are present. We tolerate that prefix and raise
    a structured ``RuntimeError`` if no JSON can be located.
    """
    stripped = stdout.strip()
    if not stripped:
        raise RuntimeError(
            f"openclaw CLI produced no stdout.\nstderr:\n{stderr[-4000:]}"
        )
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        # error-policy:J3 a non-JSON prefix is an explicit invalid first shape;
        # the bounded object extractor below still rejects malformed payloads.
        parsed = None

    if parsed is None:
        match = _JSON_BLOB_RE.search(stripped)
        if not match:
            raise RuntimeError(
                "openclaw CLI stdout contained no JSON object.\n"
                f"stdout:\n{stripped[-4000:]}\n"
                f"stderr:\n{stderr[-4000:]}"
            )
        try:
            parsed = json.loads(match.group(0))
        except json.JSONDecodeError as exc:
            # error-policy:J2 retain the decoder failure behind adapter context.
            raise RuntimeError(
                f"openclaw CLI stdout JSON parse failed: {exc}\n"
                f"matched:\n{match.group(0)[-4000:]}\n"
                f"stdout:\n{stripped[-4000:]}"
            ) from exc

    if not isinstance(parsed, dict):
        raise RuntimeError(
            f"openclaw CLI returned non-object JSON ({type(parsed).__name__}): {parsed!r}"
        )
    return parsed


def _response_from_payload(payload: Mapping[str, object]) -> MessageResponse:
    """Map a parsed OpenClaw payload to :class:`MessageResponse`.

    OpenClaw's JSON shape is not fully stable across releases — we look up the
    response text under any of ``reply``/``message``/``content``/``text``,
    thought under ``reasoning``/``thought``, and tool calls under
    ``tool_calls``/``actions``. Each tool call surfaces in ``params`` as
    ``{name: arguments}``.
    """
    text = _first_str(payload, ("reply", "message", "content", "text", "output"))
    thought = _first_str(payload, ("reasoning", "reasoning_content", "thought"))
    if not text:
        text = _text_from_payloads(payload)
    if not text:
        meta = payload.get("meta")
        if isinstance(meta, Mapping):
            text = _first_str(
                meta, ("finalAssistantVisibleText", "finalAssistantRawText")
            )
    raw_tool_calls = _collect_tool_calls(payload)

    actions: list[str] = []
    params: dict[str, object] = {}
    for entry in raw_tool_calls:
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            continue
        actions.append(name)
        args = _decode_tool_arguments(entry.get("arguments"))
        params[name] = args if args is not None else {}

    extras: dict[str, object] = {}
    usage = _usage_from_meta(payload)
    if usage:
        params.setdefault("usage", usage)
        extras["usage"] = usage
    for key in ("usage", "sessionId", "session_id", "agent", "id"):
        if key == "usage" and "usage" in extras:
            continue
        value = payload.get(key)
        if value is not None and key not in params:
            extras[key] = value
    if extras:
        params.setdefault("_meta", extras)
    if raw_tool_calls:
        params.setdefault("tool_calls", raw_tool_calls)

    response = MessageResponse(
        text=text or "",
        thought=thought or None,
        actions=actions,
        params=params,
    )
    _annotate_response(
        response,
        transport="parsed_payload",
        path_label="openclaw-payload",
        preserves_full_messages=False,
        passes_benchmark_tools=False,
    )
    return response


def _response_from_openai_completion(payload: Mapping[str, object]) -> MessageResponse:
    """Map an OpenAI-compatible chat completion to :class:`MessageResponse`."""
    choices = payload.get("choices")
    choice: object = (
        choices[0]
        if isinstance(choices, Sequence)
        and not isinstance(choices, (str, bytes))
        and choices
        else {}
    )
    message = choice.get("message") if isinstance(choice, Mapping) else {}
    message_map = message if isinstance(message, Mapping) else {}
    normalized: dict[str, object] = {
        "message": message_map,
        "tool_calls": message_map.get("tool_calls", []),
    }
    usage = payload.get("usage")
    if isinstance(usage, Mapping):
        normalized["usage"] = dict(usage)
    return _response_from_payload(normalized)


def _annotate_response(
    response: MessageResponse,
    *,
    transport: str,
    path_label: str,
    preserves_full_messages: bool,
    passes_benchmark_tools: bool,
    publishable_native: bool = False,
    extra: Mapping[str, object] | None = None,
) -> None:
    """Attach adapter metadata used by harness conformance tests.

    Native cross-agent claims must be based on OpenAI-compatible
    ``messages`` plus ``tools``/``tool_calls``. The CLI path is still useful
    for OpenClaw smoke coverage, but it flattens benchmark payloads into
    ``--message`` and is therefore marked partial.
    """
    meta = response.params.get("_meta")
    if not isinstance(meta, dict):
        meta = {}
        response.params["_meta"] = meta
    adapter_meta: dict[str, object] = {
        "transport": transport,
        "path_label": path_label,
        "native_openai_tool_calls": transport == "direct_openai_compatible",
        "preserves_full_messages": preserves_full_messages,
        "passes_benchmark_tools": passes_benchmark_tools,
        "publishable_native": publishable_native,
    }
    if extra:
        adapter_meta.update(extra)
    meta["openclaw_adapter"] = adapter_meta


def _first_str(payload: Mapping[str, object], keys: Sequence[str]) -> str:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
        # Nested message.content shapes (chat-completions-style).
        if isinstance(value, Mapping):
            nested = value.get("content")
            if isinstance(nested, str) and nested:
                return nested
    return ""


def _text_from_payloads(payload: Mapping[str, object]) -> str:
    payloads = payload.get("payloads")
    if not isinstance(payloads, Sequence) or isinstance(payloads, (str, bytes)):
        return ""
    for item in payloads:
        if not isinstance(item, Mapping):
            continue
        text = item.get("text")
        if isinstance(text, str) and text:
            return text
        nested = item.get("payload")
        if isinstance(nested, Mapping):
            nested_text = nested.get("text") or nested.get("content")
            if isinstance(nested_text, str) and nested_text:
                return nested_text
    return ""


def _usage_from_meta(payload: Mapping[str, object]) -> dict[str, object]:
    direct_usage = payload.get("usage") or payload.get("token_usage")
    if isinstance(direct_usage, Mapping):
        normalized = _normalize_usage(direct_usage)
        if normalized:
            return normalized
    meta = payload.get("meta")
    if not isinstance(meta, Mapping):
        return {}
    agent_meta = meta.get("agentMeta")
    if isinstance(agent_meta, Mapping):
        usage = agent_meta.get("lastCallUsage") or agent_meta.get("usage")
        if isinstance(usage, Mapping):
            normalized = _normalize_usage(usage)
            if normalized:
                return normalized
    meta_usage = meta.get("usage") or meta.get("lastCallUsage")
    if isinstance(meta_usage, Mapping):
        normalized = _normalize_usage(meta_usage)
        if normalized:
            return normalized
    return {}


def _normalize_usage(usage: Mapping[str, object]) -> dict[str, object]:
    tokens = _extract_usage_tokens(usage)
    input_tokens = tokens["prompt_tokens"]
    output_tokens = tokens["completion_tokens"]

    def _pick(*keys: str) -> int | None:
        for key in keys:
            value = _usage_int(usage.get(key))
            if value is not None:
                return value
        return None

    total = tokens["total_tokens"]
    if total is None:
        total = _pick("total", "totalTokens")
    cache_read = tokens["cache_read_input_tokens"]
    cache_write = tokens["cache_creation_input_tokens"]

    if not any(
        value is not None
        for value in (input_tokens, output_tokens, total, cache_read, cache_write)
    ):
        return {}
    return {
        "prompt_tokens": input_tokens if input_tokens is not None else 0,
        "completion_tokens": output_tokens if output_tokens is not None else 0,
        "total_tokens": total if total is not None else 0,
        "prompt_tokens_details": {
            "cached_tokens": cache_read if cache_read is not None else 0,
            "cache_write_tokens": cache_write if cache_write is not None else 0,
        },
    }


def _collect_tool_calls(payload: Mapping[str, object]) -> list[dict[str, object]]:
    """Normalize OpenClaw tool calls into a list of ``{id, name, arguments}``."""
    collected: list[dict[str, object]] = []
    for key in ("tool_calls", "toolCalls", "actions"):
        raw = payload.get(key)
        if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
            continue
        for entry in raw:
            normalized = _normalize_tool_call(entry, fallback_index=len(collected))
            if normalized is not None:
                collected.append(normalized)
    return collected


def _decode_tool_arguments(raw: object) -> object:
    if not isinstance(raw, str):
        return raw
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # error-policy:J3 native runtimes may emit opaque scalar arguments;
        # preserving the string keeps its non-JSON shape explicit to callers.
        return raw


def _normalize_tool_call(
    raw: object, *, fallback_index: int
) -> dict[str, object] | None:
    if not isinstance(raw, Mapping):
        return None
    function = raw.get("function") if isinstance(raw.get("function"), Mapping) else None
    name_obj = function.get("name") if function else raw.get("name") or raw.get("tool")
    if not isinstance(name_obj, str) or not name_obj:
        return None
    if function is not None:
        args_obj: object = function.get("arguments", {})
    else:
        args_obj = raw.get("arguments", raw.get("args", {}))
    args_obj = _decode_tool_arguments(args_obj)
    call_id = raw.get("id")
    return {
        "id": str(call_id)
        if isinstance(call_id, (str, int))
        else f"call_{fallback_index}",
        "name": name_obj,
        "arguments": args_obj if args_obj is not None else {},
    }


def _coerce_native_tool_call(raw: object) -> dict[str, object] | None:
    if not isinstance(raw, Mapping):
        return None
    fn = raw.get("function")
    if isinstance(fn, Mapping):
        name = fn.get("name")
        args: object = fn.get("arguments", {})
    else:
        name = raw.get("name")
        args = raw.get("arguments", {})
    if not isinstance(name, str) or not name:
        return None
    args = _decode_tool_arguments(args)
    return {
        "id": str(raw.get("id") or ""),
        "name": name,
        "arguments": args,
    }


def _messages_from_context(
    text: str, ctx: Mapping[str, object]
) -> list[dict[str, object]]:
    raw_benchmark_messages = ctx.get("benchmark_messages")
    uses_benchmark_history = isinstance(
        raw_benchmark_messages, Sequence
    ) and not isinstance(raw_benchmark_messages, (str, bytes))
    raw_messages = (
        raw_benchmark_messages if uses_benchmark_history else ctx.get("messages")
    )
    messages: list[dict[str, object]] = []
    if isinstance(raw_messages, Sequence) and not isinstance(
        raw_messages, (str, bytes)
    ):
        for item in raw_messages:
            if not isinstance(item, Mapping):
                continue
            message = _openai_message_from_raw(item)
            if message is not None:
                messages.append(message)
    if uses_benchmark_history:
        if not (
            messages
            and messages[-1].get("role") == "user"
            and messages[-1].get("content") == text
        ):
            messages.append({"role": "user", "content": text})
    elif not messages:
        sys_prompt = ctx.get("system_prompt")
        if isinstance(sys_prompt, str) and sys_prompt.strip():
            messages.append({"role": "system", "content": sys_prompt.strip()})
        messages.append({"role": "user", "content": text})
    return messages


def _requested_native_system_prompt(
    text: str,
    ctx: Mapping[str, object],
) -> str | None:
    """Collect the benchmark-requested system text before runtime equalization."""

    parts: list[str] = []
    for message in _messages_from_context(text, ctx):
        if message.get("role") != "system":
            continue
        content = message.get("content")
        if content in (None, ""):
            continue
        if not isinstance(content, str):
            raise TypeError("OpenClaw native system messages must contain text")
        normalized = content.strip()
        if normalized and normalized not in parts:
            parts.append(normalized)

    explicit = ctx.get("system_prompt")
    if not isinstance(explicit, str) or not explicit.strip():
        explicit = ctx.get("system_hint")
    if isinstance(explicit, str):
        normalized = explicit.strip()
        if normalized and normalized not in parts:
            parts.append(normalized)
    return "\n\n".join(parts) if parts else None


def _benchmark_workspace_path(ctx: Mapping[str, object]) -> Path | None:
    raw = ctx.get("benchmark_workspace_path")
    if raw is None:
        return None
    if not isinstance(raw, str) or not raw.strip():
        raise TypeError("OpenClaw benchmark_workspace_path must be a non-empty path")
    workspace = Path(raw).expanduser().resolve()
    if not workspace.is_dir():
        raise ValueError(
            f"OpenClaw benchmark workspace is not a directory: {workspace}"
        )
    return workspace


def _native_system_prompt(text: str, ctx: Mapping[str, object]) -> str | None:
    """Keep target-workspace provenance out of model-visible instructions."""

    return _requested_native_system_prompt(text, ctx)


def _thinking_level_for_request(
    *,
    reasoning_effort: str | None,
    configured_thinking_level: str,
) -> str:
    """Map the shared benchmark effort onto OpenClaw's native CLI control."""

    if reasoning_effort is not None:
        normalized_effort = reasoning_effort.strip().lower()
        mapped = _REASONING_EFFORT_TO_THINKING.get(normalized_effort)
        if mapped is None:
            raise ValueError(
                f"unsupported OpenClaw reasoning_effort: {reasoning_effort!r}"
            )
        return mapped
    normalized_thinking = configured_thinking_level.strip().lower()
    if normalized_thinking not in _ALLOWED_THINKING_LEVELS:
        raise ValueError(
            f"unsupported OpenClaw thinking_level: {configured_thinking_level!r}"
        )
    return normalized_thinking


def _workspace_git_sha(workspace_path: Path | None) -> str | None:
    """Identify benchmark source separately from the OpenClaw runtime build."""

    if workspace_path is None:
        return None
    try:
        completed = subprocess.run(
            ["git", "-C", str(workspace_path), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        # error-policy:J3 unavailable source provenance remains an explicit
        # ``None`` signal that publishability validation rejects.
        return None
    candidate = completed.stdout.strip().lower()
    if completed.returncode != 0 or not re.fullmatch(r"[0-9a-f]{40}", candidate):
        return None
    return candidate


def _native_prompt_text(system_prompt: str | None, message_text: str) -> str:
    """Represent the two benchmark-controlled native prompt surfaces once each."""

    parts = []
    if system_prompt:
        parts.append(f"system: {system_prompt}")
    if message_text:
        parts.append(message_text)
    return "\n\n".join(parts)


def _direct_messages_from_context(
    text: str,
    ctx: Mapping[str, object],
) -> list[dict[str, object]]:
    """Build direct OpenAI messages while preserving benchmark context.

    The CLI transport flattens ``context_to_prompt(ctx)`` into the message
    string. Direct transport must do the same, otherwise benchmarks that pass
    structured task metadata through ``context`` become materially different
    between OpenClaw and Hermes/Eliza.
    """
    messages = _messages_from_context(text, ctx)
    context_prompt = context_to_prompt(ctx)
    if not context_prompt:
        return messages

    benchmark_context = f"Benchmark context:\n{context_prompt}"
    for message in messages:
        if message.get("role") == "system":
            current = message.get("content")
            prefix = current if isinstance(current, str) else ""
            message["content"] = f"{prefix}\n\n{benchmark_context}".strip()
            return messages

    return [{"role": "system", "content": benchmark_context}, *messages]


def _openai_message_from_raw(raw: Mapping[str, object]) -> dict[str, object] | None:
    role = raw.get("role")
    if role not in {"system", "user", "assistant", "tool"}:
        return None
    message: dict[str, object] = {"role": str(role)}
    raw_tool_calls = raw.get("tool_calls") or raw.get("toolCalls")
    tool_calls = _openai_tool_calls_from_raw(raw_tool_calls)
    content = raw.get("content")
    if content is None and role == "assistant" and tool_calls:
        message["content"] = None
    else:
        message["content"] = _jsonable(content) if content is not None else ""
    name = raw.get("name")
    if isinstance(name, str) and name:
        message["name"] = name
    tool_call_id = raw.get("tool_call_id") or raw.get("toolCallId")
    if isinstance(tool_call_id, str) and tool_call_id:
        message["tool_call_id"] = tool_call_id
    if tool_calls:
        message["tool_calls"] = tool_calls
    return message


def _openai_tool_calls_from_raw(raw: object) -> list[dict[str, object]]:
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        return []
    calls: list[dict[str, object]] = []
    for index, item in enumerate(raw):
        normalized = _normalize_tool_call(item, fallback_index=index)
        if normalized is None:
            continue
        args = normalized.get("arguments", {})
        if not isinstance(args, str):
            args = json.dumps(args if args is not None else {}, ensure_ascii=True)
        calls.append(
            {
                "id": str(normalized.get("id") or f"call_{index}"),
                "type": "function",
                "function": {
                    "name": str(normalized["name"]),
                    "arguments": args,
                },
            }
        )
    return calls


def _openai_compatible_tools(raw_tools: object) -> list[object] | None:
    """Return tools only when every item is an OpenAI tool object.

    Some benchmark contexts use simple string tool names or local schemas. The
    OpenAI-compatible APIs reject those as ``tools``; keep them out of the
    request body so the run fails only on real model/runtime issues.
    """
    if not isinstance(raw_tools, list) or not raw_tools:
        return None
    for item in raw_tools:
        if not isinstance(item, Mapping):
            return None
        function = item.get("function")
        if item.get("type") != "function" or not isinstance(function, Mapping):
            return None
        if not isinstance(function.get("name"), str):
            return None
    return list(raw_tools)


def _cli_prompt_text(text: str, context: Mapping[str, object] | None) -> str:
    """Serialize non-system history for one isolated native turn."""
    if not context:
        return text
    parts: list[str] = []
    user_context = {
        key: value
        for key, value in context.items()
        if key not in {"system_prompt", "system_hint"}
    }
    context_prompt = context_to_prompt(user_context)
    if context_prompt:
        parts.append(f"Benchmark context:\n{context_prompt}")
    messages = _messages_from_context(text, context)
    for message in messages:
        role = message.get("role", "user")
        if role == "system":
            continue
        content = message.get("content", "")
        if role == "assistant" and message.get("tool_calls"):
            parts.append(
                "assistant tool_calls: "
                + json.dumps(
                    message["tool_calls"],
                    ensure_ascii=True,
                    sort_keys=True,
                    separators=(",", ":"),
                )
            )
        if role == "tool":
            tool_call_id = message.get("tool_call_id") or "unknown"
            name = message.get("name") or "tool"
            parts.append(f"tool {name} [{tool_call_id}]: {content}")
        elif content not in (None, ""):
            parts.append(f"{role}: {content}")
    return "\n\n".join(part for part in parts if part.strip()) or text


def _default_api_key(provider: str, api_key_env: str) -> str:
    provider = provider.strip().lower()
    if provider == "claude-subscription":
        # Subscription runs authenticate only to the per-lane loopback gateway.
        # OPENCLAW_API_KEY is a generic native-provider override and must never
        # replace that ephemeral bearer.
        return os.environ.get("CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN", "")
    key_env = {
        "cerebras": "CEREBRAS_API_KEY",
        "openai": "OPENAI_API_KEY",
        "openrouter": "OPENROUTER_API_KEY",
        "groq": "GROQ_API_KEY",
    }.get(provider, api_key_env)
    return os.environ.get("OPENCLAW_API_KEY") or os.environ.get(key_env, "")


def _default_repo_path() -> Path:
    override = os.environ.get("OPENCLAW_REPO_PATH", "").strip()
    if override:
        return Path(override).expanduser()
    return DEFAULT_REPO_PATH


__all__ = [
    "MessageResponse",
    "OpenClawClient",
]
