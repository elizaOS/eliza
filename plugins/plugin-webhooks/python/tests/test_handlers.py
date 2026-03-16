"""Tests for elizaos_plugin_webhooks.handlers."""

from __future__ import annotations

import pytest

from elizaos_plugin_webhooks.handlers import (
    handle_agent,
    handle_mapped,
    handle_wake,
)


@pytest.fixture()
def runtime(make_runtime):
    """A pre-configured runtime with hooks enabled."""
    return make_runtime(
        token="test-secret",
        mappings=[
            {
                "match": {"path": "github"},
                "action": "wake",
                "name": "GitHub",
                "textTemplate": "Event: {{action}}",
                "wakeMode": "now",
            },
            {
                "match": {"path": "gmail"},
                "action": "agent",
                "name": "Gmail",
                "messageTemplate": "Email from {{from}}: {{subject}}",
                "sessionKey": "hook:gmail:{{id}}",
                "deliver": True,
                "channel": "last",
            },
        ],
    )


AUTH_HEADERS = {"authorization": "Bearer test-secret"}


# ── handle_wake ────────────────────────────────────────────────────────────


class TestHandleWake:
    @pytest.mark.asyncio
    async def test_returns_404_when_hooks_disabled(self, make_runtime) -> None:
        rt = make_runtime(enabled=False)
        resp = await handle_wake(rt, headers=AUTH_HEADERS, body={"text": "hi"})
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_returns_401_on_bad_token(self, runtime) -> None:
        resp = await handle_wake(
            runtime,
            headers={"authorization": "Bearer wrong"},
            body={"text": "hi"},
        )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_returns_400_when_text_missing(self, runtime) -> None:
        resp = await handle_wake(runtime, headers=AUTH_HEADERS, body={})
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_returns_400_when_text_empty(self, runtime) -> None:
        resp = await handle_wake(
            runtime, headers=AUTH_HEADERS, body={"text": "   "}
        )
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_success_now_mode(self, runtime) -> None:
        resp = await handle_wake(
            runtime, headers=AUTH_HEADERS, body={"text": "Hello"}
        )
        assert resp.status_code == 200
        assert resp.body == {"ok": True}
        # Should emit both system event and wake
        assert runtime.emit_event.call_count == 2

    @pytest.mark.asyncio
    async def test_success_next_heartbeat_mode(self, runtime) -> None:
        resp = await handle_wake(
            runtime,
            headers=AUTH_HEADERS,
            body={"text": "Hello", "mode": "next-heartbeat"},
        )
        assert resp.status_code == 200
        # Should emit only system event (no wake)
        assert runtime.emit_event.call_count == 1
        call_args = runtime.emit_event.call_args_list[0]
        assert call_args[0][0] == "HEARTBEAT_SYSTEM_EVENT"


# ── handle_agent ───────────────────────────────────────────────────────────


class TestHandleAgent:
    @pytest.mark.asyncio
    async def test_returns_404_when_hooks_disabled(self, make_runtime) -> None:
        rt = make_runtime(enabled=False)
        resp = await handle_agent(
            rt, headers=AUTH_HEADERS, body={"message": "hi"}
        )
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_returns_401_on_bad_token(self, runtime) -> None:
        resp = await handle_agent(
            runtime,
            headers={"authorization": "Bearer wrong"},
            body={"message": "hi"},
        )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_returns_400_when_message_missing(self, runtime) -> None:
        resp = await handle_agent(runtime, headers=AUTH_HEADERS, body={})
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_returns_202_on_success(self, runtime) -> None:
        resp = await handle_agent(
            runtime,
            headers=AUTH_HEADERS,
            body={"message": "Process this", "name": "Test"},
        )
        assert resp.status_code == 202
        assert resp.body["ok"] is True
        assert "sessionKey" in resp.body

    @pytest.mark.asyncio
    async def test_uses_provided_session_key(self, runtime) -> None:
        resp = await handle_agent(
            runtime,
            headers=AUTH_HEADERS,
            body={"message": "hi", "sessionKey": "my-session"},
        )
        assert resp.body["sessionKey"] == "my-session"


# ── handle_mapped ──────────────────────────────────────────────────────────


class TestHandleMapped:
    @pytest.mark.asyncio
    async def test_returns_404_when_hooks_disabled(self, make_runtime) -> None:
        rt = make_runtime(enabled=False)
        resp = await handle_mapped(
            rt, headers=AUTH_HEADERS, body={}, hook_name="github"
        )
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_returns_401_on_bad_token(self, runtime) -> None:
        resp = await handle_mapped(
            runtime,
            headers={"authorization": "Bearer wrong"},
            body={},
            hook_name="github",
        )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_returns_400_when_hook_name_missing(self, runtime) -> None:
        resp = await handle_mapped(
            runtime, headers=AUTH_HEADERS, body={}, hook_name=""
        )
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_returns_404_when_no_mapping(self, runtime) -> None:
        resp = await handle_mapped(
            runtime, headers=AUTH_HEADERS, body={}, hook_name="unknown"
        )
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_wake_mapping_returns_200(self, runtime) -> None:
        resp = await handle_mapped(
            runtime,
            headers=AUTH_HEADERS,
            body={"action": "push"},
            hook_name="github",
        )
        assert resp.status_code == 200
        assert resp.body == {"ok": True}

    @pytest.mark.asyncio
    async def test_agent_mapping_returns_202(self, runtime) -> None:
        resp = await handle_mapped(
            runtime,
            headers=AUTH_HEADERS,
            body={"from": "Alice", "subject": "Hi", "id": "msg-1"},
            hook_name="gmail",
        )
        assert resp.status_code == 202
        assert resp.body == {"ok": True}

    @pytest.mark.asyncio
    async def test_returns_404_when_config_missing_token(
        self, make_runtime
    ) -> None:
        rt = make_runtime(token="")
        resp = await handle_mapped(
            rt, headers=AUTH_HEADERS, body={}, hook_name="github"
        )
        assert resp.status_code == 404
