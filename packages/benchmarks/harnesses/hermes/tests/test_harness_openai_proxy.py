from __future__ import annotations

import sys
import types
from types import SimpleNamespace

from hermes_adapter import harness_openai_proxy
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


def test_openclaw_proxy_factory_keeps_native_transport(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class FakeOpenClawClient:
        def __init__(self, **kwargs: object) -> None:
            captured.update(kwargs)

    package = types.ModuleType("openclaw_adapter")
    client_module = types.ModuleType("openclaw_adapter.client")
    client_module.OpenClawClient = FakeOpenClawClient
    monkeypatch.setitem(sys.modules, "openclaw_adapter", package)
    monkeypatch.setitem(sys.modules, "openclaw_adapter.client", client_module)

    client, server = harness_openai_proxy._build_client(
        harness="openclaw",
        provider="claude-subscription",
        model="claude-opus-4-6",
        upstream_base_url="http://127.0.0.1:43123/v1",
    )

    assert isinstance(client, FakeOpenClawClient)
    assert server is None
    assert captured == {
        "provider": "claude-subscription",
        "model": "claude-opus-4-6",
        "base_url": "http://127.0.0.1:43123/v1",
    }


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
    # The proxy speaks single-step chat-completions: the env executes the
    # returned tool_calls itself, so OpenClaw turns must stop after the first
    # captured batch instead of looping on placeholder acknowledgements.
    assert context["capture_stop"] is True
    assert response["choices"][0]["finish_reason"] == "tool_calls"
    message = response["choices"][0]["message"]
    assert message["tool_calls"][0]["function"]["name"] == "terminal"
    assert message["tool_calls"][0]["function"]["arguments"] == '{"cmd": "pytest -q"}'
    assert response["usage"]["total_tokens"] == 5


def test_proxy_declares_env_owned_contract_for_hermes() -> None:
    proxy = HarnessOpenAIProxy(harness="hermes", provider="cerebras", model="m")
    proxy._client = _FakeClient()

    proxy.complete(
        {
            "messages": [{"role": "user", "content": "fix the repo"}],
            "tools": [{"type": "function", "function": {"name": "terminal"}}],
        }
    )

    assert proxy._client.calls[0][1]["capture_stop"] is True


def test_proxy_env_owned_contract_never_reaches_eliza() -> None:
    """Eliza owns a real server-side action loop, not a capture bridge — the
    ``capture_stop`` key must never leak into its context."""
    proxy = HarnessOpenAIProxy(harness="eliza", provider="cerebras", model="m")
    proxy._client = _FakeClient()

    proxy.complete(
        {
            "messages": [{"role": "user", "content": "fix the repo"}],
            "tools": [{"type": "function", "function": {"name": "terminal"}}],
        }
    )

    assert "capture_stop" not in proxy._client.calls[0][1]
