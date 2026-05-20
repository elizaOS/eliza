from __future__ import annotations

from types import SimpleNamespace

from hermes_adapter.harness_openai_proxy import HarnessOpenAIProxy


class _FakeClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []

    def send_message(self, text: str, context: dict[str, object]):
        self.calls.append((text, context))
        return SimpleNamespace(
            text="",
            params={
                "tool_calls": [
                    {
                        "function": {
                            "name": "terminal",
                            "arguments": {"cmd": "pytest -q"},
                        }
                    }
                ],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
            },
        )


def test_proxy_completion_forwards_messages_tools_and_returns_openai_shape() -> None:
    proxy = HarnessOpenAIProxy(harness="openclaw", provider="cerebras", model="m")
    proxy._client = _FakeClient()

    payload = {
        "messages": [
            {"role": "system", "content": "use tools"},
            {"role": "user", "content": "fix the repo"},
        ],
        "tools": [{"type": "function", "function": {"name": "terminal"}}],
        "tool_choice": "auto",
        "temperature": 0,
    }

    response = proxy.complete(payload)

    fake = proxy._client
    assert isinstance(fake, _FakeClient)
    assert fake.calls[0][0] == "fix the repo"
    context = fake.calls[0][1]
    assert context["harness_proxy"] == "openclaw"
    assert context["messages"] == payload["messages"]
    assert context["tools"] == payload["tools"]
    assert response["choices"][0]["finish_reason"] == "tool_calls"
    message = response["choices"][0]["message"]
    assert message["tool_calls"][0]["function"]["name"] == "terminal"
    assert message["tool_calls"][0]["function"]["arguments"] == '{"cmd": "pytest -q"}'
    assert response["usage"]["total_tokens"] == 5

