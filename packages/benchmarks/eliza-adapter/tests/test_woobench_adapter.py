from __future__ import annotations

import asyncio

from eliza_adapter.client import MessageResponse
from eliza_adapter.woobench import build_eliza_bridge_agent_fn


class _FakeClient:
    def __init__(self) -> None:
        self.reset_task_ids: list[str] = []

    def wait_until_ready(self, timeout: float = 120.0, poll: float = 1.0) -> None:
        return None

    def reset(self, *, task_id: str, benchmark: str) -> dict[str, object]:
        self.reset_task_ids.append(task_id)
        return {"ok": True, "benchmark": benchmark}

    def send_message(self, text: str, context: dict[str, object]) -> MessageResponse:
        return MessageResponse(
            text=f"reply to {text}",
            thought=None,
            actions=[],
            params={"task_id": context.get("task_id")},
            metadata={},
        )


def test_woobench_adapter_resets_when_conversation_object_is_reused() -> None:
    client = _FakeClient()
    agent_fn = build_eliza_bridge_agent_fn(client=client, model_name="test-model")

    history = [{"role": "user", "content": "first scenario"}]
    asyncio.run(agent_fn(history))
    history.extend(
        [
            {"role": "assistant", "content": "reply"},
            {"role": "user", "content": "same scenario follow-up"},
        ]
    )
    asyncio.run(agent_fn(history))

    assert len(client.reset_task_ids) == 1

    # Simulate Python reusing a list object/id for the next scenario. The
    # adapter must treat a fresh one-user-turn history as a new bridge session.
    history.clear()
    history.append({"role": "user", "content": "second scenario"})
    asyncio.run(agent_fn(history))

    assert len(client.reset_task_ids) == 2
    assert client.reset_task_ids[0] != client.reset_task_ids[1]
