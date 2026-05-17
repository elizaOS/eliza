from __future__ import annotations

import asyncio

from eliza_adapter.client import MessageResponse
from eliza_adapter.vending_bench import ElizaVendingProvider


class _FakeClient:
    def __init__(self, response: MessageResponse | None = None) -> None:
        self.reset_task_ids: list[str] = []
        self.contexts: list[dict[str, object]] = []
        self.response = response

    def wait_until_ready(self, timeout: float = 120.0, poll: float = 1.0) -> None:
        return None

    def reset(self, *, task_id: str, benchmark: str) -> dict[str, object]:
        self.reset_task_ids.append(task_id)
        return {"ok": True, "benchmark": benchmark}

    def send_message(self, text: str, context: dict[str, object]) -> MessageResponse:
        self.contexts.append(context)
        if self.response is not None:
            return self.response
        return MessageResponse(
            text='{"action":"VIEW_BUSINESS_STATE"}',
            thought=None,
            actions=[],
            params={},
            metadata={},
        )


def test_vending_provider_sends_to_the_per_turn_reset_session() -> None:
    client = _FakeClient()
    provider = ElizaVendingProvider(client=client)

    response, _tokens = asyncio.run(provider.generate("", "What next?"))

    assert response == '{"action": "VIEW_BUSINESS_STATE"}'
    assert client.reset_task_ids
    assert client.contexts[0]["task_id"] == client.reset_task_ids[-1]
    assert client.contexts[0]["benchmark"] == "vending-bench"


def test_vending_provider_normalizes_bare_tool_json() -> None:
    client = _FakeClient(
        MessageResponse(
            text='{"name":"PLACE_ORDER","arguments":{"supplier_id":"beverage_dist","items":{"water":12}}}',
            thought=None,
            actions=[],
            params={},
            metadata={},
        )
    )
    provider = ElizaVendingProvider(client=client)

    response, _tokens = asyncio.run(provider.generate("", "What next?"))

    assert response == '{"supplier_id": "beverage_dist", "items": {"water": 12}, "action": "PLACE_ORDER"}'


def test_vending_provider_does_not_synthesize_profitable_fallback() -> None:
    client = _FakeClient(
        MessageResponse(
            text="I am not sure.",
            thought=None,
            actions=[],
            params={},
            metadata={},
        )
    )
    provider = ElizaVendingProvider(client=client)

    response, _tokens = asyncio.run(provider.generate("", "What next?"))

    assert response == "I am not sure."
