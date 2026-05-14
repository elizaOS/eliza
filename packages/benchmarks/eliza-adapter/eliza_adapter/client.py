"""HTTP client for the eliza benchmark server."""

from __future__ import annotations

import json
import logging
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib.parse import urlencode, urlparse

logger = logging.getLogger(__name__)


@dataclass
class MessageResponse:
    """Parsed response from the eliza benchmark server."""

    text: str
    thought: str | None
    actions: list[str]
    params: dict[str, object]
    metadata: dict[str, object] = field(default_factory=dict)


_SECRET_RE = re.compile(
    r"(?i)\b((?:sk|csk)-[a-z0-9_-]{12,}|password\s*[:=]\s*[^\s,;]+|api[_ -]?key\s*[:=]\s*[^\s,;]+)"
)


def _redact(value: object) -> object:
    if isinstance(value, str):
        return _SECRET_RE.sub("[REDACTED]", value)
    if isinstance(value, Mapping):
        return {str(k): _redact(v) for k, v in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_redact(v) for v in value]
    return value


def _prompt_text(text: str, context: Mapping[str, object] | None) -> str:
    if not context:
        return text
    parts: list[str] = []
    system_prompt = context.get("system_prompt")
    if isinstance(system_prompt, str) and system_prompt.strip():
        parts.append(system_prompt.strip())
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


_TELEMETRY_TURN_COUNTER = 0
_TELEMETRY_FALLBACK_PATH: str | None = None


def _resolve_telemetry_path() -> str | None:
    """Resolve the per-turn telemetry JSONL path.

    Precedence:
      1. ``BENCHMARK_TELEMETRY_JSONL`` — explicit override (legacy callers).
      2. ``BENCHMARK_RUN_DIR`` — orchestrator-supplied run dir; we append
         ``telemetry.jsonl``.
      3. Process-local fallback via ``tempfile.mkdtemp`` so out-of-orchestrator
         smoke tests still produce a record on disk instead of dropping data.
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
            Path(tempfile.mkdtemp(prefix="eliza-adapter-telemetry-")) / "telemetry.jsonl"
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
            if isinstance(value, (int, float)):
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


def _context_tool_schemas(context: Mapping[str, object] | None) -> list[dict[str, object]]:
    if not isinstance(context, Mapping):
        return []
    tools = context.get("tools")
    if not isinstance(tools, Sequence) or isinstance(tools, (str, bytes)):
        return []
    return [dict(tool) for tool in tools if isinstance(tool, Mapping)]


def _tool_name(tool: Mapping[str, object]) -> str:
    function = tool.get("function")
    if isinstance(function, Mapping):
        raw = function.get("name")
        if isinstance(raw, str):
            return raw
    raw = tool.get("name")
    return raw if isinstance(raw, str) else ""


def _metadata_from_response(response: MessageResponse | None) -> dict[str, object]:
    if response is None:
        return {}
    metadata = dict(response.metadata)
    params_metadata = response.params.get("eliza_metadata")
    if isinstance(params_metadata, Mapping):
        metadata.update(dict(params_metadata))
    return metadata


def _capture_trajectory_enabled() -> bool:
    raw = os.environ.get("ELIZA_ADAPTER_CAPTURE_TRAJECTORY")
    if raw is not None:
        return raw.strip().lower() not in {"0", "false", "no", "off"}
    return bool(
        os.environ.get("BENCHMARK_RUN_DIR", "").strip()
        or os.environ.get("BENCHMARK_TELEMETRY_JSONL", "").strip()
    )


def _query(values: Mapping[str, str | None]) -> str:
    compact = {key: value for key, value in values.items() if value}
    return f"?{urlencode(compact)}" if compact else ""


def _tool_calls_from_captured_actions(raw: object) -> list[dict[str, object]]:
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        return []
    calls: list[dict[str, object]] = []
    for item in raw:
        if not isinstance(item, Mapping):
            continue
        params = item.get("params")
        if not isinstance(params, Mapping):
            params = {}
        name = (
            item.get("toolName")
            or item.get("tool_name")
            or params.get("tool_name")
            or item.get("command")
            or params.get("command")
            or item.get("operation")
            or params.get("operation")
        )
        if not isinstance(name, str) or not name.strip():
            continue
        arguments = item.get("arguments")
        if not isinstance(arguments, Mapping):
            arguments = params.get("arguments")
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except json.JSONDecodeError:
                arguments = {"_raw": arguments}
        if not isinstance(arguments, Mapping):
            arguments = {
                str(key): value
                for key, value in params.items()
                if key not in {"tool_name", "command", "operation"}
            }
        calls.append(
            {
                "id": str(item.get("id") or f"call_benchmark_{len(calls)}"),
                "type": "function",
                "function": {
                    "name": name.strip(),
                    "arguments": json.dumps(_jsonable(arguments), ensure_ascii=False),
                },
            }
        )
    return calls


def _write_telemetry(
    *,
    text: str,
    context: Mapping[str, object] | None,
    latency_ms: float,
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
    prompt = _prompt_text(text, context)
    tool_schemas = _context_tool_schemas(context)
    metadata = _metadata_from_response(response)
    tool_calls = []
    if response is not None:
        raw_tool_calls = response.params.get("tool_calls")
        if isinstance(raw_tool_calls, Sequence) and not isinstance(raw_tool_calls, (str, bytes)):
            tool_calls = [dict(call) for call in raw_tool_calls if isinstance(call, Mapping)]
    trajectory_snapshot = (
        response.params.get("_eliza_trajectory_snapshot") if response is not None else None
    )
    trajectory_snapshot_error = (
        response.params.get("_eliza_trajectory_snapshot_error")
        if response is not None
        else None
    )
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
        "harness": "eliza",
        "provider": os.environ.get("BENCHMARK_MODEL_PROVIDER", ""),
        "model": os.environ.get("BENCHMARK_MODEL_NAME", ""),
        "benchmark": context.get("benchmark") if isinstance(context, Mapping) else None,
        "task_id": context.get("task_id") if isinstance(context, Mapping) else None,
        "session_id": context.get("session_id") if isinstance(context, Mapping) else None,
        "turn_index": turn_index,
        "agent_label": metadata.get("agent_label", "eliza"),
        "prompt_text": _redact(prompt),
        "prompt_chars": len(prompt),
        "latency_ms": latency_ms,
        "usage": _jsonable(_redact(usage)),
        "prompt_tokens": tokens["prompt_tokens"],
        "completion_tokens": tokens["completion_tokens"],
        "total_tokens": tokens["total_tokens"],
        "cache_read_input_tokens": tokens["cache_read_input_tokens"],
        "cache_creation_input_tokens": tokens["cache_creation_input_tokens"],
        "tool_schema_count": len(tool_schemas),
        "tool_names": [_tool_name(tool) for tool in tool_schemas if _tool_name(tool)],
        "tools": _jsonable(_redact(tool_schemas)),
        "tool_calls": _jsonable(_redact(tool_calls)),
        "tool_call_count": len(tool_calls),
        "actions": list(response.actions) if response is not None else [],
        "response_text": _redact(response.text if response is not None else ""),
        "metadata": _jsonable(_redact(metadata)),
        "trajectory_snapshot": _jsonable(_redact(trajectory_snapshot))
        if trajectory_snapshot is not None
        else None,
        "trajectory_snapshot_error": _redact(trajectory_snapshot_error)
        if trajectory_snapshot_error
        else None,
        "trajectory_step": metadata.get("trajectory_step"),
        "trajectory_endpoint": metadata.get("trajectory_endpoint"),
        "diagnostics_endpoint": metadata.get("diagnostics_endpoint"),
        "native_trajectory_step_id": metadata.get("native_trajectory_step_id"),
        "compaction_strategy": metadata.get("compaction_strategy"),
        "compaction_threshold_tokens": metadata.get("compaction_threshold_tokens"),
        "error_if_any": _redact(error) if error else None,
    }
    try:
        path = Path(telemetry_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=True, sort_keys=True) + "\n")
    except OSError as exc:
        logger.debug("failed to write eliza telemetry: %s", exc)


class ElizaClient:
    """HTTP client for the eliza benchmark server.

    All communication uses stdlib ``urllib`` so there are no extra
    dependencies to install.
    """

    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
    ) -> None:
        self._delegate = _build_delegate_client()
        resolved_url = (
            base_url
            or os.environ.get("ELIZA_BENCH_URL")
            or "http://localhost:3939"
        )
        self.base_url = resolved_url.rstrip("/")
        if token is None:
            env_token = os.environ.get("ELIZA_BENCH_TOKEN", "").strip()
            token = env_token or None
        self._token = token

    def set_token(self, token: str | None) -> None:
        """Set or clear the bearer token used for authenticated endpoints."""
        self._token = token

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def health(self) -> dict[str, object]:
        """GET /api/benchmark/health — check if the server is up."""
        if self._delegate is not None:
            return self._delegate.health()
        return self._get("/api/benchmark/health")

    def reset(
        self,
        task_id: str,
        benchmark: str,
        *,
        world_snapshot_path: str | None = None,
        now_iso: str | None = None,
    ) -> dict[str, object]:
        """Start a fresh session for a task.

        For most benchmarks this hits ``POST /api/benchmark/reset``. When
        ``benchmark == "lifeops_bench"`` and a world snapshot path is given,
        the call routes to the lifeops_bench-specific reset route which
        loads the LifeWorld JSON into an in-process fake backend keyed by
        ``task_id``.
        """
        if self._delegate is not None:
            return self._delegate.reset(
                task_id=task_id,
                benchmark=benchmark,
                world_snapshot_path=world_snapshot_path,
                now_iso=now_iso,
            )
        if benchmark == "lifeops_bench" and world_snapshot_path is not None:
            payload: dict[str, object] = {
                "task_id": task_id,
                "world_snapshot_path": world_snapshot_path,
            }
            if now_iso is not None:
                payload["now_iso"] = now_iso
            return self._post("/api/benchmark/lifeops_bench/reset", payload)
        return self._post(
            "/api/benchmark/reset",
            {"task_id": task_id, "benchmark": benchmark},
        )

    def lifeops_message(
        self,
        task_id: str,
        text: str,
        *,
        tools: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        """POST /api/benchmark/lifeops_bench/message — runs the planner and
        executes any captured tool calls against the in-memory fake backend.

        Returns the raw JSON body — callers are expected to map it into a
        ``MessageTurn`` (see ``eliza_adapter.lifeops_bench``).
        """
        if self._delegate is not None:
            response = self._delegate.send_message(
                text,
                context={"benchmark": "lifeops_bench", "task_id": task_id, "tools": tools or []},
            )
            return {
                "text": response.text,
                "thought": response.thought,
                "actions": response.actions,
                "tool_calls": response.params.get("tool_calls", []),
                "usage": response.params.get("usage", {}),
            }
        body: dict[str, object] = {"task_id": task_id, "text": text}
        if tools:
            body["context"] = {"tools": tools}
        return self._post("/api/benchmark/lifeops_bench/message", body)

    def lifeops_world_state(self, task_id: str) -> dict[str, object]:
        """GET /api/benchmark/lifeops_bench/{task_id}/world_state — returns
        the LifeWorld JSON snapshot for state-hash scoring."""
        if self._delegate is not None:
            return {"task_id": task_id, "status": "unavailable", "world": None}
        return self._get(f"/api/benchmark/lifeops_bench/{task_id}/world_state")

    def lifeops_teardown(self, task_id: str) -> dict[str, object]:
        """POST /api/benchmark/lifeops_bench/teardown — frees the per-task
        fake backend on the server."""
        if self._delegate is not None:
            return {"task_id": task_id, "status": "ok"}
        return self._post(
            "/api/benchmark/lifeops_bench/teardown",
            {"task_id": task_id},
        )

    def trajectory(
        self,
        *,
        benchmark: str | None = None,
        task_id: str | None = None,
    ) -> dict[str, object]:
        """GET /api/benchmark/trajectory for the active or named session."""
        if self._delegate is not None:
            return {"status": "unavailable", "steps": [], "outbox": []}
        query = _query({"benchmark": benchmark, "task_id": task_id})
        return self._get(f"/api/benchmark/trajectory{query}")

    def diagnostics(
        self,
        *,
        benchmark: str | None = None,
        task_id: str | None = None,
    ) -> dict[str, object]:
        """GET /api/benchmark/diagnostics for compaction/memory metadata."""
        if self._delegate is not None:
            return {"status": "unavailable", "diagnostics": None}
        query = _query({"benchmark": benchmark, "task_id": task_id})
        return self._get(f"/api/benchmark/diagnostics{query}")

    def send_message(
        self,
        text: str,
        context: Mapping[str, object] | None = None,
    ) -> MessageResponse:
        """POST /api/benchmark/message — send a message and get response."""
        if self._delegate is not None:
            return self._delegate.send_message(text, context)
        body: dict[str, object] = {"text": text}
        if context is not None:
            body["context"] = dict(context)

        started = time.monotonic()
        try:
            raw = self._post("/api/benchmark/message", body)
        except Exception as exc:
            _write_telemetry(
                text=text,
                context=context,
                latency_ms=(time.monotonic() - started) * 1000.0,
                error=f"{type(exc).__name__}: {exc}",
            )
            raise
        raw_params = raw.get("params", {})
        params = dict(raw_params) if isinstance(raw_params, Mapping) else {}
        for key in ("usage", "tool_calls", "metadata"):
            value = raw.get(key)
            if value is not None and key not in params:
                params[key if key != "metadata" else "eliza_metadata"] = value
        captured_actions = raw.get("captured_actions")
        if isinstance(captured_actions, list) and "BENCHMARK_ACTIONS" not in params:
            normalized_actions: list[object] = []
            for action in captured_actions:
                if not isinstance(action, dict):
                    continue
                action_params = action.get("params")
                if isinstance(action_params, dict):
                    normalized_actions.append(action_params)
            if normalized_actions:
                params["BENCHMARK_ACTIONS"] = normalized_actions
        if "tool_calls" not in params:
            normalized_tool_calls = _tool_calls_from_captured_actions(captured_actions)
            if normalized_tool_calls:
                params["tool_calls"] = normalized_tool_calls
        metadata = raw.get("metadata")
        if not isinstance(metadata, Mapping):
            maybe = params.get("eliza_metadata")
            metadata = maybe if isinstance(maybe, Mapping) else {}
        raw_actions = raw.get("actions", [])
        actions = (
            [str(action) for action in raw_actions if isinstance(action, str)]
            if isinstance(raw_actions, Sequence)
            and not isinstance(raw_actions, (str, bytes))
            else []
        )
        response = MessageResponse(
            text=str(raw.get("text", "")),
            thought=raw.get("thought") if isinstance(raw.get("thought"), str) else None,
            actions=actions,
            params=params,
            metadata=dict(metadata),
        )
        if _capture_trajectory_enabled():
            try:
                response.params["_eliza_trajectory_snapshot"] = self.trajectory(
                    benchmark=str(
                        (context or {}).get("benchmark")
                        or metadata.get("benchmark")
                        or ""
                    )
                    or None,
                    task_id=str(
                        (context or {}).get("task_id")
                        or (context or {}).get("taskId")
                        or metadata.get("task_id")
                        or metadata.get("taskId")
                        or ""
                    )
                    or None,
                )
            except Exception as exc:
                response.params["_eliza_trajectory_snapshot_error"] = (
                    f"{type(exc).__name__}: {exc}"
                )
        _write_telemetry(
            text=text,
            context=context,
            latency_ms=(time.monotonic() - started) * 1000.0,
            response=response,
        )
        return response

    def is_ready(self) -> bool:
        if self._delegate is not None:
            return bool(self._delegate.is_ready())
        import socket

        parsed = urlparse(self.base_url)
        host = parsed.hostname or "localhost"
        if parsed.port is not None:
            port = parsed.port
        elif parsed.scheme == "https":
            port = 443
        else:
            port = 80

        try:
            with socket.create_connection((host, port), timeout=1):
                return True
        except Exception:
            return False

    def wait_until_ready(self, timeout: float = 120.0, poll: float = 1.0) -> None:
        """Block until the benchmark server is healthy or *timeout* elapses."""
        if self._delegate is not None:
            return self._delegate.wait_until_ready(timeout=timeout, poll=poll)
        deadline = time.monotonic() + timeout
        last_err: str = ""
        progress = os.environ.get("ELIZA_BENCH_WAIT_PROGRESS", "").strip() == "1"
        next_progress = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            try:
                # First, check if the socket is open
                if not self.is_ready():
                    last_err = "Socket connection refused or timed out"
                    if progress and time.monotonic() >= next_progress:
                        print(f"DEBUG: Waiting for {self.base_url} ({last_err})", flush=True)
                        next_progress = time.monotonic() + 5.0
                    time.sleep(poll)
                    continue

                # Then, check the health endpoint
                resp = self.health()
                if resp.get("status") == "ready":
                    logger.info("Eliza benchmark server is ready")
                    return
                last_err = f"Server health status not 'ready': {resp}"
            except Exception as exc:
                last_err = str(exc)
            if progress and time.monotonic() >= next_progress:
                print(f"DEBUG: Waiting for {self.base_url} ({last_err})", flush=True)
                next_progress = time.monotonic() + 5.0
            time.sleep(poll)
        raise TimeoutError(
            f"Eliza benchmark server not ready after {timeout}s: {last_err}"
        )

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _auth_headers(self) -> dict[str, str]:
        if self._token:
            return {"Authorization": f"Bearer {self._token}"}
        return {}

    def _get(self, path: str) -> dict[str, object]:
        url = f"{self.base_url}{path}"
        req = urllib.request.Request(url, method="GET", headers=self._auth_headers())
        return self._do(req)

    def _post(self, path: str, body: dict[str, object]) -> dict[str, object]:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json", **self._auth_headers()}
        req = urllib.request.Request(
            url,
            data=data,
            method="POST",
            headers=headers,
        )
        return self._do(req)

    @staticmethod
    def _do(req: urllib.request.Request) -> dict[str, object]:
        # Long ceiling: vending-bench day 1 with a fresh runtime (full plugin
        # init + first slow LLM call) regularly takes >5 min. Override via
        # ELIZA_BENCH_HTTP_TIMEOUT env var if the operator wants a tighter cap.
        try:
            timeout_s = float(os.environ.get("ELIZA_BENCH_HTTP_TIMEOUT", "1800"))
        except ValueError:
            timeout_s = 1800.0
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw)  # type: ignore[no-any-return]
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"HTTP {exc.code} from eliza benchmark server: {body}"
            ) from exc


def _build_delegate_client():
    """Return the selected non-Eliza harness client, if any.

    The orchestrator sets ``BENCHMARK_HARNESS`` / ``ELIZA_BENCH_HARNESS`` for
    every run. Existing benchmarks that already call ``ElizaClient`` therefore
    get Hermes/OpenClaw apples-to-apples transport without changing their
    scenario loops, context shaping, or tool inventories.
    """

    harness = (
        os.environ.get("ELIZA_BENCH_HARNESS")
        or os.environ.get("BENCHMARK_HARNESS")
        or ""
    ).strip().lower()
    provider = (os.environ.get("BENCHMARK_MODEL_PROVIDER") or "cerebras").strip().lower()
    model = (
        os.environ.get("BENCHMARK_MODEL_NAME")
        or os.environ.get("MODEL_NAME")
        or os.environ.get("CEREBRAS_MODEL")
        or "gpt-oss-120b"
    ).strip()
    base_url = (
        os.environ.get("BENCHMARK_BASE_URL")
        or os.environ.get("OPENAI_BASE_URL")
        or os.environ.get("CEREBRAS_BASE_URL")
        or None
    )
    temperature = _optional_float_from_env("BENCHMARK_TEMPERATURE", "TEMPERATURE")
    max_tokens = _optional_int_from_env("BENCHMARK_MAX_TOKENS", "MAX_TOKENS")
    reasoning_effort = (
        os.environ.get("BENCHMARK_REASONING_EFFORT")
        or os.environ.get("CEREBRAS_REASONING_EFFORT")
        or None
    )
    if harness == "hermes":
        from hermes_adapter.client import HermesClient  # noqa: WPS433

        timeout_s = float(os.environ.get("HERMES_TIMEOUT_S", "1200"))
        return HermesClient(
            provider=provider,
            model=model,
            base_url=base_url,
            timeout_s=timeout_s,
            temperature=temperature,
            reasoning_effort=reasoning_effort.strip() if isinstance(reasoning_effort, str) else None,
            max_tokens=max_tokens,
        )
    if harness == "openclaw":
        from openclaw_adapter.client import OpenClawClient  # noqa: WPS433

        timeout_s = float(os.environ.get("OPENCLAW_TIMEOUT_S", "600"))
        thinking_level = (
            os.environ.get("OPENCLAW_THINKING_LEVEL")
            or (reasoning_effort.strip() if isinstance(reasoning_effort, str) else "")
            or "medium"
        )
        return OpenClawClient(
            provider=provider,
            model=model,
            base_url=base_url,
            timeout_s=timeout_s,
            thinking_level=thinking_level,
            temperature=temperature,
            reasoning_effort=reasoning_effort.strip() if isinstance(reasoning_effort, str) else None,
            max_tokens=max_tokens,
        )
    return None


def _optional_float_from_env(*names: str) -> float | None:
    for name in names:
        raw = os.environ.get(name)
        if raw is None or not raw.strip():
            continue
        try:
            return float(raw)
        except ValueError:
            continue
    return None


def _optional_int_from_env(*names: str) -> int | None:
    for name in names:
        raw = os.environ.get(name)
        if raw is None or not raw.strip():
            continue
        try:
            return int(raw)
        except ValueError:
            continue
    return None
