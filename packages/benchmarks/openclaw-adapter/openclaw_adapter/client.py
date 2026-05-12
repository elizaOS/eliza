"""Client surface for running benchmarks through an OpenClaw-style harness.

The real OpenClaw project is installed from source by
``benchmarks.lib.agent_install``. For benchmark parity this client exposes the
same small surface as ``ElizaClient`` / ``HermesClient``: ``reset`` plus
``send_message`` returning a normalized ``MessageResponse``.

Every ``send_message`` spawns ``openclaw agent --local --json --message <text>``
and maps the JSON output into a :class:`MessageResponse`. The provider /
model / api-key fields configure the env vars passed to the spawned CLI so
OpenClaw's own provider routing picks the right backend.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
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

logger = logging.getLogger(__name__)


DEFAULT_AGENTS_ROOT = Path.home() / ".eliza" / "agents" / "openclaw"
DEFAULT_REPO_PATH = Path.home() / ".eliza" / "agents" / "openclaw-src"
DEFAULT_BINARY_FALLBACK = (
    DEFAULT_AGENTS_ROOT / "v2026.5.7" / "node_modules" / ".bin" / "openclaw"
)
DEFAULT_MANIFEST_PATH = DEFAULT_AGENTS_ROOT / "manifest.json"
DEFAULT_PROVIDER = "cerebras"
DEFAULT_MODEL = "gpt-oss-120b"
DEFAULT_API_KEY_ENV = "CEREBRAS_API_KEY"
DEFAULT_BASE_URL_ENV = "CEREBRAS_BASE_URL"
DEFAULT_BASE_URL = "https://api.cerebras.ai/v1"
DEFAULT_THINKING_LEVEL = "medium"
DEFAULT_TIMEOUT_S = 600.0
_ALLOWED_TOOL_CHOICES = {"auto", "required", "none"}


_JSON_BLOB_RE = re.compile(r"\{.*\}", re.DOTALL)
_TOOL_CALL_RE = re.compile(
    r"<tool_call>\s*(\{.*?\})\s*</tool_call>",
    re.DOTALL,
)
_TOOL_CALL_OPENER_RE = re.compile(r"<tool_call>\s*(\{)", re.DOTALL)


@dataclass
class MessageResponse:
    """Parsed response from a single OpenClaw turn."""

    text: str
    thought: str | None
    actions: list[str]
    params: dict[str, object]


_CONTROL_CONTEXT_KEYS = {
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
}


def context_to_prompt(context: Mapping[str, object] | None) -> str:
    if not context:
        return ""
    parts: list[str] = []
    hint_keys = ("instructions",) if isinstance(context.get("system_prompt"), str) else ("system_hint", "instructions")
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
        parts.append(f"{key}:\n{json.dumps(_jsonable(value), ensure_ascii=True, indent=2)}")
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
            Path(tempfile.mkdtemp(prefix="openclaw-adapter-telemetry-")) / "telemetry.jsonl"
        )
        logger.info(
            "BENCHMARK_RUN_DIR not set; writing per-turn telemetry to %s",
            _TELEMETRY_FALLBACK_PATH,
        )
    return _TELEMETRY_FALLBACK_PATH


def _extract_usage_tokens(usage: Mapping[str, object]) -> dict[str, int | None]:
    def pick(*keys: str) -> int | None:
        for key in keys:
            value = usage.get(key)
            if isinstance(value, (int, float)) and value:
                return int(value)
        return None

    return {
        "prompt_tokens": pick("prompt_tokens", "promptTokens", "input_tokens"),
        "completion_tokens": pick(
            "completion_tokens", "completionTokens", "output_tokens"
        ),
        "total_tokens": pick("total_tokens", "totalTokens"),
        "cache_read_input_tokens": pick(
            "cache_read_input_tokens", "cachedTokens", "cached_tokens"
        ),
        "cache_creation_input_tokens": pick(
            "cache_creation_input_tokens", "cacheCreationInputTokens"
        ),
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
            if isinstance(meta_raw, Mapping) and isinstance(meta_raw.get("usage"), Mapping):
                usage = dict(meta_raw["usage"])  # type: ignore[index]
    prompt = _prompt_text(text, context)
    global _TELEMETRY_TURN_COUNTER
    turn_index = _TELEMETRY_TURN_COUNTER
    _TELEMETRY_TURN_COUNTER += 1
    tokens = _extract_usage_tokens(usage) if usage else {
        "prompt_tokens": None,
        "completion_tokens": None,
        "total_tokens": None,
        "cache_read_input_tokens": None,
        "cache_creation_input_tokens": None,
    }
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
    """Spawn ``openclaw agent --local --json`` per turn.

    The client is stateless. ``reset`` simply records the ``task_id`` and
    ``benchmark`` strings for log correlation; per-turn state belongs to the
    caller (e.g. via ``context['session_id']``).
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
    ) -> None:
        self.repo_path = Path(repo_path) if repo_path else _default_repo_path()
        self.binary_path = Path(binary_path) if binary_path else _resolve_default_binary()
        self.provider = provider
        self.model = model
        self.api_key_env = api_key_env
        self.base_url = base_url.rstrip("/") if isinstance(base_url, str) and base_url else None
        self.base_url_env = base_url_env
        self.api_key = api_key if api_key is not None else _default_api_key(provider, api_key_env)
        self.thinking_level = thinking_level
        self.timeout_s = float(timeout_s)
        self.temperature = (
            temperature
            if temperature is not None
            else _env_optional_float("BENCHMARK_TEMPERATURE", "TEMPERATURE")
        )
        self.reasoning_effort = (
            reasoning_effort
            if reasoning_effort is not None
            else _env_optional_str("BENCHMARK_REASONING_EFFORT", "CEREBRAS_REASONING_EFFORT")
        )
        self.max_tokens = (
            max_tokens
            if max_tokens is not None
            else _env_optional_int("BENCHMARK_MAX_TOKENS", "MAX_TOKENS")
        )
        self.direct_openai_compatible = bool(direct_openai_compatible)
        self.allow_text_tool_calls = bool(allow_text_tool_calls) or (
            os.environ.get("OPENCLAW_ALLOW_TEXT_TOOL_CALLS", "").strip() == "1"
        )
        self._task_id: str | None = None
        self._benchmark: str | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def health(self) -> dict[str, object]:
        """Probe the OpenClaw binary by running ``<binary> --version``.

        Single canonical path — there is no "skip the subprocess" mode. If the
        binary exists, we must invoke it to fail fast on a broken install. The
        old conditional that returned ``ready`` based purely on file existence
        masked install corruption until the first benchmark turn.
        """
        if not self.binary_path.exists():
            return {
                "status": "error",
                "error": f"OpenClaw binary not found at {self.binary_path}",
            }
        try:
            result = subprocess.run(
                [str(self.binary_path), "--version"],
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
        info: dict[str, object] = {"status": "ready"}
        if version:
            info["version"] = version
        if build:
            info["build"] = build
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
        raise TimeoutError(
            f"OpenClaw harness not ready after {timeout}s: {last_err}"
        )

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
        return {"task_id": task_id, "benchmark": benchmark, "ready": True}

    def send_message(
        self,
        text: str,
        context: Mapping[str, object] | None = None,
    ) -> MessageResponse:
        """Run one OpenClaw turn and parse it.

        Normal benchmark runs use the OpenClaw CLI. Tests and lightweight
        smoke paths can set ``direct_openai_compatible=True`` (or
        ``OPENCLAW_DIRECT_OPENAI_COMPAT=1``) to exercise the direct
        OpenAI-compatible retry/parser path without requiring the Node binary.
        Setting ``OPENCLAW_USE_CLI=1`` always forces the CLI path.
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
        """Spawn one ``openclaw agent --local --json`` turn and parse it."""
        argv = self.build_argv(text, context)
        env = self.build_env()
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
            )
            raise RuntimeError(
                f"openclaw CLI failed rc={result.returncode}\n"
                f"argv: {argv}\n"
                f"stdout:\n{(result.stdout or '')[-4000:]}\n"
                f"stderr:\n{(result.stderr or '')[-4000:]}"
            )

        payload = _extract_json_blob(result.stdout or "", result.stderr or "")
        response = _response_from_payload(
            payload,
            allow_text_tool_calls=self.allow_text_tool_calls,
        )
        _annotate_response(
            response,
            transport="openclaw_cli",
            path_label="openclaw-cli-one-shot",
            preserves_full_messages=False,
            passes_benchmark_tools=False,
            counts_text_embedded_tool_calls=self.allow_text_tool_calls,
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
        )
        return response

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
                api_key=self.api_key or _default_api_key(self.provider, self.api_key_env),
                timeout_s=self.timeout_s,
            )
            response = _response_from_openai_completion(
                payload,
                allow_text_tool_calls=self.allow_text_tool_calls,
            )
            _annotate_response(
                response,
                transport="direct_openai_compatible",
                path_label="openclaw-direct-openai-compatible-provider",
                preserves_full_messages=True,
                passes_benchmark_tools=bool(
                    context
                    and isinstance(context.get("tools"), list)
                    and context.get("tools")
                ),
                counts_text_embedded_tool_calls=self.allow_text_tool_calls,
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
        model_id = self.model
        if self.provider and "/" not in model_id:
            model_id = f"{self.provider}/{model_id}"
        message_text = _cli_prompt_text(text, context)
        argv: list[str] = [
            str(self.binary_path),
            "agent",
            "--local",
            "--json",
            "--model",
            model_id,
            "--thinking",
            self.thinking_level,
            "--timeout",
            str(int(self.timeout_s)),
            "--message",
            message_text,
        ]
        session_id: str | None = None
        agent_id: str | None = None
        if context:
            ctx_session = context.get("session_id")
            if isinstance(ctx_session, str) and ctx_session:
                session_id = ctx_session
            ctx_agent = context.get("agent_id")
            if isinstance(ctx_agent, str) and ctx_agent:
                agent_id = ctx_agent
        # ``openclaw agent --local`` rejects calls without a session selector
        # ("Error: Pass --to <E.164>, --session-id, or --agent ..."). When
        # neither was supplied, synthesize a benchmark-scoped session id from
        # the recorded (benchmark, task_id) pair so each turn is reproducible
        # but never collides with a real-user session. Tests can still pin a
        # deterministic value via context["session_id"].
        if session_id is None and agent_id is None:
            seed = f"{self._benchmark or 'bench'}:{self._task_id or 'turn'}"
            session_id = f"bench-{hashlib.sha1(seed.encode('utf-8')).hexdigest()[:12]}"
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
        env: dict[str, str] = {**os.environ}
        api_key = self.api_key or env.get(self.api_key_env, "")
        if api_key:
            env[self.api_key_env] = api_key
            env["OPENAI_API_KEY"] = api_key
        base_url = self.base_url or env.get(self.base_url_env, "")
        if base_url:
            env.setdefault("OPENAI_BASE_URL", base_url)
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
            "messages": _messages_from_context(text, ctx),
        }
        if ctx:
            tools = ctx.get("tools")
            if isinstance(tools, list) and tools:
                body["tools"] = tools
                tool_choice = ctx.get("tool_choice")
                if isinstance(tool_choice, str) and tool_choice in _ALLOWED_TOOL_CHOICES:
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
                retry_after_raw = exc.headers.get("Retry-After") if exc.headers else None
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
      3. ``~/.eliza/agents/openclaw/v2026.5.7/node_modules/.bin/openclaw`` fallback.
    """
    override = os.environ.get("OPENCLAW_BIN", "").strip()
    if override:
        return Path(override).expanduser()
    try:
        if DEFAULT_MANIFEST_PATH.exists():
            with DEFAULT_MANIFEST_PATH.open("r", encoding="utf-8") as fh:
                manifest = json.load(fh)
            binary = manifest.get("binary_path") if isinstance(manifest, dict) else None
            if isinstance(binary, str) and binary:
                return Path(binary).expanduser()
    except (OSError, json.JSONDecodeError):
        pass
    return DEFAULT_BINARY_FALLBACK


_VERSION_RE = re.compile(r"OpenClaw\s+(\S+)(?:\s+\(([^)]+)\))?")


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
            "openclaw CLI produced no stdout.\n"
            f"stderr:\n{stderr[-4000:]}"
        )
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
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


def _response_from_payload(
    payload: Mapping[str, object],
    *,
    allow_text_tool_calls: bool = False,
) -> MessageResponse:
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
            text = _first_str(meta, ("finalAssistantVisibleText", "finalAssistantRawText"))
    raw_tool_calls = _collect_tool_calls(payload)
    if text and allow_text_tool_calls:
        visible_text, embedded_tool_calls = parse_openclaw_tool_calls(text)
        if embedded_tool_calls:
            text = visible_text
            raw_tool_calls.extend(embedded_tool_calls)

    actions: list[str] = []
    params: dict[str, object] = {}
    for entry in raw_tool_calls:
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            continue
        actions.append(name)
        args = entry.get("arguments")
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                pass
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
        counts_text_embedded_tool_calls=allow_text_tool_calls,
    )
    return response


def _response_from_openai_completion(
    payload: Mapping[str, object],
    *,
    allow_text_tool_calls: bool = False,
) -> MessageResponse:
    """Map an OpenAI-compatible chat completion to :class:`MessageResponse`."""
    choices = payload.get("choices")
    choice: object = (
        choices[0]
        if isinstance(choices, Sequence) and not isinstance(choices, (str, bytes)) and choices
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
    return _response_from_payload(
        normalized,
        allow_text_tool_calls=allow_text_tool_calls,
    )


def _annotate_response(
    response: MessageResponse,
    *,
    transport: str,
    path_label: str,
    preserves_full_messages: bool,
    passes_benchmark_tools: bool,
    counts_text_embedded_tool_calls: bool,
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
    meta["openclaw_adapter"] = {
        "transport": transport,
        "path_label": path_label,
        "native_openai_tool_calls": transport == "direct_openai_compatible",
        "preserves_full_messages": preserves_full_messages,
        "passes_benchmark_tools": passes_benchmark_tools,
        "counts_text_embedded_tool_calls": counts_text_embedded_tool_calls,
    }


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
    input_tokens = (
        usage.get("prompt_tokens")
        or usage.get("input_tokens")
        or usage.get("input")
        or usage.get("promptTokens")
        or 0
    )
    output_tokens = (
        usage.get("completion_tokens")
        or usage.get("output_tokens")
        or usage.get("output")
        or usage.get("completionTokens")
        or 0
    )
    total = usage.get("total_tokens") or usage.get("total") or usage.get("totalTokens") or 0
    details = usage.get("prompt_tokens_details")
    details_map = details if isinstance(details, Mapping) else {}
    cache_read = (
        usage.get("cache_read_input_tokens")
        or usage.get("cached_tokens")
        or usage.get("cacheRead")
        or details_map.get("cached_tokens")
        or details_map.get("cache_read_input_tokens")
        or 0
    )
    cache_write = (
        usage.get("cache_creation_input_tokens")
        or usage.get("cache_write_tokens")
        or usage.get("cacheWrite")
        or details_map.get("cache_creation_input_tokens")
        or details_map.get("cache_write_tokens")
        or 0
    )
    if not any((input_tokens, output_tokens, total, cache_read, cache_write)):
        return {}
    return {
        "prompt_tokens": input_tokens,
        "completion_tokens": output_tokens,
        "total_tokens": total,
        "prompt_tokens_details": {
            "cached_tokens": cache_read,
            "cache_write_tokens": cache_write,
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
    if isinstance(args_obj, str):
        try:
            args_obj = json.loads(args_obj)
        except json.JSONDecodeError:
            pass
    call_id = raw.get("id")
    return {
        "id": str(call_id) if isinstance(call_id, (str, int)) else f"call_{fallback_index}",
        "name": name_obj,
        "arguments": args_obj if args_obj is not None else {},
    }


def _brace_balanced_json_slice(text: str, start: int) -> str | None:
    """Extract a top-level JSON object starting at ``text[start] == '{'``.

    Walks forward respecting string boundaries and ``\\`` escapes inside
    strings. Returns the substring ``text[start : end+1]`` once the brace
    depth returns to zero, or ``None`` if the object never closes.
    """
    if start >= len(text) or text[start] != "{":
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def _tool_call_dict_from_raw(
    raw: str, index: int
) -> dict[str, object] | None:
    """Parse a JSON-encoded tool_call body into the normalized dict shape.

    Returns ``None`` on JSON failure or when the payload lacks a string
    ``tool``/``name`` field.
    """
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.debug("dropping malformed OpenClaw tool_call payload: %r", raw)
        return None
    name = data.get("tool") or data.get("name")
    if not isinstance(name, str) or not name:
        return None
    args = data.get("args", data.get("arguments", {}))
    return {
        "id": str(data.get("id") or f"call_openclaw_{index}"),
        "name": name,
        "arguments": args if args is not None else {},
    }


def parse_openclaw_tool_calls(text: str) -> tuple[str, list[dict[str, object]]]:
    """Parse ``<tool_call>{...}</tool_call>`` blocks out of ``text``.

    Two passes:

    1. Well-formed blocks bounded by ``<tool_call>...</tool_call>``.
    2. If pass 1 found nothing and the text contains an opener, run a
       brace-balanced fallback over each ``<tool_call>{`` occurrence to
       recover unclosed blocks (the model sometimes emits an opening tag
       and a JSON body followed by trailing prose, never closing the tag).
    """
    if "<tool_call>" not in text:
        return text, []
    tool_calls: list[dict[str, object]] = []
    for index, raw in enumerate(_TOOL_CALL_RE.findall(text)):
        normalized = _tool_call_dict_from_raw(raw.strip(), index)
        if normalized is not None:
            tool_calls.append(normalized)

    if not tool_calls:
        for match in _TOOL_CALL_OPENER_RE.finditer(text):
            json_start = match.start(1)
            sliced = _brace_balanced_json_slice(text, json_start)
            if sliced is None:
                continue
            normalized = _tool_call_dict_from_raw(sliced, len(tool_calls))
            if normalized is not None:
                tool_calls.append(normalized)

    return text[: text.find("<tool_call>")].strip(), tool_calls


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
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except json.JSONDecodeError:
            pass
    return {
        "id": str(raw.get("id") or ""),
        "name": name,
        "arguments": args,
    }


def _messages_from_context(text: str, ctx: Mapping[str, object]) -> list[dict[str, object]]:
    raw_messages = ctx.get("messages")
    messages: list[dict[str, object]] = []
    if isinstance(raw_messages, Sequence) and not isinstance(raw_messages, (str, bytes)):
        for item in raw_messages:
            if not isinstance(item, Mapping):
                continue
            message = _openai_message_from_raw(item)
            if message is not None:
                messages.append(message)
    if not messages:
        sys_prompt = ctx.get("system_prompt")
        if isinstance(sys_prompt, str) and sys_prompt.strip():
            messages.append({"role": "system", "content": sys_prompt.strip()})
        messages.append({"role": "user", "content": text})
    return messages


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


def _cli_prompt_text(text: str, context: Mapping[str, object] | None) -> str:
    """Flatten benchmark chat/tool context for the OpenClaw CLI message flag."""
    if not context:
        return text
    parts: list[str] = []
    tools = context.get("tools")
    if isinstance(tools, list) and tools:
        parts.append(_openclaw_system_prompt(tools))
    context_prompt = context_to_prompt(context)
    if context_prompt:
        parts.append(f"Benchmark context:\n{context_prompt}")
    messages = _messages_from_context(text, context)
    for message in messages:
        role = message.get("role", "user")
        content = message.get("content", "")
        parts.append(f"{role}: {content}")
    return "\n\n".join(part for part in parts if part.strip()) or text


def _openclaw_system_prompt(tools: list[object] | None) -> str:
    prompt = (
        "You are operating through the OpenClaw benchmark harness. "
        "Use concise reasoning. This CLI transport can only pass a flattened "
        "message, so benchmark-provided tools below are context only and are "
        "not counted as native OpenAI tool_calls. Answer normally unless the "
        "native direct transport is explicitly enabled."
    )
    if tools:
        prompt += "\nAvailable tools:\n" + json.dumps(tools, ensure_ascii=True)
    return prompt


def _default_api_key(provider: str, api_key_env: str) -> str:
    provider = provider.strip().lower()
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


__all__ = ["MessageResponse", "OpenClawClient", "parse_openclaw_tool_calls"]
