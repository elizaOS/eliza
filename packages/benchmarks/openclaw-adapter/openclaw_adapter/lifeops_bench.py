"""LifeOpsBench agent_fn backed by the OpenClaw harness."""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

from openclaw_adapter.client import OpenClawClient

logger = logging.getLogger(__name__)


def build_lifeops_bench_agent_fn(
    *,
    client: OpenClawClient | None = None,
    system_prompt: str | None = None,
    model_name: str | None = None,
) -> Callable[[list[Any], list[dict[str, Any]]], Awaitable[Any]]:
    from eliza_lifeops_bench.types import MessageTurn  # noqa: WPS433

    bridge = client or OpenClawClient(model=model_name)
    bridge.wait_until_ready(timeout=60)

    async def _agent_fn(
        conversation_history: list[Any],
        tools: list[dict[str, Any]],
    ) -> Any:
        last_user_text = ""
        messages: list[dict[str, str]] = []
        for turn in conversation_history:
            role = getattr(turn, "role", None) or (turn.get("role") if isinstance(turn, dict) else None)
            content = getattr(turn, "content", None) or (turn.get("content") if isinstance(turn, dict) else "")
            if role in {"system", "user", "assistant", "tool"}:
                messages.append({"role": str(role), "content": str(content or "")})
            if role == "user":
                last_user_text = str(content or "")
        if not last_user_text:
            return MessageTurn(role="assistant", content="", tool_calls=None)

        context: dict[str, object] = {"messages": messages}
        if tools:
            context["tools"] = tools
        if system_prompt:
            context["system_prompt"] = system_prompt

        try:
            resp = bridge.send_message(last_user_text, context=context)
        except Exception as exc:  # noqa: BLE001
            logger.exception("[openclaw-lifeops] send_message failed")
            raise RuntimeError("OpenClaw LifeOps send_message failed") from exc

        tool_calls: list[dict[str, Any]] = []
        raw_tool_calls = resp.params.get("tool_calls") if isinstance(resp.params, dict) else None
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
        turn = MessageTurn(role="assistant", content=resp.text, tool_calls=tool_calls or None)
        if model_name:
            setattr(turn, "model_name", model_name)
        usage = resp.params.get("usage") if isinstance(resp.params, dict) else None
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
