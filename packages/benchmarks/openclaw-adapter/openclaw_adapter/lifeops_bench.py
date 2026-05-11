"""LifeOpsBench agent_fn backed by the OpenClaw CLI.

Mirrors :func:`eliza_adapter.lifeops_bench.build_lifeops_bench_agent_fn`,
but routes each user turn through :class:`OpenClawClient` instead of the
elizaOS HTTP bench server. OpenClaw runs as a separate process and cannot
drive the in-memory fake backend the eliza path uses, so the world snapshot
is embedded into the prompt context as JSON and the conversation is
otherwise treated stateless.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Awaitable, Callable

from openclaw_adapter.client import OpenClawClient

logger = logging.getLogger(__name__)


def build_lifeops_bench_agent_fn(
    *,
    client: OpenClawClient | None = None,
    world_snapshot_path: str,
    now_iso: str = "2026-05-10T12:00:00Z",
    model_name: str | None = None,
    system_prompt: str | None = None,
) -> Callable[[list[Any], list[dict[str, Any]]], Awaitable[Any]]:
    """Create a LifeOpsBench-compatible ``agent_fn`` backed by OpenClaw.

    The returned coroutine has signature
    ``agent_fn(history: list[MessageTurn], tools: list[dict]) -> MessageTurn``
    so it plugs straight into ``LifeOpsBenchRunner``.

    OpenClaw is driven via a separate CLI process, so we cannot mutate the
    LifeWorld in-place the way the elizaOS adapter does. Instead, the
    snapshot at ``world_snapshot_path`` is loaded once, embedded into the
    user message as ``WORLD_SNAPSHOT`` JSON, and OpenClaw is expected to
    reason about it via the provided tools.
    """
    from eliza_lifeops_bench.types import MessageTurn  # noqa: WPS433 — lazy

    bridge = client or OpenClawClient()
    snapshot = _load_snapshot(world_snapshot_path)

    async def _agent_fn(
        conversation_history: list[Any],
        tools: list[dict[str, Any]],
    ) -> Any:
        last_user_text = _last_user_text(conversation_history)
        if not last_user_text:
            return MessageTurn(role="assistant", content="", tool_calls=None)

        prompt_chunks: list[str] = []
        if system_prompt:
            prompt_chunks.append(system_prompt.strip())
        prompt_chunks.append(f"NOW: {now_iso}")
        prompt_chunks.append(
            "WORLD_SNAPSHOT:\n" + json.dumps(snapshot, ensure_ascii=True, indent=2)
        )
        prompt_chunks.append(last_user_text.strip())
        message = "\n\n".join(chunk for chunk in prompt_chunks if chunk)

        context: dict[str, object] = {}
        if tools:
            context["tools"] = tools

        try:
            resp = bridge.send_message(message, context=context or None)
        except Exception as exc:
            logger.exception("[openclaw-lifeops] send_message failed")
            raise RuntimeError("OpenClaw LifeOps send_message failed") from exc

        raw_tool_calls = resp.params.get("tool_calls") if isinstance(resp.params, dict) else None
        tool_calls: list[dict[str, Any]] = []
        if isinstance(raw_tool_calls, list):
            for entry in raw_tool_calls:
                if not isinstance(entry, dict):
                    continue
                name = str(entry.get("name") or "")
                if not name:
                    continue
                args = entry.get("arguments")
                tool_calls.append(
                    {
                        "id": str(entry.get("id") or f"call_{len(tool_calls)}"),
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": args if isinstance(args, dict) else {},
                        },
                    }
                )

        turn = MessageTurn(
            role="assistant",
            content=resp.text,
            tool_calls=tool_calls or None,
        )
        if model_name:
            setattr(turn, "model_name", model_name)
        usage_meta = resp.params.get("_meta") if isinstance(resp.params, dict) else None
        usage = usage_meta.get("usage") if isinstance(usage_meta, dict) else None
        if isinstance(usage, dict):
            for attr, key in (
                ("input_tokens", "prompt_tokens"),
                ("output_tokens", "completion_tokens"),
            ):
                value = usage.get(key)
                if isinstance(value, (int, float)):
                    setattr(turn, attr, int(value))
        return turn

    return _agent_fn


def _last_user_text(conversation_history: list[Any]) -> str:
    for turn in reversed(conversation_history):
        role = (
            getattr(turn, "role", None)
            or (turn.get("role") if isinstance(turn, dict) else None)
        )
        content = (
            getattr(turn, "content", None)
            or (turn.get("content") if isinstance(turn, dict) else "")
        )
        if role == "user":
            return str(content or "")
    return ""


def _load_snapshot(world_snapshot_path: str) -> dict[str, Any]:
    path = Path(world_snapshot_path).expanduser()
    if not path.exists():
        raise FileNotFoundError(
            f"LifeOps world snapshot not found at {path}"
        )
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError(
            f"LifeOps world snapshot at {path} must be a JSON object, got {type(data).__name__}"
        )
    return data


__all__ = ["build_lifeops_bench_agent_fn"]
