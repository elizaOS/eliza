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

logger = logging.getLogger(__name__)


DEFAULT_REPO_PATH = Path.home() / ".eliza" / "agents" / "hermes-agent-src"
DEFAULT_VENV_PYTHON = DEFAULT_REPO_PATH / ".venv" / "bin" / "python"


@dataclass
class MessageResponse:
    """Parsed response from a single hermes-agent turn."""

    text: str
    thought: str | None
    actions: list[str]
    params: dict[str, object]


class HermesClient:
    """Client for one-shot turns against hermes-agent.

    ``mode='subprocess'`` (default): spawn a one-shot Python script using the
    venv interpreter. The script imports ``HermesAgentLoop`` (or, for the
    minimal smoke path, the raw OpenAI client) and emits a single JSON line.

    ``mode='in_process'``: import hermes-agent in the current process. Only
    works if the parent Python already has hermes-agent installed.
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
    ) -> None:
        if mode not in {"subprocess", "in_process"}:
            raise ValueError(f"Unknown mode {mode!r}; expected 'subprocess' or 'in_process'")

        self.repo_path = Path(repo_path) if repo_path else DEFAULT_REPO_PATH
        if venv_python is not None:
            self.venv_python = Path(venv_python)
        else:
            self.venv_python = self.repo_path / ".venv" / "bin" / "python"

        self.provider = provider
        self.model = model
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
        """
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
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "in_process mode requires `openai` installed in the parent "
                "Python; install it or use mode='subprocess'."
            ) from exc

        payload = self.build_send_message_payload(text, context)
        oai = OpenAI(api_key=payload["api_key"] or None, base_url=str(payload["base_url"]))
        messages: list[dict[str, object]] = []
        ctx = payload.get("context")
        raw_messages = ctx.get("messages") if isinstance(ctx, Mapping) else None
        had_raw_messages = False
        if isinstance(raw_messages, Sequence) and not isinstance(raw_messages, (str, bytes)):
            for item in raw_messages:
                if not isinstance(item, Mapping):
                    continue
                role = item.get("role")
                content = item.get("content")
                if role in {"system", "user", "assistant", "tool"}:
                    messages.append({"role": str(role), "content": "" if content is None else str(content)})
                    had_raw_messages = True
        sys_prompt = payload.get("system_prompt")
        if isinstance(sys_prompt, str) and sys_prompt and not had_raw_messages:
            messages.append({"role": "system", "content": sys_prompt})
        if not had_raw_messages:
            messages.append({"role": "user", "content": text})
        kwargs: dict[str, object] = {"model": str(payload["model"]), "messages": messages}
        tools = payload.get("tools")
        if isinstance(tools, list) and tools:
            kwargs["tools"] = tools
        completion = oai.chat.completions.create(**kwargs)
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
        return MessageResponse(
            text=str(msg.content or ""),
            thought=getattr(msg, "reasoning_content", None) or None,
            actions=actions,
            params={"tool_calls": parsed_tool_calls},
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

    client = OpenAI(api_key=api_key or None, base_url=base_url or None)
    messages = []
    context = payload.get("context")
    raw_messages = context.get("messages") if isinstance(context, dict) else None
    had_raw_messages = False
    if isinstance(raw_messages, list):
        for item in raw_messages:
            if not isinstance(item, dict):
                continue
            role = item.get("role")
            content = item.get("content")
            if role in {"system", "user", "assistant", "tool"}:
                messages.append({"role": role, "content": "" if content is None else str(content)})
                had_raw_messages = True
    if isinstance(system_prompt, str) and system_prompt and not had_raw_messages:
        messages.append({"role": "system", "content": system_prompt})
    if not had_raw_messages:
        messages.append({"role": "user", "content": text})

    kwargs = {"model": model, "messages": messages}
    if isinstance(tools, list) and tools:
        kwargs["tools"] = tools

    completion = client.chat.completions.create(**kwargs)
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
