"""Cascaded STT adapters for Eliza / Hermes / OpenClaw.

Each factory wraps a real backend agent. The user :class:`MessageTurn`
already carries both the STT transcript (in ``content``) and the raw
audio bytes (in ``audio_input``). The cascaded baselines consume
``content``; future direct-audio adapters can opt into ``audio_input``
without further runner changes.

The Eliza factory hits the real Eliza agent runtime HTTP API
(``ELIZA_API_BASE``, default ``http://localhost:31337``) via
``/api/benchmark/message``. This is the same endpoint used by
``eliza_adapter.client.ElizaClient`` in every other bench in the repo.
The previous delegation to ``cerebras-direct`` was a stub that bypassed
the Eliza runtime entirely — it has been replaced.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from ..types import AgentFn, MessageTurn


# ---------------------------------------------------------------------------
# Real Eliza runtime HTTP adapter
# ---------------------------------------------------------------------------

_DEFAULT_ELIZA_API_BASE = "http://localhost:31337"
_HTTP_TIMEOUT_S = 120.0
_ELIZA_SERVER_MANAGER: Any | None = None


def _ensure_eliza_adapter_importable() -> None:
    adapter_root = Path(__file__).resolve().parents[3] / "eliza-adapter"
    if adapter_root.exists() and str(adapter_root) not in sys.path:
        sys.path.insert(0, str(adapter_root))


def _ensure_eliza_server() -> None:
    global _ELIZA_SERVER_MANAGER
    if os.environ.get("ELIZA_BENCH_URL") or os.environ.get("ELIZA_API_BASE"):
        return
    _ensure_eliza_adapter_importable()
    try:
        from eliza_adapter.server_manager import ElizaServerManager
    except ImportError as exc:
        raise RuntimeError(
            "Cannot auto-spawn the eliza bench server: "
            "eliza_adapter.server_manager is unavailable. Install "
            "eliza-adapter or set ELIZA_BENCH_URL to a running server."
        ) from exc
    manager = ElizaServerManager()
    manager.start()
    _ELIZA_SERVER_MANAGER = manager
    os.environ["ELIZA_BENCH_URL"] = manager.client.base_url
    os.environ["ELIZA_BENCH_TOKEN"] = manager.token


def _eliza_api_base() -> str:
    return (
        os.environ.get("ELIZA_API_BASE")
        or os.environ.get("ELIZA_BENCH_URL")
        or _DEFAULT_ELIZA_API_BASE
    ).rstrip("/")


def _eliza_post(path: str, body: dict[str, object]) -> dict[str, object]:
    url = f"{_eliza_api_base()}{path}"
    data = json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    token = os.environ.get("ELIZA_BENCH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers=headers,
    )
    timeout = float(os.environ.get("ELIZA_BENCH_HTTP_TIMEOUT", str(_HTTP_TIMEOUT_S)))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Eliza runtime returned HTTP {exc.code}: {body_text}"
        ) from exc


def _wait_for_eliza(timeout: float = 60.0, poll: float = 1.0) -> None:
    """Poll /api/benchmark/health until the runtime is ready."""
    import socket
    from urllib.parse import urlparse

    parsed = urlparse(_eliza_api_base())
    host = parsed.hostname or "localhost"
    port = parsed.port or 31337
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=1.0):
                return
        except OSError:
            time.sleep(poll)
    raise RuntimeError(
        f"Eliza runtime at {_eliza_api_base()} did not become reachable "
        f"within {timeout}s. Is `bun run dev` running?"
    )


class _ElizaHttpAgent:
    """Stateless callable that routes one voice-agent turn through the Eliza runtime.

    The runner passes history + tool_manifest on each call. We send the
    latest user transcript to ``/api/benchmark/message`` and map the
    response back to a :class:`MessageTurn`. Tool-call extraction reuses
    the runtime's ``captured_actions`` field (same as lifeops_bench).
    """

    def __init__(self, *, tool_inject_system: bool = True) -> None:
        self._tool_inject = tool_inject_system
        # Eagerly verify the runtime is reachable (fast path — raises quickly
        # if it isn't so CI fails loudly rather than timing out per-task).
        _wait_for_eliza(timeout=float(os.environ.get("ELIZA_WAIT_TIMEOUT", "60")))

    async def __call__(
        self,
        history: list[MessageTurn],
        tool_manifest: list[dict[str, Any]],
    ) -> MessageTurn:
        # Extract the latest user turn text.
        user_text = ""
        for turn in reversed(history):
            if turn.role == "user":
                user_text = turn.content or ""
                break

        context: dict[str, object] = {
            "benchmark": "voiceagentbench",
            "tools": tool_manifest,
        }
        body: dict[str, object] = {"text": user_text, "context": context}
        raw = _eliza_post("/api/benchmark/message", body)

        text = str(raw.get("text") or "")
        # Map captured_actions → tool_calls in standard OpenAI format.
        tool_calls: list[dict[str, object]] = []
        for action in raw.get("captured_actions") or []:
            if not isinstance(action, dict):
                continue
            params = action.get("params") or {}
            name = (
                action.get("toolName")
                or action.get("tool_name")
                or params.get("tool_name")
                or action.get("command")
                or ""
            )
            if not isinstance(name, str) or not name.strip():
                continue
            arguments = action.get("arguments") or {
                k: v for k, v in params.items() if k != "tool_name"
            }
            tool_calls.append(
                {
                    "id": str(action.get("id") or f"call_{len(tool_calls)}"),
                    "type": "function",
                    "function": {
                        "name": name.strip(),
                        "arguments": json.dumps(arguments, ensure_ascii=False),
                    },
                }
            )

        # Also check the top-level tool_calls field the runtime may emit.
        for tc in raw.get("tool_calls") or []:
            if isinstance(tc, dict):
                tool_calls.append(tc)

        return MessageTurn(
            role="assistant",
            content=text,
            tool_calls=tool_calls or None,
        )


def build_eliza_agent(**kwargs: Any) -> AgentFn:
    """Build the real Eliza runtime HTTP adapter for VoiceAgentBench.

    Requires a running Eliza agent runtime reachable at ``ELIZA_API_BASE``
    (default ``http://localhost:31337``).  Start it with ``bun run dev``
    before running the benchmark.
    """
    _ensure_eliza_server()
    return _ElizaHttpAgent(**kwargs)  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Hermes / OpenClaw — real LifeOps cascaded adapters
# ---------------------------------------------------------------------------


def build_hermes_agent(**kwargs: Any) -> AgentFn:
    """Cascaded Hermes adapter."""
    from eliza_lifeops_bench.agents.hermes import build_hermes_agent as _build  # noqa: WPS433

    return _build(**kwargs)


def build_openclaw_agent(**kwargs: Any) -> AgentFn:
    """Cascaded OpenClaw adapter."""
    from eliza_lifeops_bench.agents.openclaw import (  # noqa: WPS433
        build_openclaw_agent as _build,
    )

    return _build(**kwargs)
