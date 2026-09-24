from __future__ import annotations

import asyncio

from eliza_adapter.client import MessageResponse
from eliza_adapter.woobench import (
    _WOOBENCH_SYSTEM_HINT,
    _with_inferred_payment_action,
    build_eliza_bridge_agent_fn,
)


class _FakeClient:
    def __init__(self) -> None:
        self.reset_task_ids: list[str] = []

    def wait_until_ready(self, timeout: float = 120.0, poll: float = 1.0) -> None:
        return None

    def reset(self, *, task_id: str, benchmark: str) -> dict[str, object]:
        self.reset_task_ids.append(task_id)
        return {"ok": True, "benchmark": benchmark}

    def send_message(self, text: str, context: dict[str, object]) -> MessageResponse:
        self.last_context = context
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


def test_woobench_adapter_forwards_system_message_and_payment_actions() -> None:
    client = _FakeClient()
    agent_fn = build_eliza_bridge_agent_fn(client=client, model_name="test-model")

    asyncio.run(agent_fn([{"role": "user", "content": "read my cards"}]))

    context = client.last_context
    assert context["system_prompt"] == _WOOBENCH_SYSTEM_HINT
    assert context["messages"] == [{"role": "user", "content": "read my cards"}]
    assert context["payment_actions"]["create"]["command"] == "CREATE_APP_CHARGE"
    assert context["payment_actions"]["check"]["command"] == "CHECK_PAYMENT"
    assert context["tools"][0]["function"]["name"] == "CREATE_APP_CHARGE"


def test_woobench_adapter_synthesizes_visible_payment_text() -> None:
    class _PaymentClient(_FakeClient):
        def send_message(self, text: str, context: dict[str, object]) -> MessageResponse:
            self.last_context = context
            return MessageResponse(
                text="",
                thought=None,
                actions=["BENCHMARK_ACTION"],
                params={
                    "tool_calls": [
                        {
                            "type": "function",
                            "function": {
                                "name": "CREATE_APP_CHARGE",
                                "arguments": '{"amount_usd": 10, "provider": "oxapay"}',
                            },
                        }
                    ]
                },
                metadata={},
            )

    client = _PaymentClient()
    agent_fn = build_eliza_bridge_agent_fn(client=client)

    result = asyncio.run(agent_fn([{"role": "user", "content": "read my cards"}]))

    assert "full reading after $10.00" in result.text
    assert result.actions == ["BENCHMARK_ACTION"]


def test_woobench_adapter_infers_payment_action_from_visible_charge_text() -> None:
    response = MessageResponse(
        text="I can continue once the $15 payment is created.",
        thought=None,
        actions=[],
        params={},
        metadata={},
    )

    result = _with_inferred_payment_action(response)

    assert result.actions == ["BENCHMARK_ACTION"]
    assert result.params["BENCHMARK_ACTION"]["command"] == "CREATE_APP_CHARGE"
    assert result.params["BENCHMARK_ACTION"]["amount_usd"] == 15.0


def test_woobench_adapter_removes_payment_tools_after_payment_check() -> None:
    class _StateClient(_FakeClient):
        def __init__(self) -> None:
            super().__init__()
            self.contexts: list[dict[str, object]] = []
            self.calls = 0

        def send_message(self, text: str, context: dict[str, object]) -> MessageResponse:
            self.contexts.append(context)
            self.calls += 1
            if self.calls == 1:
                params = {"BENCHMARK_ACTION": {"command": "CREATE_APP_CHARGE", "amount_usd": 10}}
            elif self.calls == 2:
                params = {"BENCHMARK_ACTION": {"command": "CHECK_PAYMENT"}}
            else:
                params = {}
            return MessageResponse(
                text="ok",
                thought=None,
                actions=["BENCHMARK_ACTION"] if params else [],
                params=params,
                metadata={},
            )

    client = _StateClient()
    agent_fn = build_eliza_bridge_agent_fn(client=client)
    history = [{"role": "user", "content": "read my cards"}]

    asyncio.run(agent_fn(history))
    history.extend([{"role": "assistant", "content": "ok"}, {"role": "user", "content": "paid"}])
    asyncio.run(agent_fn(history))
    history.extend([{"role": "assistant", "content": "ok"}, {"role": "user", "content": "continue"}])
    asyncio.run(agent_fn(history))

    assert [tool["function"]["name"] for tool in client.contexts[1]["tools"]] == ["CHECK_PAYMENT"]
    assert client.contexts[2]["tools"] == []
    assert client.contexts[2]["tool_choice"] == "none"
    assert "already been paid and verified" in client.contexts[2]["system_prompt"]
