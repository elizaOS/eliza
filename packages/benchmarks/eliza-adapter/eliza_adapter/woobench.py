"""WooBench agent_fn backed by the eliza benchmark server.

WooBench's runner expects an async callable with signature
``Callable[[list[dict[str, str]]], str]`` — the agent receives the full
conversation history and returns its next reply.

This adapter routes each turn through the elizaOS TS benchmark server
via ``ElizaClient.send_message`` instead of binding a Python AgentRuntime.
The bridge handles state composition, providers, and model dispatch.
"""

from __future__ import annotations

import logging
import uuid
from typing import Awaitable, Callable

from eliza_adapter.client import ElizaClient

logger = logging.getLogger(__name__)


_WOOBENCH_SYSTEM_HINT = (
    "You are a mystical reading agent providing personalized divination "
    "readings (tarot, I Ching, astrology). Listen carefully, respond "
    "thoughtfully with empathetic intuitive insight, and build rapport. "
    "Reply directly to the user's most recent message."
)


def build_eliza_bridge_agent_fn(
    client: ElizaClient | None = None,
    *,
    benchmark: str = "woobench",
    model_name: str | None = None,
) -> Callable[[list[dict[str, str]]], Awaitable[str]]:
    """Create a WooBench-compatible ``agent_fn`` backed by the eliza TS bridge.

    Each invocation reads the latest user turn out of the conversation
    history and forwards it to the bridge with the recent history attached
    as context. The bridge's response text is returned verbatim.

    A unique ``task_id`` is generated per conversation object, so concurrent
    scenario runs keep separate bridge state while repeated turns within one
    conversation stay stateful.
    """
    bridge = client or ElizaClient()
    task_ids_by_conversation: dict[int, str] = {}

    bridge.wait_until_ready(timeout=120)

    async def _agent_fn(conversation_history: list[dict[str, str]]) -> str:
        conversation_key = id(conversation_history)
        task_id = task_ids_by_conversation.get(conversation_key)
        if task_id is None:
            task_id = f"woobench-{uuid.uuid4().hex[:12]}"
            task_ids_by_conversation[conversation_key] = task_id
            try:
                bridge.reset(task_id=task_id, benchmark=benchmark)
            except Exception as exc:
                logger.debug("[eliza-woo] reset failed (continuing): %s", exc)

        last_user = ""
        for turn in reversed(conversation_history):
            if turn.get("role") == "user":
                last_user = str(turn.get("content", ""))
                break
        if not last_user:
            return ""

        recent_history = [
            {"role": str(t.get("role", "")), "content": str(t.get("content", ""))}
            for t in conversation_history[-10:]
        ]

        try:
            response = bridge.send_message(
                text=last_user,
                context={
                    "benchmark": benchmark,
                    "task_id": task_id,
                    "model_name": model_name,
                    "system_hint": _WOOBENCH_SYSTEM_HINT,
                    "history": recent_history,
                },
            )
        except Exception as exc:
            logger.exception("[eliza-woo] bridge call failed")
            raise RuntimeError("Eliza WooBench bridge call failed") from exc

        return response.text or ""

    return _agent_fn
