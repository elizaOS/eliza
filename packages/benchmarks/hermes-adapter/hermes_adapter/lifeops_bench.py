"""LifeOpsBench agent_fn backed by hermes-agent.

Mirrors ``eliza_adapter.lifeops_bench.build_lifeops_bench_agent_fn`` but routes
each user turn through :class:`HermesClient` instead of the elizaOS HTTP
bench server. Each turn spawns a one-shot hermes-agent invocation in the
hermes venv with the conversation's tool catalog injected via the OpenAI
``tools=`` parameter.

The adapter is deliberately thin — it owns no scenario state and treats the
hermes-agent venv as the source of truth for tool execution. LifeOpsBench's
state-hash scoring is delegated to whatever world-state fixture the caller
supplies via ``fixtures`` (this differs from the Eliza path, where the TS
bench server hydrates an in-memory fake backend).
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

from hermes_adapter.client import HermesClient

logger = logging.getLogger(__name__)


def build_lifeops_bench_agent_fn(
    *,
    client: HermesClient | None = None,
    scenario_yaml: dict[str, Any] | None = None,
    fixtures: dict[str, Any] | None = None,
    system_prompt: str | None = None,
    model_name: str | None = None,
) -> Callable[[list[Any], list[dict[str, Any]]], Awaitable[Any]]:
    """Create a LifeOpsBench-compatible ``agent_fn`` backed by hermes-agent.

    The returned coroutine has signature
    ``agent_fn(history: list[MessageTurn], tools: list[dict]) -> MessageTurn``
    so it plugs into ``LifeOpsBenchRunner`` exactly like the eliza-adapter
    equivalent.
    """
    from eliza_lifeops_bench.types import MessageTurn  # noqa: WPS433 — lazy

    bridge = client or HermesClient()
    bridge.wait_until_ready(timeout=60)
    del scenario_yaml, fixtures  # currently unused; reserved for future state hooks

    async def _agent_fn(
        conversation_history: list[Any],
        tools: list[dict[str, Any]],
    ) -> Any:
        last_user_text = ""
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
                last_user_text = str(content or "")
                break
        if not last_user_text:
            return MessageTurn(role="assistant", content="", tool_calls=None)

        context: dict[str, object] = {}
        if tools:
            context["tools"] = tools
        if system_prompt:
            context["system_prompt"] = system_prompt

        try:
            resp = bridge.send_message(last_user_text, context=context or None)
        except Exception as exc:
            logger.exception("[hermes-lifeops] send_message failed")
            raise RuntimeError("hermes LifeOps send_message failed") from exc

        raw_tool_calls = resp.params.get("tool_calls") if isinstance(resp.params, dict) else None
        tool_calls: list[dict[str, Any]] = []
        if isinstance(raw_tool_calls, list):
            for entry in raw_tool_calls:
                if not isinstance(entry, dict):
                    continue
                name = str(entry.get("name") or "")
                if not name:
                    continue
                args_raw = entry.get("arguments")
                if isinstance(args_raw, str):
                    args: object = args_raw
                elif isinstance(args_raw, dict):
                    args = dict(args_raw)
                else:
                    args = {}
                tool_calls.append(
                    {
                        "id": str(entry.get("id") or f"call_{len(tool_calls)}"),
                        "type": "function",
                        "function": {"name": name, "arguments": args},
                    }
                )

        turn = MessageTurn(
            role="assistant",
            content=resp.text,
            tool_calls=tool_calls or None,
        )
        if model_name:
            setattr(turn, "model_name", model_name)
        return turn

    return _agent_fn
