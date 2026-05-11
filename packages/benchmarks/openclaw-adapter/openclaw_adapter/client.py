"""Client surface for running benchmarks through an OpenClaw-style harness.

The real OpenClaw project is installed from source by
``benchmarks.lib.agent_install``.  For benchmark parity this client exposes the
same small surface as ``ElizaClient`` / ``HermesClient``: ``reset`` plus
``send_message`` returning a normalized ``MessageResponse``.

OpenClaw's public CLI surface moves faster than the benchmark suite, so the
default execution path is an OpenAI-compatible chat completion using
OpenClaw's text-embedded ``<tool_call>{...}</tool_call>`` protocol.  Operators
can force the source CLI path with ``OPENCLAW_USE_CLI=1`` once a compatible
source checkout has been installed.
"""

from __future__ import annotations

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

logger = logging.getLogger(__name__)

DEFAULT_REPO_PATH = Path.home() / ".eliza" / "agents" / "openclaw-src"
DEFAULT_BASE_URL = "https://api.cerebras.ai/v1"
DEFAULT_MODEL = "gpt-oss-120b"

_TOOL_CALL_RE = re.compile(
    r"<tool_call>\s*(\{.*?\})\s*</tool_call>|<tool_call>\s*(\{.*)\Z",
    re.DOTALL,
)


@dataclass
class MessageResponse:
    """Parsed response from a single OpenClaw-harness turn."""

    text: str
    thought: str | None
    actions: list[str]
    params: dict[str, object]


class OpenClawClient:
    """Benchmark client for OpenClaw-style tool calling."""

    def __init__(
        self,
        *,
        repo_path: Path | None = None,
        binary_path: Path | None = None,
        provider: str = "cerebras",
        model: str | None = None,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout_s: float = 1200.0,
    ) -> None:
        self.repo_path = Path(repo_path) if repo_path else _default_repo_path()
        self.binary_path = Path(binary_path) if binary_path else _default_binary_path(self.repo_path)
        self.provider = provider
        self.model = model or os.environ.get("OPENCLAW_MODEL") or os.environ.get("CEREBRAS_MODEL") or DEFAULT_MODEL
        self.api_key = api_key if api_key is not None else _default_api_key(provider)
        self.base_url = base_url or os.environ.get("OPENCLAW_BASE_URL") or os.environ.get("CEREBRAS_BASE_URL") or DEFAULT_BASE_URL
        self.timeout_s = float(timeout_s)
        self._task_id: str | None = None
        self._benchmark: str | None = None

    def health(self) -> dict[str, object]:
        if not self.repo_path.exists():
            return {
                "status": "error",
                "error": f"OpenClaw source checkout not found at {self.repo_path}",
            }
        if os.environ.get("OPENCLAW_USE_CLI", "").strip() == "1":
            if not self.binary_path.exists():
                return {
                    "status": "error",
                    "error": f"OpenClaw binary not found at {self.binary_path}",
                }
            try:
                result = subprocess.run(
                    [str(_node_binary()), str(self.binary_path), "--version"],
                    cwd=str(self.repo_path),
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )
            except Exception as exc:  # noqa: BLE001
                return {"status": "error", "error": str(exc)}
            if result.returncode != 0:
                return {
                    "status": "error",
                    "error": (result.stderr or result.stdout or "").strip(),
                }
        return {"status": "ready", "repo_path": str(self.repo_path)}

    def is_ready(self) -> bool:
        return self.health().get("status") == "ready"

    def wait_until_ready(self, timeout: float = 60.0, poll: float = 1.0) -> None:
        deadline = time.monotonic() + float(timeout)
        last: object = "no probe attempted"
        while time.monotonic() < deadline:
            probe = self.health()
            if probe.get("status") == "ready":
                return
            last = probe.get("error") or probe
            time.sleep(poll)
        raise TimeoutError(f"OpenClaw harness not ready after {timeout}s: {last}")

    def reset(self, task_id: str, benchmark: str, **kwargs: object) -> dict[str, object]:
        del kwargs
        self._task_id = task_id
        self._benchmark = benchmark
        return {"task_id": task_id, "benchmark": benchmark, "status": "ready"}

    def send_message(
        self,
        text: str,
        context: Mapping[str, object] | None = None,
    ) -> MessageResponse:
        if os.environ.get("OPENCLAW_USE_CLI", "").strip() == "1":
            return self._send_cli(text, context)
        return self._send_openai_compatible(text, context)

    def _send_cli(
        self,
        text: str,
        context: Mapping[str, object] | None,
    ) -> MessageResponse:
        self.wait_until_ready(timeout=30)
        cmd = [
            str(_node_binary()),
            str(self.binary_path),
            "agent",
            "--json",
            "--message",
            text,
        ]
        if context:
            cmd.extend(["--context-json", json.dumps(dict(context), separators=(",", ":"))])
        result = subprocess.run(
            cmd,
            cwd=str(self.repo_path),
            capture_output=True,
            text=True,
            timeout=self.timeout_s,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"openclaw CLI failed rc={result.returncode}: {(result.stderr or '')[-4000:]}"
            )
        stdout = (result.stdout or "").strip()
        payload = json.loads(stdout.rsplit("\n", 1)[-1])
        return _response_from_payload(payload)

    def _send_openai_compatible(
        self,
        text: str,
        context: Mapping[str, object] | None,
    ) -> MessageResponse:
        ctx = dict(context or {})
        messages = _messages_from_context(text, ctx)
        tools = ctx.get("tools")
        system_prompt = _openclaw_system_prompt(tools if isinstance(tools, list) else None)
        messages = [{"role": "system", "content": system_prompt}, *messages]

        body: dict[str, object] = {
            "model": self.model,
            "messages": messages,
            "temperature": 0,
            "max_tokens": int(ctx.get("max_tokens") or os.environ.get("OPENCLAW_MAX_TOKENS") or 1024),
        }
        request = urllib.request.Request(
            f"{self.base_url.rstrip('/')}/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Accept-Encoding": "identity",
                "User-Agent": "eliza-openclaw-benchmark/1.0",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_s) as response:  # nosec B310
                data = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"OpenClaw-compatible completion failed: {detail}") from exc

        msg = (data.get("choices") or [{}])[0].get("message", {})
        content = str(msg.get("content") or "")
        text_out, parsed_tool_calls = parse_openclaw_tool_calls(content)
        native_tool_calls = [_coerce_native_tool_call(tc) for tc in msg.get("tool_calls") or []]
        tool_calls = [tc for tc in [*parsed_tool_calls, *native_tool_calls] if tc is not None]
        usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        return MessageResponse(
            text=text_out,
            thought=str(msg.get("reasoning") or msg.get("reasoning_content") or "") or None,
            actions=[str(tc.get("name")) for tc in tool_calls if tc.get("name")],
            params={"tool_calls": tool_calls, "usage": usage},
        )


def parse_openclaw_tool_calls(text: str) -> tuple[str, list[dict[str, object]]]:
    if "<tool_call>" not in text:
        return text, []
    tool_calls: list[dict[str, object]] = []
    for index, (closed, unclosed) in enumerate(_TOOL_CALL_RE.findall(text)):
        raw = (closed or unclosed).strip()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            logger.debug("dropping malformed OpenClaw tool_call payload: %r", raw)
            continue
        name = data.get("tool") or data.get("name")
        if not isinstance(name, str) or not name:
            continue
        args = data.get("args", data.get("arguments", {}))
        tool_calls.append(
            {
                "id": str(data.get("id") or f"call_openclaw_{index}"),
                "name": name,
                "arguments": args if isinstance(args, dict) else {},
            }
        )
    return text[: text.find("<tool_call>")].strip(), tool_calls


def _coerce_native_tool_call(raw: object) -> dict[str, object] | None:
    if not isinstance(raw, dict):
        return None
    fn = raw.get("function")
    if isinstance(fn, dict):
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


def _messages_from_context(text: str, ctx: Mapping[str, object]) -> list[dict[str, str]]:
    raw_messages = ctx.get("messages")
    messages: list[dict[str, str]] = []
    if isinstance(raw_messages, Sequence) and not isinstance(raw_messages, (str, bytes)):
        for item in raw_messages:
            if not isinstance(item, Mapping):
                continue
            role = item.get("role")
            content = item.get("content")
            if role in {"system", "user", "assistant", "tool"}:
                messages.append({"role": str(role), "content": "" if content is None else str(content)})
    if not messages:
        sys_prompt = ctx.get("system_prompt")
        if isinstance(sys_prompt, str) and sys_prompt.strip():
            messages.append({"role": "system", "content": sys_prompt.strip()})
        messages.append({"role": "user", "content": text})
    return messages


def _openclaw_system_prompt(tools: list[object] | None) -> str:
    prompt = (
        "You are operating through the OpenClaw benchmark harness. "
        "Use concise reasoning. When a tool is required, emit exactly one "
        "<tool_call>{\"tool\":\"NAME\",\"args\":{...}}</tool_call> block. "
        "Otherwise answer normally."
    )
    if tools:
        prompt += "\nAvailable tools:\n" + json.dumps(tools, ensure_ascii=True)
    return prompt


def _response_from_payload(payload: Mapping[str, object]) -> MessageResponse:
    if isinstance(payload.get("messages"), list):
        last = next(
            (
                msg
                for msg in reversed(payload["messages"])  # type: ignore[index]
                if isinstance(msg, dict) and msg.get("role") == "assistant"
            ),
            {},
        )
        content = str(last.get("content") or "") if isinstance(last, dict) else ""
        text, parsed_tool_calls = parse_openclaw_tool_calls(content)
        raw_tool_calls = last.get("tool_calls") if isinstance(last, dict) else []
    else:
        text, parsed_tool_calls = parse_openclaw_tool_calls(str(payload.get("text") or ""))
        raw_tool_calls = payload.get("tool_calls") or []
    native = [_coerce_native_tool_call(tc) for tc in raw_tool_calls if isinstance(raw_tool_calls, list)]
    tool_calls = [tc for tc in [*parsed_tool_calls, *native] if tc is not None]
    return MessageResponse(
        text=text,
        thought=str(payload.get("thought") or "") or None,
        actions=[str(tc.get("name")) for tc in tool_calls if tc.get("name")],
        params={"tool_calls": tool_calls},
    )


def _default_api_key(provider: str) -> str:
    provider = provider.strip().lower()
    key_env = {
        "cerebras": "CEREBRAS_API_KEY",
        "openai": "OPENAI_API_KEY",
        "openrouter": "OPENROUTER_API_KEY",
        "groq": "GROQ_API_KEY",
    }.get(provider, "CEREBRAS_API_KEY")
    return os.environ.get("OPENCLAW_API_KEY") or os.environ.get(key_env, "")


def _default_repo_path() -> Path:
    override = os.environ.get("OPENCLAW_REPO_PATH", "").strip()
    if override:
        return Path(override).expanduser()
    root = Path(os.environ.get("ELIZA_AGENTS_ROOT", Path.home() / ".eliza" / "agents"))
    return root / "openclaw-src"


def _default_binary_path(repo_path: Path) -> Path:
    override = os.environ.get("OPENCLAW_BIN", "").strip()
    if override:
        return Path(override).expanduser()
    return repo_path / "openclaw.mjs"


def _node_binary() -> Path:
    return Path(os.environ.get("NODE_BINARY", "node"))
