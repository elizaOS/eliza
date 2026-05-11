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
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence

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
DEFAULT_THINKING_LEVEL = "medium"
DEFAULT_TIMEOUT_S = 600.0


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
        base_url_env: str = DEFAULT_BASE_URL_ENV,
        thinking_level: str = DEFAULT_THINKING_LEVEL,
        timeout_s: float = DEFAULT_TIMEOUT_S,
    ) -> None:
        self.repo_path = Path(repo_path) if repo_path else _default_repo_path()
        self.binary_path = Path(binary_path) if binary_path else _resolve_default_binary()
        self.provider = provider
        self.model = model
        self.api_key_env = api_key_env
        self.base_url_env = base_url_env
        self.api_key = api_key if api_key is not None else _default_api_key(provider, api_key_env)
        self.thinking_level = thinking_level
        self.timeout_s = float(timeout_s)
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
        """Spawn one ``openclaw agent --local --json`` turn and parse it."""
        argv = self.build_argv(text, context)
        env = self.build_env()
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
            raise RuntimeError(
                f"openclaw CLI timed out after {self.timeout_s}s\n"
                f"argv: {argv}\n"
                f"stdout so far: {(exc.stdout or '')[-2000:]}\n"
                f"stderr so far: {(exc.stderr or '')[-2000:]}"
            ) from exc

        if result.returncode != 0:
            raise RuntimeError(
                f"openclaw CLI failed rc={result.returncode}\n"
                f"argv: {argv}\n"
                f"stdout:\n{(result.stdout or '')[-4000:]}\n"
                f"stderr:\n{(result.stderr or '')[-4000:]}"
            )

        payload = _extract_json_blob(result.stdout or "", result.stderr or "")
        return _response_from_payload(payload)

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
            text,
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
        api_key = env.get(self.api_key_env, "")
        if api_key:
            env[self.api_key_env] = api_key
            env.setdefault("OPENAI_API_KEY", api_key)
        base_url = env.get(self.base_url_env, "")
        if base_url:
            env.setdefault("OPENAI_BASE_URL", base_url)
        return env


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------


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
    raw_tool_calls = _collect_tool_calls(payload)

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
    for key in ("usage", "sessionId", "session_id", "agent", "id"):
        value = payload.get(key)
        if value is not None and key not in params:
            extras[key] = value
    if extras:
        params.setdefault("_meta", extras)
    if raw_tool_calls:
        params.setdefault("tool_calls", raw_tool_calls)

    return MessageResponse(
        text=text or "",
        thought=thought or None,
        actions=actions,
        params=params,
    )


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
        "arguments": args_obj if isinstance(args_obj, (Mapping, list)) else {},
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
        "arguments": args if isinstance(args, dict) else {},
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
