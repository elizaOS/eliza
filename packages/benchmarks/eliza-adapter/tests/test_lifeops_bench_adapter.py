"""Unit tests for the LifeOpsBench Eliza adapter.

Mocks the HTTP client (``ElizaClient``) end-to-end so the adapter can be
exercised without spawning the real TS bench server. Verifies that:

  - reset is dispatched to the lifeops_bench-specific route with the
    correct snapshot path + now_iso payload,
  - subsequent send_message calls are routed through ``lifeops_message``
    with tools threaded into context when supplied,
  - the returned ``MessageTurn`` exposes parsed ``tool_calls`` matching
    the server's response schema.

These tests do not depend on the lifeops-bench package being installable —
``MessageTurn`` is shimmed locally so the test suite runs from any
environment that has the eliza_adapter wheel.
"""

from __future__ import annotations

import asyncio
import sys
import types
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import MagicMock

import pytest


# ── Stub eliza_lifeops_bench.types so the lazy import inside the adapter
# resolves without the lifeops-bench package being installed.
@dataclass
class _StubMessageTurn:
    role: str
    content: str
    name: str | None = None
    tool_calls: list[dict[str, Any]] | None = None
    tool_call_id: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0


def _install_lifeops_stub() -> None:
    if "eliza_lifeops_bench" in sys.modules:
        return
    pkg = types.ModuleType("eliza_lifeops_bench")
    pkg.__path__ = []  # mark as a package
    sys.modules["eliza_lifeops_bench"] = pkg
    types_mod = types.ModuleType("eliza_lifeops_bench.types")
    types_mod.MessageTurn = _StubMessageTurn  # type: ignore[attr-defined]
    sys.modules["eliza_lifeops_bench.types"] = types_mod


_install_lifeops_stub()


from eliza_adapter.client import ElizaClient  # noqa: E402
from eliza_adapter.lifeops_bench import (  # noqa: E402
    build_lifeops_bench_agent_fn,
    fetch_world_state,
    teardown_lifeops_session,
)


@dataclass
class _RecordedCall:
    method: str
    path: str
    body: dict[str, Any] | None = field(default=None)


def _make_fake_client(responses: dict[str, Any]) -> tuple[ElizaClient, list[_RecordedCall]]:
    client = ElizaClient(base_url="http://test.local", token="t")
    client.wait_until_ready = MagicMock()  # type: ignore[method-assign]

    calls: list[_RecordedCall] = []

    def _post(path: str, body: dict[str, object]) -> dict[str, object]:
        calls.append(_RecordedCall(method="POST", path=path, body=dict(body)))
        return responses.get(("POST", path), {})

    def _get(path: str) -> dict[str, object]:
        calls.append(_RecordedCall(method="GET", path=path))
        return responses.get(("GET", path), {})

    client._post = _post  # type: ignore[assignment]
    client._get = _get  # type: ignore[assignment]
    return client, calls


def test_reset_routes_to_lifeops_bench_when_snapshot_provided() -> None:
    client, calls = _make_fake_client(
        {
            ("POST", "/api/benchmark/lifeops_bench/reset"): {
                "ok": True,
                "world_hash": "abc",
            },
        }
    )

    result = client.reset(
        task_id="scn-1",
        benchmark="lifeops_bench",
        world_snapshot_path="/tmp/world.json",
        now_iso="2026-05-10T12:00:00Z",
    )

    assert calls == [
        _RecordedCall(
            method="POST",
            path="/api/benchmark/lifeops_bench/reset",
            body={
                "task_id": "scn-1",
                "world_snapshot_path": "/tmp/world.json",
                "now_iso": "2026-05-10T12:00:00Z",
            },
        )
    ]
    assert result["ok"] is True


def test_reset_falls_back_to_generic_route_when_no_snapshot() -> None:
    client, calls = _make_fake_client(
        {("POST", "/api/benchmark/reset"): {"status": "ok"}}
    )
    client.reset(task_id="scn-1", benchmark="lifeops_bench")
    assert calls[0].path == "/api/benchmark/reset"


def test_lifeops_message_threads_tools_into_context() -> None:
    client, calls = _make_fake_client(
        {
            ("POST", "/api/benchmark/lifeops_bench/message"): {
                "text": "ok",
                "tool_calls": [],
                "usage": {},
            }
        }
    )
    client.lifeops_message(task_id="t", text="hi", tools=[{"name": "calendar.create_event"}])
    body = calls[0].body or {}
    assert body["task_id"] == "t"
    assert body["text"] == "hi"
    assert body["context"] == {"tools": [{"name": "calendar.create_event"}]}


def test_lifeops_message_omits_context_when_no_tools() -> None:
    client, calls = _make_fake_client(
        {("POST", "/api/benchmark/lifeops_bench/message"): {"text": "", "tool_calls": []}}
    )
    client.lifeops_message(task_id="t", text="hi")
    body = calls[0].body or {}
    assert "context" not in body


def test_world_state_and_teardown_use_correct_routes() -> None:
    client, calls = _make_fake_client(
        {
            ("GET", "/api/benchmark/lifeops_bench/scn-2/world_state"): {
                "ok": True,
                "world_hash": "h",
                "world": {},
            },
            ("POST", "/api/benchmark/lifeops_bench/teardown"): {"ok": True, "removed": True},
        }
    )
    state = fetch_world_state(client, "scn-2")
    assert state["world_hash"] == "h"
    teardown_lifeops_session(client, "scn-2")
    assert calls[-1].path == "/api/benchmark/lifeops_bench/teardown"
    assert calls[-1].body == {"task_id": "scn-2"}


def test_agent_fn_resets_on_first_call_and_messages_thereafter() -> None:
    client, calls = _make_fake_client(
        {
            ("POST", "/api/benchmark/lifeops_bench/reset"): {"ok": True, "world_hash": "h"},
            ("POST", "/api/benchmark/lifeops_bench/message"): {
                "text": "scheduled it",
                "tool_calls": [
                    {
                        "id": "c1",
                        "name": "calendar.create_event",
                        "arguments": {"calendar_id": "cal_primary", "title": "deep work"},
                        "ok": True,
                        "result": {"id": "ev_x"},
                    }
                ],
                "usage": {"promptTokens": 12, "completionTokens": 5, "totalTokens": 17},
            },
        }
    )

    agent_fn = build_lifeops_bench_agent_fn(
        client=client,
        world_snapshot_path="/tmp/world.json",
        now_iso="2026-05-10T12:00:00Z",
    )

    history: list[Any] = [
        _StubMessageTurn(role="user", content="schedule a focus block at 10am"),
    ]
    turn = asyncio.run(agent_fn(history, []))

    # First call should hit reset, then message — verify ordering and bodies.
    paths = [c.path for c in calls]
    assert paths == [
        "/api/benchmark/lifeops_bench/reset",
        "/api/benchmark/lifeops_bench/message",
    ]
    reset_body = calls[0].body or {}
    assert reset_body["task_id"]
    assert reset_body["world_snapshot_path"] == "/tmp/world.json"
    assert reset_body["now_iso"] == "2026-05-10T12:00:00Z"

    message_body = calls[1].body or {}
    assert message_body["text"] == "schedule a focus block at 10am"

    # Returned MessageTurn carries text + parsed tool_calls.
    assert turn.role == "assistant"
    assert turn.content == "scheduled it"
    assert turn.tool_calls is not None
    assert len(turn.tool_calls) == 1
    call = turn.tool_calls[0]
    assert call["function"]["name"] == "calendar.create_event"
    assert call["function"]["arguments"] == {
        "calendar_id": "cal_primary",
        "title": "deep work",
    }
    assert call["_executed"]["ok"] is True

    # Second call (same conversation) should NOT re-reset.
    history.append(turn)
    history.append(_StubMessageTurn(role="user", content="thanks"))
    asyncio.run(agent_fn(history, []))
    second_paths = [c.path for c in calls]
    assert second_paths.count("/api/benchmark/lifeops_bench/reset") == 1
    assert second_paths[-1] == "/api/benchmark/lifeops_bench/message"


def test_agent_fn_handles_no_user_message_safely() -> None:
    client, _ = _make_fake_client({})
    agent_fn = build_lifeops_bench_agent_fn(
        client=client,
        world_snapshot_path="/tmp/world.json",
    )
    turn = asyncio.run(agent_fn([], []))
    assert turn.role == "assistant"
    assert turn.content == ""
    assert turn.tool_calls is None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
