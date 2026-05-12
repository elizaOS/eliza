"""In-process / subprocess client to hermes-agent's HermesAgentLoop.

Drop-in equivalent of ``eliza_adapter.client.ElizaClient`` for hermes-agent.

The default mode is ``subprocess`` — a one-shot Python script is spawned inside
the hermes-agent venv (which has ``openai``, ``hermes-agent``, etc. installed)
and emits the response as JSON on stdout. The orchestrator process does not
need to import any of hermes-agent's heavy dependencies.

``in_process`` mode is supported but only works when the orchestrator's own
Python interpreter has hermes-agent (and its deps) importable on ``sys.path``.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence

from ._retry import (
    MAX_ATTEMPTS,
    RetryExhaustedError,
    backoff_seconds,
    is_retryable_status,
    parse_retry_after,
)
from benchmarks.lib.base_benchmark_client import (
    CEREBRAS_GPT_OSS_120B_PRICING,
    BaseBenchmarkClient,
    ModelPricing,
)

logger = logging.getLogger(__name__)


# Default concurrency for Hermes. W2-9 observed Cerebras 429s at concurrency=4
# on the hermes suite; lowering to 2 cut the 429 rate to near zero without a
# material throughput hit. Callers can override via the constructor.
_HERMES_DEFAULT_CONCURRENCY = 2


def _hermes_pricing(provider: str, model: str) -> ModelPricing | None:
    if provider.strip().lower() == "cerebras" and model.strip().lower() == "gpt-oss-120b":
        return CEREBRAS_GPT_OSS_120B_PRICING
    return None


def _retry_after_from_openai_exception(exc: object) -> float | None:
    """Pull a ``Retry-After`` header from an openai-SDK exception, if present."""
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if headers is None:
        return None
    try:
        raw = headers.get("retry-after") or headers.get("Retry-After")
    except AttributeError:
        return None
    return parse_retry_after(raw if isinstance(raw, str) else None)


DEFAULT_REPO_PATH = Path.home() / ".eliza" / "agents" / "hermes-agent-src"
DEFAULT_VENV_PYTHON = DEFAULT_REPO_PATH / ".venv" / "bin" / "python"


@dataclass
class MessageResponse:
    """Parsed response from a single hermes-agent turn."""

    text: str
    thought: str | None
    actions: list[str]
    params: dict[str, object]


class HermesClient(BaseBenchmarkClient[MessageResponse]):
    """Client for one-shot turns against hermes-agent.

    ``mode='subprocess'`` (default): spawn a one-shot Python script using the
    venv interpreter. The script imports ``HermesAgentLoop`` (or, for the
    minimal smoke path, the raw OpenAI client) and emits a single JSON line.

    ``mode='in_process'``: import hermes-agent in the current process. Only
    works if the parent Python already has hermes-agent installed.

    Inherits :class:`BaseBenchmarkClient` for shared concurrency / cost /
    telemetry handling. ``concurrency`` defaults to 2 — W2-9 observed
    Cerebras 429s at 4 on the hermes suite; the lower cap eliminates them
    without a material throughput hit.
    """

    def __init__(
        self,
        *,
        repo_path: Path | None = None,
        venv_python: Path | None = None,
        provider: str = "cerebras",
        model: str = "gpt-oss-120b",
        api_key: str | None = None,
        base_url: str | None = None,
        mode: str = "subprocess",
        timeout_s: float = 1200.0,
        concurrency: int = _HERMES_DEFAULT_CONCURRENCY,
    ) -> None:
        if mode not in {"subprocess", "in_process"}:
            raise ValueError(f"Unknown mode {mode!r}; expected 'subprocess' or 'in_process'")

        super().__init__(
            concurrency=concurrency,
            pricing=_hermes_pricing(provider, model),
            model=model,
            provider=provider,
        )

        self.repo_path = Path(repo_path) if repo_path else DEFAULT_REPO_PATH
        if venv_python is not None:
            self.venv_python = Path(venv_python)
        else:
            self.venv_python = self.repo_path / ".venv" / "bin" / "python"

        self.api_key = api_key if api_key is not None else os.environ.get("CEREBRAS_API_KEY", "")
        self.base_url = (
            base_url
            if base_url is not None
            else os.environ.get("CEREBRAS_BASE_URL", "https://api.cerebras.ai/v1")
        )
        self.mode = mode
        self.timeout_s = float(timeout_s)

        # send_message records (task_id, benchmark) from reset() — purely
        # informational so callers can correlate logs.
        self._task_id: str | None = None
        self._benchmark: str | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def health(self) -> dict[str, object]:
        """Confirm the venv can execute the one-shot OpenAI-compatible path."""
        if self.mode == "in_process":
            try:
                import openai  # noqa: F401 — readiness probe
            except ImportError as exc:
                return {"status": "error", "error": f"openai not importable in parent: {exc}"}
            return {"status": "ready", "stdout": "in_process"}
        if not self.venv_python.exists():
            return {"status": "error", "error": f"venv python not found at {self.venv_python}"}
        try:
            result = self._run_python_subprocess(
                ["-c", "import openai; print('ok')"],
                timeout_s=30.0,
                cwd=str(self.repo_path),
            )
        except subprocess.TimeoutExpired as exc:
            return {"status": "error", "error": f"health probe timed out: {exc}"}
        if result.returncode != 0:
            return {
                "status": "error",
                "error": f"health probe exited {result.returncode}",
                "stderr": (result.stderr or "")[-2000:],
            }
        return {"status": "ready", "stdout": (result.stdout or "").strip()}

    def is_ready(self) -> bool:
        """Cheap synchronous readiness check."""
        return self.health().get("status") == "ready"

    def wait_until_ready(self, timeout: float = 60.0, poll: float = 1.0) -> None:
        """Block until ``health()`` reports ready or ``timeout`` elapses."""
        deadline = time.monotonic() + float(timeout)
        last_err: object = "no probe attempted"
        while time.monotonic() < deadline:
            probe = self.health()
            if probe.get("status") == "ready":
                if self.mode == "in_process":
                    logger.info("hermes-agent in_process bridge ready (model=%s)", self.model)
                else:
                    logger.info("hermes-agent venv is ready (%s)", self.venv_python)
                return
            last_err = probe.get("error") or probe
            time.sleep(poll)
        raise TimeoutError(
            f"hermes-agent venv not ready after {timeout}s: {last_err}"
        )

    def reset(
        self,
        task_id: str,
        benchmark: str,
        **kwargs: object,
    ) -> dict[str, object]:
        """Record (task_id, benchmark) for the next send_message call.

        Stateless w.r.t. the agent loop — each ``send_message`` spawns its own
        fresh loop. Extra ``**kwargs`` are accepted for API parity but currently
        unused.
        """
        del kwargs  # accepted for parity, unused
        self._task_id = task_id
        self._benchmark = benchmark
        return {"task_id": task_id, "benchmark": benchmark, "status": "ready"}

    def send_message(
        self,
        text: str,
        context: Mapping[str, object] | None = None,
    ) -> MessageResponse:
        """Run one turn of hermes-agent.

        In ``subprocess`` mode (default) this spawns a one-shot Python script
        inside the hermes-agent venv. The script:

          1. Reads a JSON payload off stdin: ``{"text", "context", "model",
             "base_url", "api_key", "system_prompt", "tools"}``.
          2. Constructs an ``openai.AsyncOpenAI`` client pointed at the
             OpenAI-compatible endpoint.
          3. Calls ``chat.completions.create()`` once (or, if hermes-agent is
             importable in the venv, drives ``HermesAgentLoop`` for one turn).
          4. Emits a single JSON line on stdout in the shape
             ``{"text", "thought", "actions", "params"}``.

        Captures per-turn telemetry (latency_ms, prompt/completion tokens,
        cost_usd) via the base class. Cerebras's OpenAI-compatible response
        carries ``usage`` which we surface in ``params["usage"]`` on both
        transports — this method reads it back into telemetry.
        """
        started = time.time()
        try:
            result = self._send(text, context)
        finally:
            finished = time.time()
        usage_obj = result.params.get("usage") if result.params else None
        usage_map: Mapping[str, object] | None = (
            usage_obj if isinstance(usage_obj, Mapping) else None
        )
        self.record_telemetry(
            started_at_epoch=started,
            finished_at_epoch=finished,
            usage=usage_map,
        )
        return result

    # Required by BaseBenchmarkClient. The base class' send_message_tracked
    # path is not used here because send_message above already wraps the
    # transport call with the (richer) cost/latency capture.
    def _send(
        self,
        text: str,
        context: Mapping[str, object] | None,
    ) -> MessageResponse:
        if self.mode == "in_process":
            return self._send_in_process(text, context)
        return self._send_subprocess(text, context)

    # ------------------------------------------------------------------
    # Command construction (separated for unit-test inspection)
    # ------------------------------------------------------------------

    def build_send_message_command(self) -> list[str]:
        """The exact argv used to launch the one-shot script in subprocess mode.

        Exposed for tests so they can assert against the command shape without
        actually executing it.
        """
        return [str(self.venv_python), "-u", "-c", _SEND_MESSAGE_SCRIPT]

    def build_send_message_payload(
        self,
        text: str,
        context: Mapping[str, object] | None,
    ) -> dict[str, object]:
        ctx = dict(context or {})
        raw_tools = ctx.get("tools")
        tools = _openai_compatible_tools(raw_tools)
        system_prompt = ctx.get("system_prompt")
        if isinstance(raw_tools, list) and raw_tools and tools is None:
            tool_context = json.dumps(raw_tools, ensure_ascii=True)
            prefix = system_prompt if isinstance(system_prompt, str) else ""
            system_prompt = (
                f"{prefix}\n\nAvailable benchmark tools/context:\n{tool_context}".strip()
            )
        return {
            "text": text,
            "context": ctx,
            "model": self.model,
            "base_url": self.base_url,
            "api_key": self.api_key,
            "system_prompt": system_prompt if isinstance(system_prompt, str) else None,
            "tools": tools,
            "task_id": self._task_id,
            "benchmark": self._benchmark,
        }

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _send_subprocess(
        self,
        text: str,
        context: Mapping[str, object] | None,
    ) -> MessageResponse:
        cmd = self.build_send_message_command()
        payload = self.build_send_message_payload(text, context)
        result = self._run_python_subprocess(
            cmd[1:],  # drop the leading interpreter path; _run rebuilds it
            stdin=json.dumps(payload),
            timeout_s=self.timeout_s,
            cwd=str(self.repo_path),
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"hermes-agent send_message failed (rc={result.returncode}):\n"
                f"STDERR (last 4000 chars):\n{(result.stderr or '')[-4000:]}"
            )
        stdout = (result.stdout or "").strip()
        last_line = stdout.rsplit("\n", 1)[-1] if stdout else ""
        if not last_line:
            raise RuntimeError(
                f"hermes-agent send_message produced no JSON on stdout. "
                f"STDERR (last 2000 chars):\n{(result.stderr or '')[-2000:]}"
            )
        try:
            parsed = json.loads(last_line)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"hermes-agent send_message stdout not JSON: {exc}\n"
                f"stdout: {stdout[-2000:]}"
            ) from exc
        return self._parse_response(parsed)

    def _send_in_process(
        self,
        text: str,
        context: Mapping[str, object] | None,
    ) -> MessageResponse:
        # Lazy import — only attempted when explicitly requested.
        try:
            from openai import OpenAI  # noqa: WPS433 — lazy by design
            from openai import (  # noqa: WPS433
                APIConnectionError,
                APIStatusError,
                APITimeoutError,
                RateLimitError,
            )
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "in_process mode requires `openai` installed in the parent "
                "Python; install it or use mode='subprocess'."
            ) from exc

        payload = self.build_send_message_payload(text, context)
        oai = OpenAI(
            api_key=payload["api_key"] or None,
            base_url=str(payload["base_url"]),
            max_retries=0,  # we own the retry loop below
        )
        ctx = payload.get("context")
        raw_messages = ctx.get("messages") if isinstance(ctx, Mapping) else None
        sys_prompt = payload.get("system_prompt") if isinstance(payload.get("system_prompt"), str) else None
        messages = _build_openai_messages(
            raw_messages=raw_messages,
            system_prompt=sys_prompt,
            fallback_user_text=text,
        )
        kwargs: dict[str, object] = {"model": str(payload["model"]), "messages": messages}
        tools = payload.get("tools")
        if isinstance(tools, list) and tools:
            kwargs["tools"] = tools

        # Retry loop: 429 + 5xx + network errors, exponential backoff,
        # ``Retry-After`` honored when present. Other 4xx surface immediately.
        last_status: int | None = None
        last_error_str = "no attempt completed"
        for attempt in range(MAX_ATTEMPTS):
            try:
                completion = oai.chat.completions.create(**kwargs)
                break
            except RateLimitError as exc:
                last_status = 429
                last_error_str = str(exc)
                delay = _retry_after_from_openai_exception(exc) or backoff_seconds(attempt)
            except APIStatusError as exc:
                status = getattr(exc, "status_code", None)
                last_status = int(status) if isinstance(status, int) else None
                last_error_str = str(exc)
                if last_status is None or not is_retryable_status(last_status):
                    raise
                delay = _retry_after_from_openai_exception(exc) or backoff_seconds(attempt)
            except (APIConnectionError, APITimeoutError) as exc:
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
                "hermes-adapter retrying chat.completions (attempt %d/%d, status=%s) after %.2fs: %s",
                attempt + 1,
                MAX_ATTEMPTS,
                "net" if last_status is None else last_status,
                delay,
                last_error_str[:200],
            )
            time.sleep(delay)
        else:  # pragma: no cover — defensive; the break/raise paths cover it
            raise RetryExhaustedError(
                attempts=MAX_ATTEMPTS,
                last_status=last_status,
                last_error=last_error_str,
            )
        msg = completion.choices[0].message
        tool_calls = getattr(msg, "tool_calls", None) or []
        parsed_tool_calls = [
            {
                "id": getattr(tc, "id", "") or "",
                "name": getattr(getattr(tc, "function", None), "name", "") or "",
                "arguments": getattr(getattr(tc, "function", None), "arguments", "") or "",
            }
            for tc in tool_calls
        ]
        actions = [
            getattr(getattr(tc, "function", None), "name", "")
            for tc in tool_calls
            if getattr(getattr(tc, "function", None), "name", "")
        ]
        # Surface the provider-reported usage block so the lifeops_bench adapter
        # can parse cache_read_input_tokens (OpenAI / Cerebras shape:
        # ``usage.prompt_tokens_details.cached_tokens``). Mirrors the subprocess
        # path's payload shape; downstream callers read ``params['usage']``.
        usage_obj = getattr(completion, "usage", None)
        if usage_obj is not None and hasattr(usage_obj, "model_dump"):
            usage_payload: dict[str, object] = usage_obj.model_dump()
        elif isinstance(usage_obj, Mapping):
            usage_payload = dict(usage_obj)
        else:
            usage_payload = {}
        return MessageResponse(
            text=str(msg.content or ""),
            thought=getattr(msg, "reasoning_content", None) or None,
            actions=actions,
            params={"tool_calls": parsed_tool_calls, "usage": usage_payload},
        )

    @staticmethod
    def _parse_response(raw: Mapping[str, object]) -> MessageResponse:
        actions_raw = raw.get("actions")
        if isinstance(actions_raw, Sequence) and not isinstance(actions_raw, (str, bytes)):
            actions = [str(a) for a in actions_raw]
        else:
            actions = []
        params_raw = raw.get("params")
        params = dict(params_raw) if isinstance(params_raw, Mapping) else {}
        thought_raw = raw.get("thought")
        thought = str(thought_raw) if isinstance(thought_raw, str) and thought_raw else None
        return MessageResponse(
            text=str(raw.get("text") or ""),
            thought=thought,
            actions=actions,
            params=params,
        )

    def _run_python_subprocess(
        self,
        args: list[str],
        *,
        stdin: str | None = None,
        timeout_s: float,
        cwd: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        cmd = [str(self.venv_python), *args]
        logger.debug("hermes-adapter spawn: %s (cwd=%s)", cmd, cwd)
        env = {**os.environ}
        # Surface our chosen provider creds to the child so any hermes-agent
        # code paths it touches see the same config.
        env["OPENAI_API_KEY"] = self.api_key or env.get("OPENAI_API_KEY", "")
        env["OPENAI_BASE_URL"] = self.base_url
        env["OPENAI_MODEL"] = self.model
        # Default to local terminal backend so we never accidentally spawn Modal
        # or Docker from a casual send_message.
        env.setdefault("TERMINAL_ENV", "local")
        env.setdefault("PYTHONUNBUFFERED", "1")
        return subprocess.run(  # noqa: S603 — argv is constructed, not shell-evaluated
            cmd,
            input=stdin,
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )


def _build_openai_messages(
    *,
    raw_messages: object,
    system_prompt: str | None,
    fallback_user_text: str,
) -> list[dict[str, object]]:
    """Convert a benchmark-shaped message list into chat.completions ``messages``.

    Accepts ``MessageTurn``-shaped dicts with optional ``tool_calls`` (on
    assistant turns) and ``tool_call_id`` / ``name`` (on tool result turns) and
    preserves them so the model sees its own prior tool calls AND the
    corresponding tool results. Without this, the model re-emits the same
    tool call every turn because it never observes a result.
    """
    messages: list[dict[str, object]] = []
    had_raw = False
    if isinstance(raw_messages, Sequence) and not isinstance(raw_messages, (str, bytes)):
        for item in raw_messages:
            if not isinstance(item, Mapping):
                continue
            role = item.get("role")
            if role not in {"system", "user", "assistant", "tool"}:
                continue
            content = item.get("content")
            content_str = "" if content is None else str(content)
            msg: dict[str, object] = {"role": str(role), "content": content_str}
            if role == "assistant":
                tcs = item.get("tool_calls")
                if isinstance(tcs, Sequence) and not isinstance(tcs, (str, bytes)):
                    normalized: list[dict[str, object]] = []
                    for tc in tcs:
                        if not isinstance(tc, Mapping):
                            continue
                        tc_id = tc.get("id")
                        fn = tc.get("function")
                        if not isinstance(fn, Mapping):
                            continue
                        fn_name = fn.get("name")
                        fn_args = fn.get("arguments")
                        if isinstance(fn_args, Mapping):
                            args_str = json.dumps(dict(fn_args))
                        elif isinstance(fn_args, str):
                            args_str = fn_args
                        else:
                            args_str = "{}"
                        if not isinstance(fn_name, str) or not fn_name:
                            continue
                        normalized.append(
                            {
                                "id": str(tc_id) if tc_id else "",
                                "type": "function",
                                "function": {"name": fn_name, "arguments": args_str},
                            }
                        )
                    if normalized:
                        msg["tool_calls"] = normalized
                        # OpenAI rejects assistant messages that have an empty
                        # string content alongside tool_calls — must be None.
                        if not content_str:
                            msg["content"] = None
            elif role == "tool":
                tcid = item.get("tool_call_id")
                if isinstance(tcid, str) and tcid:
                    msg["tool_call_id"] = tcid
                tname = item.get("name")
                if isinstance(tname, str) and tname:
                    msg["name"] = tname
            messages.append(msg)
            had_raw = True
    if not had_raw:
        if isinstance(system_prompt, str) and system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": fallback_user_text})
    return messages


def _openai_compatible_tools(raw_tools: object) -> list[object] | None:
    """Return tools only when every item is an OpenAI tool object.

    Some benchmark contexts use simple string tool names or local schemas. The
    Cerebras OpenAI-compatible API rejects those as ``tools``; we keep them in
    the prompt context instead so Hermes can still reason over the inventory.
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


# ----------------------------------------------------------------------
# The one-shot script that runs inside the hermes-agent venv.
#
# Kept here as a string so build_send_message_command() can return the exact
# argv used. The script reads a JSON payload off stdin, runs one OpenAI-spec
# chat.completions call, and emits a single JSON line on stdout.
#
# Why not always drive HermesAgentLoop? The loop is the right thing when the
# caller passes ``tools=`` and wants tool execution. For a bare "say PONG"
# smoke test, a one-shot completion is faster, cheaper, and has fewer moving
# parts. The script picks the right path based on whether ``tools`` are present
# in the payload.
# ----------------------------------------------------------------------

_SEND_MESSAGE_SCRIPT = r"""
import asyncio
import json
import sys
import time
from email.utils import parsedate_to_datetime


_RETRY_BACKOFF = (1.0, 2.0, 4.0, 8.0, 16.0)
_MAX_ATTEMPTS = 5
_MAX_RETRY_AFTER = 60.0


def _parse_retry_after(value):
    if not value:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    try:
        seconds = float(raw)
    except ValueError:
        try:
            target = parsedate_to_datetime(raw)
        except (TypeError, ValueError):
            return None
        if target is None:
            return None
        seconds = target.timestamp() - time.time()
    if seconds <= 0:
        return 0.0
    return min(seconds, _MAX_RETRY_AFTER)


def _retry_after_from_exc(exc):
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if headers is None:
        return None
    try:
        raw = headers.get("retry-after") or headers.get("Retry-After")
    except AttributeError:
        return None
    return _parse_retry_after(raw)


def _main() -> int:
    raw = sys.stdin.read()
    if not raw:
        print(json.dumps({"text": "", "thought": None, "actions": [], "params": {"error": "no stdin"}}))
        return 0
    payload = json.loads(raw)
    text = payload.get("text", "")
    model = payload.get("model")
    base_url = payload.get("base_url")
    api_key = payload.get("api_key")
    system_prompt = payload.get("system_prompt")
    tools = payload.get("tools")

    try:
        from openai import OpenAI
        from openai import (
            APIConnectionError,
            APIStatusError,
            APITimeoutError,
            RateLimitError,
        )
    except ImportError as exc:
        print(
            json.dumps(
                {
                    "text": "",
                    "thought": None,
                    "actions": [],
                    "params": {"error": f"openai not installed in venv: {exc}"},
                }
            )
        )
        return 0

    client = OpenAI(api_key=api_key or None, base_url=base_url or None, max_retries=0)
    messages = []
    context = payload.get("context")
    raw_messages = context.get("messages") if isinstance(context, dict) else None
    had_raw_messages = False
    if isinstance(raw_messages, list):
        for item in raw_messages:
            if not isinstance(item, dict):
                continue
            role = item.get("role")
            if role not in {"system", "user", "assistant", "tool"}:
                continue
            content = item.get("content")
            content_str = "" if content is None else str(content)
            msg = {"role": role, "content": content_str}
            if role == "assistant":
                tcs = item.get("tool_calls")
                if isinstance(tcs, list):
                    normalized = []
                    for tc in tcs:
                        if not isinstance(tc, dict):
                            continue
                        fn = tc.get("function")
                        if not isinstance(fn, dict):
                            continue
                        fn_name = fn.get("name")
                        if not isinstance(fn_name, str) or not fn_name:
                            continue
                        fn_args = fn.get("arguments")
                        if isinstance(fn_args, dict):
                            args_str = json.dumps(fn_args)
                        elif isinstance(fn_args, str):
                            args_str = fn_args
                        else:
                            args_str = "{}"
                        tc_id = tc.get("id")
                        normalized.append(
                            {
                                "id": str(tc_id) if tc_id else "",
                                "type": "function",
                                "function": {"name": fn_name, "arguments": args_str},
                            }
                        )
                    if normalized:
                        msg["tool_calls"] = normalized
                        if not content_str:
                            msg["content"] = None
            elif role == "tool":
                tcid = item.get("tool_call_id")
                if isinstance(tcid, str) and tcid:
                    msg["tool_call_id"] = tcid
                tname = item.get("name")
                if isinstance(tname, str) and tname:
                    msg["name"] = tname
            messages.append(msg)
            had_raw_messages = True
    if isinstance(system_prompt, str) and system_prompt and not had_raw_messages:
        messages.append({"role": "system", "content": system_prompt})
    if not had_raw_messages:
        messages.append({"role": "user", "content": text})

    kwargs = {"model": model, "messages": messages}
    if isinstance(tools, list) and tools:
        kwargs["tools"] = tools

    completion = None
    last_status = None
    last_err_str = "no attempt completed"
    for attempt in range(_MAX_ATTEMPTS):
        try:
            completion = client.chat.completions.create(**kwargs)
            break
        except RateLimitError as exc:
            last_status = 429
            last_err_str = str(exc)
            delay = _retry_after_from_exc(exc) or _RETRY_BACKOFF[min(attempt, len(_RETRY_BACKOFF) - 1)]
        except APIStatusError as exc:
            status = getattr(exc, "status_code", None)
            last_status = int(status) if isinstance(status, int) else None
            last_err_str = str(exc)
            if last_status is None or not (last_status == 429 or last_status >= 500):
                raise
            delay = _retry_after_from_exc(exc) or _RETRY_BACKOFF[min(attempt, len(_RETRY_BACKOFF) - 1)]
        except (APIConnectionError, APITimeoutError) as exc:
            last_status = None
            last_err_str = "{}: {}".format(type(exc).__name__, exc)
            delay = _RETRY_BACKOFF[min(attempt, len(_RETRY_BACKOFF) - 1)]
        if attempt == _MAX_ATTEMPTS - 1:
            sys.stderr.write(
                "hermes-adapter retry exhausted after {} attempts (last_status={}): {}\n".format(
                    _MAX_ATTEMPTS,
                    "net" if last_status is None else last_status,
                    last_err_str[:300],
                )
            )
            raise RuntimeError(
                "hermes-adapter retry exhausted after {} attempts (last_status={})".format(
                    _MAX_ATTEMPTS,
                    "net" if last_status is None else last_status,
                )
            )
        sys.stderr.write(
            "hermes-adapter retry attempt {}/{} status={} delay={:.2f}s: {}\n".format(
                attempt + 1,
                _MAX_ATTEMPTS,
                "net" if last_status is None else last_status,
                delay,
                last_err_str[:200],
            )
        )
        time.sleep(delay)
    if completion is None:  # defensive — loop must have raised
        raise RuntimeError("hermes-adapter completion is None after retry loop")
    msg = completion.choices[0].message

    tool_calls = []
    raw_tcs = getattr(msg, "tool_calls", None) or []
    for tc in raw_tcs:
        func = getattr(tc, "function", None)
        name = getattr(func, "name", "") if func else ""
        args = getattr(func, "arguments", "") if func else ""
        tool_calls.append({"id": getattr(tc, "id", "") or "", "name": name, "arguments": args})

    thought = getattr(msg, "reasoning_content", None) or getattr(msg, "reasoning", None)
    if not isinstance(thought, str):
        thought = None

    usage = getattr(completion, "usage", None)
    usage_payload = usage.model_dump() if hasattr(usage, "model_dump") else {}

    result = {
        "text": msg.content or "",
        "thought": thought,
        "actions": [tc["name"] for tc in tool_calls if tc["name"]],
        "params": {"tool_calls": tool_calls, "usage": usage_payload},
    }
    sys.stdout.write(json.dumps(result))
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
else:
    raise SystemExit(_main())
"""
