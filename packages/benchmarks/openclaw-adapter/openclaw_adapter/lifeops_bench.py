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
    from eliza_lifeops_bench.types import (  # noqa: WPS433 — lazy
        MessageTurn,
        attach_usage_cache_fields,
    )

    bridge = client or OpenClawClient()
    snapshot = _load_snapshot(world_snapshot_path)

    async def _agent_fn(
        conversation_history: list[Any],
        tools: list[dict[str, Any]],
    ) -> Any:
        last_user_text = _last_user_text(conversation_history)
        if not last_user_text:
            return MessageTurn(role="assistant", content="", tool_calls=None)

        messages = _conversation_messages(
            conversation_history,
            system_prompt=system_prompt,
            now_iso=now_iso,
            snapshot=snapshot,
        )
        message = last_user_text.strip()

        context: dict[str, object] = {"messages": messages}
        if tools:
            context["tools"] = tools
            context["tool_choice"] = "auto"

        try:
            resp = bridge.send_message(message, context=context)
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
        # OpenClaw exposes usage either at params['usage'] (OpenAI-compat mode)
        # or under params['_meta']['usage'] (CLI mode). Prefer the direct slot
        # and fall back to the meta blob so both transports surface cache.
        usage = resp.params.get("usage") if isinstance(resp.params, dict) else None
        if not isinstance(usage, dict):
            usage_meta = resp.params.get("_meta") if isinstance(resp.params, dict) else None
            usage = usage_meta.get("usage") if isinstance(usage_meta, dict) else None
        if isinstance(usage, dict):
            attach_usage_cache_fields(turn, usage)
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


def _conversation_messages(
    conversation_history: list[Any],
    *,
    system_prompt: str | None,
    now_iso: str,
    snapshot: dict[str, Any],
) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": "\n\n".join(
                chunk
                for chunk in (
                    system_prompt,
                    f"NOW: {now_iso}",
                    "WORLD_SNAPSHOT:\n"
                    + json.dumps(snapshot, ensure_ascii=True, indent=2),
                )
                if isinstance(chunk, str) and chunk.strip()
            ),
        }
    ]
    for turn in conversation_history:
        role = (
            getattr(turn, "role", None)
            or (turn.get("role") if isinstance(turn, dict) else None)
        )
        if role not in {"user", "assistant", "system", "tool"}:
            continue
        content = (
            getattr(turn, "content", None)
            if not isinstance(turn, dict)
            else turn.get("content")
        )
        msg: dict[str, Any] = {
            "role": role,
            "content": str(content or ""),
        }
        name = (
            getattr(turn, "name", None)
            if not isinstance(turn, dict)
            else turn.get("name")
        )
        if isinstance(name, str) and name:
            msg["name"] = name
        tool_call_id = (
            getattr(turn, "tool_call_id", None)
            if not isinstance(turn, dict)
            else turn.get("tool_call_id") or turn.get("toolCallId")
        )
        if isinstance(tool_call_id, str) and tool_call_id:
            msg["tool_call_id"] = tool_call_id
        tool_calls = (
            getattr(turn, "tool_calls", None)
            if not isinstance(turn, dict)
            else turn.get("tool_calls") or turn.get("toolCalls")
        )
        if isinstance(tool_calls, list) and tool_calls:
            msg["tool_calls"] = tool_calls
            if role == "assistant" and not msg["content"]:
                msg["content"] = None
        messages.append(msg)
    return messages


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
